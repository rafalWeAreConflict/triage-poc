"""Copilot tools for the resident ticket triage domain (``triage`` app).

Same shape as the tools in ``copilot.agent``: a sync implementation (ORM work, permission check
first, results — never exceptions — for anything the agent should explain) wrapped by an async
AG-UI-facing function. External identifiers only: unit/ticket/photo ``guid``, category ``code``,
contractor ``slug``.

The triage flow the system prompt drives:

    find_units → list_categories → list_contractors(category)
        → propose_triage   (FRONTEND HITL tool: the admin approves or corrects the proposal card)
        → create_ticket(confirmed=true, proposal=..., final=..., admin_comment=...)

``create_ticket`` is the consequential mutation, so it keeps the platform's HITL invariant: called
without ``confirmed=true`` it returns ``confirmation_required`` and writes nothing.
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal, Optional

from asgiref.sync import sync_to_async
from config.roles_gen import P
from copilot.agent import CopilotDeps, _denied
from copilot.approvals import HumanApprovals
from copilot.triage_state import apply_ticket_created_sync, snapshot_event
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from pydantic import BaseModel, Field
from pydantic_ai import RunContext, ToolReturn
from triage.models import Category, Contractor, Ticket, TicketPhoto, TicketPriority, TicketStatus, Unit

PriorityCode = Literal['low', 'normal', 'high', 'urgent']

MAX_TICKETS = 50
TRIAGE_FIELDS = (('category', 'category_code'), ('priority', 'priority'), ('contractor', 'contractor_slug'))


class TriageDecision(BaseModel):
    """Category, priority and contractor of a ticket (the admin-approved final values)."""

    category_code: str = Field(description='Category code from list_categories, e.g. "plumbing".')
    priority: PriorityCode = Field(description='low / normal / high / urgent.')
    contractor_slug: str = Field(description='Contractor slug from list_contractors, e.g. "flowfix-plumbing".')


class TriageProposal(TriageDecision):
    """The AI proposal as shown on the propose_triage card, plus the reasoning behind it."""

    reasoning: str = Field(default='', description='Brief reasoning shown to the admin.')


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _unit_label(unit: Unit) -> str:
    return unit.number


def _unit_row(unit: Unit) -> dict[str, Any]:
    return {
        'guid': str(unit.guid),
        'label': _unit_label(unit),
        'building': unit.building.name,
        'building_address': unit.building.address,
    }


def _normalise_unit_number(query: str) -> Optional[str]:
    """"b3", "B 3", "b-3", "flat B/3" → "B/3"; ``None`` when the query is not a unit number."""
    match = re.search(r'\b([A-Za-z])\s*[/\-\s]?\s*(\d+)\b', query)
    return f'{match.group(1).upper()}/{match.group(2)}' if match else None


def _validate_decision(decision: TriageDecision) -> tuple[Optional[dict], Optional[dict[str, Any]]]:
    """Resolve codes/slugs to objects, or return a tool error result."""
    category = Category.objects.filter(code=decision.category_code, deleted_at__isnull=True).first()
    if category is None:
        return None, {'status': 'error', 'message': f'Unknown category code "{decision.category_code}". Use list_categories.'}
    if decision.priority not in TicketPriority.values:
        return None, {'status': 'error', 'message': f'Unknown priority "{decision.priority}".'}
    contractor = Contractor.objects.select_related('category').filter(
        slug=decision.contractor_slug, deleted_at__isnull=True).first()
    if contractor is None:
        return None, {'status': 'error', 'message': f'Unknown contractor "{decision.contractor_slug}". Use list_contractors.'}
    if contractor.category_id != category.pk:
        return None, {
            'status': 'error',
            'message': (f'Contractor "{contractor.slug}" handles "{contractor.category.code}", not '
                        f'"{category.code}". Pick a contractor from list_contractors("{category.code}").'),
        }
    return {'category': category, 'priority': decision.priority, 'contractor': contractor}, None


def _changed_fields(proposal: TriageProposal, final: TriageDecision) -> dict[str, dict[str, str]]:
    changed = {}
    for field, attr in TRIAGE_FIELDS:
        before, after = getattr(proposal, attr), getattr(final, attr)
        if before != after:
            changed[field] = {'from': before, 'to': after}
    return changed


# ---------------------------------------------------------------------------
# synchronous implementations (run inside sync_to_async)
# ---------------------------------------------------------------------------

def _list_categories_sync(user) -> dict[str, Any]:
    if not P.CATEGORY_VIEW.check(user, raised_error=False):
        return _denied('view triage categories')
    return {
        'status': 'ok',
        'categories': [
            {'code': c.code, 'name': c.name, 'description': c.description or ''}
            for c in Category.objects.filter(deleted_at__isnull=True).order_by('code')
        ],
    }


def _list_contractors_sync(user, category_code: Optional[str]) -> dict[str, Any]:
    if not P.CONTRACTOR_VIEW.check(user, raised_error=False):
        return _denied('view contractors')
    qs = Contractor.objects.select_related('category').filter(deleted_at__isnull=True)
    if category_code:
        if not Category.objects.filter(code=category_code, deleted_at__isnull=True).exists():
            return {'status': 'error', 'message': f'Unknown category code "{category_code}". Use list_categories.'}
        qs = qs.filter(category__code=category_code)
    return {
        'status': 'ok',
        'contractors': [
            {'slug': c.slug, 'name': c.name, 'category_code': c.category.code, 'phone': c.phone, 'email': c.email}
            for c in qs.order_by('name')
        ],
    }


def _find_units_sync(user, query: Optional[str]) -> dict[str, Any]:
    if not P.UNIT_VIEW.check(user, raised_error=False):
        return _denied('view units')
    qs = Unit.objects.select_related('building').filter(deleted_at__isnull=True, building__deleted_at__isnull=True)
    query = (query or '').strip()
    if query:
        number = _normalise_unit_number(query)
        exact = qs.filter(number__iexact=number) if number else qs.none()
        if exact.exists():
            qs = exact
        else:
            cond = Q(number__icontains=query) | Q(building__name__icontains=query) | Q(building__address__icontains=query)
            # "stairwell B" / "Building A": a lone letter selects that building's units (A/1, A/2 ...)
            for letter in re.findall(r'\b([A-Za-z])\b', query):
                cond |= Q(number__istartswith=f'{letter}/')
            qs = qs.filter(cond)
    units = list(qs.order_by('building__name', 'number')[:50])
    return {'status': 'ok', 'units': [_unit_row(u) for u in units]}


def _list_tickets_sync(user, status: Optional[str], limit: int) -> dict[str, Any]:
    if not P.TICKET_VIEW.check(user, raised_error=False):
        return _denied('view tickets')
    qs = Ticket.objects.select_related('unit', 'category', 'contractor').filter(deleted_at__isnull=True)
    if status:
        if status not in TicketStatus.values:
            return {'status': 'error', 'message': f'Unknown status "{status}". Use one of: {", ".join(TicketStatus.values)}.'}
        qs = qs.filter(status=status)
    limit = max(1, min(int(limit or 10), MAX_TICKETS))
    return {
        'status': 'ok',
        'tickets': [
            {
                'guid': str(t.guid),
                'unit': _unit_label(t.unit),
                'reporter_name': t.reporter_name,
                'description': t.description if len(t.description) <= 160 else t.description[:157] + '...',
                'category_code': t.category.code if t.category else None,
                'priority': t.priority,
                'contractor_slug': t.contractor.slug if t.contractor else None,
                'status': t.status,
                'was_corrected': bool(t.admin_correction),
                'created_at': t.created_at.isoformat(),
            }
            for t in qs.order_by('-created_at')[:limit]
        ],
    }


def _create_ticket_sync(user, approvals: HumanApprovals, unit_guid: str, reporter_name: str, description: str, proposal: TriageProposal,
                        final: TriageDecision, admin_comment: Optional[str], photo_guid: Optional[str],
                        confirmed: bool) -> dict[str, Any]:
    if not P.TICKET_ADD.check(user, raised_error=False):
        return _denied('create tickets')

    unit = Unit.objects.select_related('building').filter(guid=unit_guid, deleted_at__isnull=True).first() \
        if _is_uuid(unit_guid) else None
    if unit is None:
        return {'status': 'not_found', 'message': 'Unit not found. Use the guid returned by find_units.'}
    if not (reporter_name or '').strip() or not (description or '').strip():
        return {'status': 'error', 'message': 'reporter_name and description are required.'}

    for decision in (proposal, final):
        _, error = _validate_decision(decision)
        if error:
            return error
    resolved, _ = _validate_decision(final)

    photo = None
    if photo_guid:
        photo = TicketPhoto.objects.filter(guid=photo_guid, created_by=user, deleted_at__isnull=True).first() \
            if _is_uuid(photo_guid) else None
        if photo is None:
            return {'status': 'not_found', 'message': 'Photo not found. Use the photo_guid noted next to the attached image.'}

    changed = _changed_fields(proposal, final)
    comment = (admin_comment or '').strip()
    if changed and not comment:
        return {'status': 'error', 'message': 'The admin changed the proposal; admin_comment (their reason) is required.'}

    if not confirmed:
        return {
            'status': 'confirmation_required',
            'message': ('Nothing was created. Show the proposal with propose_triage and wait for the admin; '
                        'only after they approve or correct it call create_ticket again with confirmed=true '
                        'and the final values.'),
            'unit': _unit_label(unit),
            'final': final.model_dump(),
            'changed_fields': changed,
        }

    # confirmed=true is the model's claim; the admin's click on the propose_triage card is the proof.
    approval = approvals.triage_for(unit_guid, photo_guid, proposal.model_dump(), final.model_dump())
    if approval is None:
        return {
            'status': 'confirmation_required',
            'message': ('Nothing was created: no unused admin decision on a propose_triage card matches this '
                        'ticket (unit, photo, proposal and final values). Call propose_triage, wait for the '
                        "admin, then call create_ticket with confirmed=true and exactly the decision's values."),
        }
    if approval.comment:
        comment = approval.comment  # the admin's own words, not the model's paraphrase

    correction = {}
    if changed or comment:
        correction = {
            'changed_fields': changed,
            'comment': comment,
            'corrected_by': user.get_username(),
            'corrected_at': timezone.now().isoformat(),
        }

    with transaction.atomic():
        ticket = Ticket(
            unit=unit,
            reporter_name=reporter_name.strip(),
            description=description.strip(),
            category=resolved['category'],
            priority=resolved['priority'],
            contractor=resolved['contractor'],
            ai_suggestion={
                'category': proposal.category_code,
                'priority': proposal.priority,
                'contractor': proposal.contractor_slug,
                'reasoning': proposal.reasoning,
            },
            admin_correction=correction,
            created_by=user,
            updated_by=user,
        )
        if photo is not None:
            ticket.photo = photo.image.name  # same stored object, no copy
        ticket.save()
        try:
            ticket.transition('propose', user, f'AI proposal: {proposal.category_code} / {proposal.priority} / '
                                               f'{proposal.contractor_slug}')
        except (PermissionDenied, ValidationError) as exc:
            transaction.set_rollback(True)
            return {'status': 'permission_denied' if isinstance(exc, PermissionDenied) else 'error',
                    'message': f'Ticket not created: {_exc_message(exc)}'}

        approve_note = 'Approved by admin as proposed'
        if changed:
            diffs = ', '.join(f'{f} {d["from"]} → {d["to"]}' for f, d in changed.items())
            approve_note = f'Approved with admin correction: {diffs}. Reason: {comment}'
        elif comment:
            approve_note = f'Approved by admin. Comment: {comment}'

        approved, approve_error = False, None
        try:
            with transaction.atomic():
                ticket.transition('approve', user, approve_note)
            approved = True
        except (PermissionDenied, ValidationError) as exc:
            approve_error = _exc_message(exc)

    approvals.use(approval)
    ticket.refresh_from_db()
    result = {
        'status': 'ok',
        'ticket_guid': str(ticket.guid),
        'state': ticket.status,
        'unit': _unit_label(unit),
        'category_code': final.category_code,
        'priority': final.priority,
        'contractor_slug': final.contractor_slug,
        'was_corrected': bool(changed),
        'has_photo': photo is not None,
    }
    if not approved:
        result['message'] = (f'Ticket created but left in "{ticket.status}": you cannot approve tickets '
                             f'({approve_error}). A Triage Admin must approve it.')
    return result


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


def _exc_message(exc: Exception) -> str:
    return '; '.join(getattr(exc, 'messages', None) or [str(exc)])


# ---------------------------------------------------------------------------
# Tools (async, AG-UI facing)
# ---------------------------------------------------------------------------

async def list_categories(ctx: RunContext[CopilotDeps]) -> dict[str, Any]:
    """List the maintenance-ticket categories: code, display name and what each covers.

    Requires the category view permission.
    """
    return await sync_to_async(_list_categories_sync, thread_sensitive=True)(ctx.deps.user)


async def list_contractors(ctx: RunContext[CopilotDeps], category_code: Optional[str] = None) -> dict[str, Any]:
    """List contractors (slug, name, category_code, phone, email), optionally only those of one category code.

    Requires the contractor view permission.
    """
    return await sync_to_async(_list_contractors_sync, thread_sensitive=True)(ctx.deps.user, category_code)


async def find_units(ctx: RunContext[CopilotDeps], query: Optional[str] = None) -> dict[str, Any]:
    """Find apartment units (flats) by number or building, e.g. "B/3", "flat A/4", "stairwell B", "Building A".

    Returns each unit's guid, label (e.g. "A/4") and building. Omit ``query`` to list all units.
    Requires the unit view permission.
    """
    return await sync_to_async(_find_units_sync, thread_sensitive=True)(ctx.deps.user, query)


async def list_tickets(ctx: RunContext[CopilotDeps], status: Optional[str] = None, limit: int = 10) -> dict[str, Any]:
    """List recent maintenance tickets, newest first, optionally filtered by status.

    ``status`` is one of new / proposed / approved / assigned / closed; ``limit`` is 1-50 (default 10).
    Requires the ticket view permission.
    """
    return await sync_to_async(_list_tickets_sync, thread_sensitive=True)(ctx.deps.user, status, limit)


def _create_ticket_with_state_sync(state: dict[str, Any], user, *args) -> dict[str, Any] | ToolReturn:
    result = _create_ticket_sync(user, *args)
    if result.get('status') != 'ok':
        return result
    # Shared state: refresh the ticket list, clear the draft and push a STATE_SNAPSHOT right after the
    # tool result (Pydantic AI's AG-UI stream emits BaseEvent metadata of a ToolReturn).
    apply_ticket_created_sync(state, user, result['ticket_guid'])
    return ToolReturn(return_value=result, metadata=[snapshot_event(state)])


async def create_ticket(ctx: RunContext[CopilotDeps], unit_guid: str, reporter_name: str, description: str,
                        proposal: TriageProposal, final: TriageDecision, admin_comment: Optional[str] = None,
                        photo_guid: Optional[str] = None, confirmed: bool = False) -> dict[str, Any] | ToolReturn:
    """Create the maintenance ticket — human-in-the-loop, only AFTER the admin decided on the propose_triage card.

    ``proposal`` is exactly what you showed on the propose_triage card (incl. reasoning); ``final`` is
    what the admin approved (the proposal itself when approved as-is, their corrected values when
    corrected). ``admin_comment`` is the admin's reason (required when they corrected). ``photo_guid``
    links an attached defect photo. Without confirmed=true it only returns ``confirmation_required``
    and creates nothing. With confirmed=true it creates the ticket and runs the workflow
    propose → approve as the current user (stays "proposed" if they may not approve), and updates the
    shared ticket list on screen.
    Requires the ticket add permission.
    """
    return await sync_to_async(_create_ticket_with_state_sync, thread_sensitive=True)(
        ctx.deps.state, ctx.deps.user, ctx.deps.approvals, unit_guid, reporter_name, description, proposal, final, admin_comment,
        photo_guid, confirmed)


TRIAGE_TOOLS = (
    list_categories,
    list_contractors,
    find_units,
    list_tickets,
    create_ticket,
)
