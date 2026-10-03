"""AG-UI shared state for the triage screen (``/triage`` in the frontend).

The copilot agent is stateful: ``CopilotDeps`` implements Pydantic AI's ``StateHandler`` protocol
(a dataclass with a ``state`` field), so ``AGUIAdapter`` hands it the frontend's ``RunAgentInput.state``
at the start of every run. The agent owns this shape::

    {
      "tickets": [ {guid, unit, reporter_name, description, category_code, category_name, priority,
                    contractor_slug, contractor_name, status, created_at, was_corrected, has_photo}, ... ],
      "draft": {tool_call_id, unit_guid, unit_label, reporter_name, description, category_code,
                category_name, priority, contractor_slug, contractor_name, reasoning, has_photo,
                status: "awaiting_decision" | "approved" | "corrected"} | null,
      "last_created_guid": <guid of the ticket created in the latest run> | null,
      "last_updated": <ISO timestamp>
    }

and pushes it to the UI as AG-UI ``STATE_SNAPSHOT`` events:

* at run start (``with_triage_state``): the ticket list is refreshed from the database (the DB is the
  source of truth; tickets may change in Django admin between runs) and the draft is reconciled with
  the admin's answer to ``propose_triage``;
* when the model calls the frontend HITL tool ``propose_triage``: its arguments become the ``draft``
  (the "Draft / in progress" row) — the stream wrapper sees the tool call, the model needs no extra tool;
* after ``create_ticket`` succeeds: the tool returns a ``ToolReturn`` whose ``metadata`` carries the
  snapshot (Pydantic AI's AG-UI event stream emits ``BaseEvent`` metadata right after the tool result),
  with the refreshed list, the draft cleared and ``last_created_guid`` set.

CopilotKit Intelligence stores the run's events, so the snapshots are replayed when a thread is
reopened and the list state survives a reload. External identifiers only (guid / code / slug).
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, Optional

from ag_ui.core import BaseEvent, EventType, RunAgentInput, StateSnapshotEvent, ToolMessage
from asgiref.sync import sync_to_async
from django.utils import timezone
from triage.listing import RECENT_TICKET_LIMIT, excerpt, recent_tickets
from triage.models import Category, Contractor

PROPOSE_TRIAGE_TOOL = 'propose_triage'  # frontend HITL tool (frontend/copilot/config.ts)


def recent_tickets_sync(user) -> list[dict[str, Any]]:
    return recent_tickets(user, RECENT_TICKET_LIMIT)


def _stamp(state: dict[str, Any]) -> dict[str, Any]:
    state['last_updated'] = timezone.now().isoformat()
    return state


def snapshot_event(state: dict[str, Any]) -> StateSnapshotEvent:
    return StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=dict(state))


def apply_ticket_created_sync(state: dict[str, Any], user, ticket_guid: str) -> dict[str, Any]:
    """Mutate the run state after create_ticket: fresh list, no draft, remember the new ticket."""
    state['tickets'] = recent_tickets_sync(user)
    state['draft'] = None
    state['last_created_guid'] = ticket_guid
    return _stamp(state)


# ---------------------------------------------------------------------------
# run start: refresh tickets, reconcile the draft with the propose_triage answer
# ---------------------------------------------------------------------------

def _tool_decision(message: ToolMessage) -> Optional[str]:
    try:
        payload = json.loads(message.content)
    except (TypeError, ValueError):
        return None
    decision = payload.get('decision') if isinstance(payload, dict) else None
    return decision if isinstance(decision, str) else None


def reconcile_draft(draft: Any, messages: list[Any]) -> Optional[dict[str, Any]]:
    """The draft as it should look at the start of a run.

    * no answer to its propose_triage call yet → unchanged ("awaiting_decision");
    * the answer is the last message (this run resumes the HITL tool) → status = the decision;
    * the answer is older (a later user turn started this run) → the draft is stale, dropped.
    """
    if not isinstance(draft, dict) or not draft.get('tool_call_id'):
        return None
    for index, message in enumerate(messages):
        if isinstance(message, ToolMessage) and message.tool_call_id == draft['tool_call_id']:
            if index != len(messages) - 1:
                return None
            decision = _tool_decision(message)
            return {**draft, 'status': decision if decision in ('approved', 'corrected') else 'decided'}
    return draft


def prepare_run_state_sync(state: dict[str, Any], user, run_input: RunAgentInput) -> dict[str, Any]:
    state['tickets'] = recent_tickets_sync(user)
    state['draft'] = reconcile_draft(state.get('draft'), list(run_input.messages or []))
    state.setdefault('last_created_guid', None)
    return _stamp(state)


# ---------------------------------------------------------------------------
# propose_triage → draft
# ---------------------------------------------------------------------------

def build_draft_sync(tool_call_id: str, args: dict[str, Any]) -> dict[str, Any]:
    category_code = args.get('category_code') or None
    contractor_slug = args.get('contractor_slug') or None
    category = Category.objects.filter(code=category_code).first() if category_code else None
    contractor = Contractor.objects.filter(slug=contractor_slug).first() if contractor_slug else None
    return {
        'tool_call_id': tool_call_id,
        'unit_guid': args.get('unit_guid'),
        'unit_label': args.get('unit_label') or '',
        'reporter_name': args.get('reporter_name') or '',
        'description': excerpt(args.get('description') or ''),
        'category_code': category_code,
        'category_name': category.name if category else None,
        'priority': args.get('priority'),
        'contractor_slug': contractor_slug,
        'contractor_name': contractor.name if contractor else None,
        'reasoning': excerpt(args.get('reasoning') or '', 280),
        'has_photo': bool(args.get('photo_guid')),
        'status': 'awaiting_decision',
    }


async def with_triage_state(events: AsyncIterator[BaseEvent], deps, run_input: RunAgentInput) -> AsyncIterator[BaseEvent]:
    """Wrap the adapter's AG-UI event stream with the triage STATE_SNAPSHOT events.

    ``deps.state`` was already set by the adapter from ``run_input.state`` when the stream started.
    """
    pending_args: dict[str, list[str]] = {}
    seeded = False
    async for event in events:
        yield event
        kind = getattr(event, 'type', None)
        if kind == EventType.RUN_STARTED and not seeded:
            seeded = True
            await sync_to_async(prepare_run_state_sync, thread_sensitive=True)(deps.state, deps.user, run_input)
            yield snapshot_event(deps.state)
        elif kind == EventType.TOOL_CALL_START and event.tool_call_name == PROPOSE_TRIAGE_TOOL:
            pending_args[event.tool_call_id] = []
        elif kind == EventType.TOOL_CALL_ARGS and event.tool_call_id in pending_args:
            pending_args[event.tool_call_id].append(event.delta)
        elif kind == EventType.TOOL_CALL_END and event.tool_call_id in pending_args:
            raw = ''.join(pending_args.pop(event.tool_call_id))
            try:
                args = json.loads(raw) if raw else {}
            except ValueError:
                args = {}
            if isinstance(args, dict):
                deps.state['draft'] = await sync_to_async(build_draft_sync, thread_sensitive=True)(
                    event.tool_call_id, args)
                yield snapshot_event(_stamp(deps.state))
