"""Ticket triage workflow definition for the workflows engine.

The definition lives in the DB (``workflows.WorkflowDefinition``); this module is the single
source of truth used by the data migration (fresh DB gets it on ``migrate``) and by
``seed_triage`` (re-asserts it idempotently).

Each transition carries an extra ``name`` key (propose/approve/...) — the engine ignores unknown
keys and resolves transitions by ``(from_state, to_state)``; ``Ticket.transition(name, ...)`` uses
the name to look them up.
"""
TICKET_WORKFLOW_SLUG = 'ticket-triage'
TICKET_WORKFLOW_NAME = 'Ticket triage'
TICKET_MODEL_LABEL = 'triage.Ticket'
TRIAGE_ADMIN_GROUP = 'Triage Admin'

TICKET_WORKFLOW_STATES = [
    {'name': 'new', 'label': 'New', 'is_initial': True, 'is_final': False, 'color': '#6b7280'},
    {'name': 'proposed', 'label': 'AI proposal', 'is_initial': False, 'is_final': False, 'color': '#3b82f6'},
    {'name': 'approved', 'label': 'Approved', 'is_initial': False, 'is_final': False, 'color': '#8b5cf6'},
    {'name': 'assigned', 'label': 'Assigned', 'is_initial': False, 'is_final': False, 'color': '#f59e0b'},
    {'name': 'closed', 'label': 'Closed', 'is_initial': False, 'is_final': True, 'color': '#22c55e'},
]

TICKET_WORKFLOW_TRANSITIONS = [
    {'name': 'propose', 'from_state': 'new', 'to_state': 'proposed', 'label': 'Propose',
     'conditions': [], 'actions': [], 'timeout_hours': None},
    # HITL: only a Triage Admin (or superuser) may approve the AI proposal.
    {'name': 'approve', 'from_state': 'proposed', 'to_state': 'approved', 'label': 'Approve',
     'conditions': [{'type': 'user_has_role', 'role': TRIAGE_ADMIN_GROUP}], 'actions': [], 'timeout_hours': None},
    {'name': 'reject', 'from_state': 'proposed', 'to_state': 'new', 'label': 'Reject / send back',
     'conditions': [], 'actions': [], 'timeout_hours': None},
    {'name': 'assign', 'from_state': 'approved', 'to_state': 'assigned', 'label': 'Assign',
     'conditions': [], 'actions': [], 'timeout_hours': None},
    {'name': 'close', 'from_state': 'assigned', 'to_state': 'closed', 'label': 'Close',
     'conditions': [], 'actions': [], 'timeout_hours': None},
]


def ensure_ticket_workflow(workflow_definition_model):
    """Create or update the ticket workflow. Works with the real model and with a migration's historical model."""
    workflow, _ = workflow_definition_model.objects.update_or_create(
        slug=TICKET_WORKFLOW_SLUG,
        model_label=TICKET_MODEL_LABEL,
        defaults={
            'name': TICKET_WORKFLOW_NAME,
            'description': 'Lifecycle of a resident maintenance request: new → proposed → approved → assigned → closed.',
            'states': TICKET_WORKFLOW_STATES,
            'transitions': TICKET_WORKFLOW_TRANSITIONS,
            'is_enabled': True,
        },
    )
    return workflow


def get_ticket_workflow():
    from workflows.models import WorkflowDefinition
    return WorkflowDefinition.objects.filter(
        slug=TICKET_WORKFLOW_SLUG, model_label=TICKET_MODEL_LABEL, is_enabled=True,
    ).first()
