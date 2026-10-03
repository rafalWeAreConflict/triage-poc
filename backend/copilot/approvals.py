"""Server-side enforcement of the copilot's human-in-the-loop approvals.

The consequential tools (``create_ticket``, ``execute_workflow_transition``) take a ``confirmed`` flag,
but the model fills that flag in, so on its own it only proves the model *says* a human approved. A
prompt injection in a resident's description could make the model pass ``confirmed=true`` without the
admin ever seeing the card.

The human's decision is the result of a FRONTEND tool (``propose_triage`` /
``confirm_workflow_transition``). CopilotKit only produces that result when the admin clicks on the card,
and it reaches Django as a ``ToolMessage`` in the next run's ``RunAgentInput.messages``. The model cannot
write into that history: within a run it can only make new tool calls. So this module rebuilds the
decisions from the submitted history, and the tools act only on a decision that matches what they are
about to do and that has not been used yet.

This defends against the model acting without the human. It does not defend against the signed-in user
forging their own history; that user is the approver and holds the permission anyway.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

PROPOSE_TRIAGE = 'propose_triage'
CREATE_TICKET = 'create_ticket'
CONFIRM_TRANSITION = 'confirm_workflow_transition'
EXECUTE_TRANSITION = 'execute_workflow_transition'

DECISION_FIELDS = ('category_code', 'priority', 'contractor_slug')


@dataclass(frozen=True)
class TriageApproval:
    """The admin's decision on a ``propose_triage`` card."""

    tool_call_id: str
    unit_guid: str
    photo_guid: Optional[str]
    proposal: dict[str, str]
    final: dict[str, str]
    decision: str  # "approved" | "corrected"
    comment: Optional[str]


@dataclass(frozen=True)
class TransitionApproval:
    """An approved ``confirm_workflow_transition`` prompt."""

    tool_call_id: str
    instance_ref: str
    to_state_label: Optional[str]


@dataclass
class HumanApprovals:
    """Unused admin decisions found in the thread history, plus the ones used during this run."""

    triage: Optional[TriageApproval] = None
    transitions: tuple[TransitionApproval, ...] = ()
    used: set[str] = field(default_factory=set)

    def triage_for(self, unit_guid: str, photo_guid: Optional[str], proposal: dict[str, Any],
                   final: dict[str, Any]) -> Optional[TriageApproval]:
        """The unused triage decision that covers exactly this ticket, or ``None``."""
        approval = self.triage
        if approval is None or approval.tool_call_id in self.used:
            return None
        if (approval.unit_guid != unit_guid
                or (approval.photo_guid or None) != (photo_guid or None)
                or _decision(proposal) != approval.proposal
                or _decision(final) != approval.final):
            return None
        return approval

    def transition_for(self, instance_ref: str, to_state_label: str) -> Optional[TransitionApproval]:
        """The unused approval of this transition (same instance, same target state the human saw)."""
        for approval in reversed(self.transitions):
            if (approval.tool_call_id not in self.used
                    and approval.instance_ref == instance_ref
                    and approval.to_state_label == to_state_label):
                return approval
        return None

    def use(self, approval: TriageApproval | TransitionApproval) -> None:
        """Mark a decision as spent, so one click authorises one action."""
        self.used.add(approval.tool_call_id)


def collect_approvals(messages: Iterable[Any]) -> HumanApprovals:
    """Rebuild the unused human decisions from AG-UI ``RunAgentInput.messages``.

    - Only the latest ``propose_triage`` decision counts, and a later successful ``create_ticket``
      spends it.
    - Every approved ``confirm_workflow_transition`` counts until a later successful
      ``execute_workflow_transition`` on the same instance spends it.
    """
    calls: dict[str, tuple[str, dict[str, Any]]] = {}
    triage: Optional[TriageApproval] = None
    transitions: list[TransitionApproval] = []

    for message in messages:
        role = getattr(message, 'role', None)
        if role == 'assistant':
            for call in getattr(message, 'tool_calls', None) or ():
                calls[call.id] = (call.function.name, _as_dict(call.function.arguments))
            continue
        if role != 'tool':
            continue
        name, args = calls.get(getattr(message, 'tool_call_id', ''), (None, {}))
        result = _as_dict(getattr(message, 'content', None))

        if name == PROPOSE_TRIAGE:
            triage = _triage_approval(message.tool_call_id, args, result)
        elif name == CREATE_TICKET and result.get('status') == 'ok':
            triage = None
        elif name == CONFIRM_TRANSITION and result.get('approved') is True and args.get('instance_ref'):
            transitions.append(TransitionApproval(
                tool_call_id=message.tool_call_id,
                instance_ref=str(args['instance_ref']),
                to_state_label=_str_or_none(args.get('to_state_label')),
            ))
        elif name == EXECUTE_TRANSITION and result.get('status') == 'executed':
            transitions = [a for a in transitions if a.instance_ref != result.get('instance_ref')]

    return HumanApprovals(triage=triage, transitions=tuple(transitions))


def _triage_approval(tool_call_id: str, args: dict[str, Any], result: dict[str, Any]) -> Optional[TriageApproval]:
    decision = result.get('decision')
    final = result.get('final')
    if decision not in ('approved', 'corrected') or not isinstance(final, dict) or not args.get('unit_guid'):
        return None
    return TriageApproval(
        tool_call_id=tool_call_id,
        unit_guid=str(args['unit_guid']),
        photo_guid=_str_or_none(args.get('photo_guid')),
        proposal=_decision(args),
        final=_decision(final),
        decision=decision,
        comment=_str_or_none(result.get('comment')),
    )


def _decision(source: Any) -> dict[str, str]:
    if hasattr(source, 'model_dump'):
        source = source.model_dump()
    if not isinstance(source, dict):
        source = {}
    return {key: str(source.get(key) or '') for key in DECISION_FIELDS}


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def _str_or_none(value: Any) -> Optional[str]:
    return value.strip() or None if isinstance(value, str) else None
