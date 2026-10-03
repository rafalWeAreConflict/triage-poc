"""Recent-ticket rows shared by the GraphQL ``triageTickets`` query and the copilot's AG-UI shared state
(``copilot.triage_state``), so the /triage list looks the same whichever source filled it.

External identifiers only (ticket guid, unit number, category code, contractor slug).
"""
from __future__ import annotations

from typing import Any

from config.roles_gen import P

from .models import Ticket

RECENT_TICKET_LIMIT = 12
MAX_TICKET_LIMIT = 50
DESCRIPTION_EXCERPT = 140


def excerpt(text: str, limit: int = DESCRIPTION_EXCERPT) -> str:
    text = (text or '').strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def ticket_row(ticket: Ticket) -> dict[str, Any]:
    return {
        'guid': str(ticket.guid),
        'unit': ticket.unit.number,
        'reporter_name': ticket.reporter_name,
        'description': excerpt(ticket.description),
        'category_code': ticket.category.code if ticket.category else None,
        'category_name': ticket.category.name if ticket.category else None,
        'priority': ticket.priority,
        'contractor_slug': ticket.contractor.slug if ticket.contractor else None,
        'contractor_name': ticket.contractor.name if ticket.contractor else None,
        'status': ticket.status,
        'created_at': ticket.created_at.isoformat(),
        'was_corrected': bool((ticket.admin_correction or {}).get('changed_fields')),
        'has_photo': bool(ticket.photo),
    }


def recent_tickets(user, limit: int = RECENT_TICKET_LIMIT) -> list[dict[str, Any]]:
    """Newest tickets, or ``[]`` when the user lacks the ticket view permission."""
    if not P.TICKET_VIEW.check(user, raised_error=False):
        return []
    limit = max(1, min(int(limit), MAX_TICKET_LIMIT))
    qs = (Ticket.objects.select_related('unit', 'category', 'contractor')
          .filter(deleted_at__isnull=True).order_by('-created_at'))
    return [ticket_row(t) for t in qs[:limit]]
