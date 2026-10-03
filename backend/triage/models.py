"""Resident ticket triage domain (POC).

Models: Building → Unit → Ticket; Category and Contractor are the triage dictionaries.

Ticket lifecycle is owned by the workflows engine (``workflows.WorkflowDefinition`` slug
``ticket-triage``, see ``triage/workflow.py``):

    new --propose--> proposed --approve (HITL, Triage Admin)--> approved --assign--> assigned --close--> closed
    proposed --reject--> new  (admin correction of the AI proposal)

Status <-> workflow wiring:
- Creating a Ticket starts a ``WorkflowInstance`` in the initial state (``Ticket.save``).
- ``WorkflowInstance.current_state`` is the source of truth. ``Ticket.status`` is a denormalised,
  read-only mirror kept in sync by a ``post_save`` signal on WorkflowInstance (``triage/signals.py``),
  so it stays correct no matter who drives the engine (``Ticket.transition``, the workflows GraphQL
  mutations, the copilot's generic workflow tools, admin override). It exists so the status can be
  filtered/listed cheaply; never write it directly.
- ``Ticket.transition(name, user)`` is the domain entry point: checks ``P.TICKET_CHANGE`` (plus
  ``P.TICKET_APPROVE`` for ``approve``), domain guards, then calls the engine, which evaluates the
  definition's own conditions (``approve`` requires the "Triage Admin" group) and writes the
  immutable TransitionLog.
"""
import uuid

from core.models import BaseCoreModel, Tracking
from django.contrib.contenttypes.fields import GenericRelation
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import models, transaction
from workflows.models import WorkflowInstance


class CategoryCode(models.TextChoices):
    PLUMBING = 'plumbing', 'Plumbing'
    ELECTRICAL = 'electrical', 'Electrical'
    HEATING = 'heating', 'Heating'
    BUILDING_ADMIN = 'building_admin', 'Building Administration'
    ELEVATOR = 'elevator', 'Elevators'
    CLEANING = 'cleaning', 'Cleaning'
    OTHER = 'other', 'Other'


class TicketPriority(models.TextChoices):
    LOW = 'low', 'Low'
    NORMAL = 'normal', 'Normal'
    HIGH = 'high', 'High'
    URGENT = 'urgent', 'Urgent'


class TicketStatus(models.TextChoices):
    """Mirrors the state names of the ``ticket-triage`` workflow definition."""
    NEW = 'new', 'New'
    PROPOSED = 'proposed', 'AI proposal'
    APPROVED = 'approved', 'Approved'
    ASSIGNED = 'assigned', 'Assigned'
    CLOSED = 'closed', 'Closed'


class Building(BaseCoreModel):
    """name / slug / guid / description come from BaseCoreModel."""
    address = models.CharField(max_length=255)

    class Meta:
        ordering = ['name']


class Unit(Tracking):
    guid = models.UUIDField(editable=False, default=uuid.uuid4, unique=True)
    building = models.ForeignKey(Building, on_delete=models.PROTECT, related_name='units')
    number = models.CharField(max_length=32, help_text='Unit number, e.g. "A/1"')

    class Meta:
        ordering = ['building__name', 'number']
        constraints = [
            models.UniqueConstraint(
                fields=['building', 'number'],
                condition=models.Q(deleted_at__isnull=True),
                name='triage_unique_unit_number_per_building',
            ),
        ]

    def __str__(self):
        return f'{self.building.name} – flat {self.number}'


class Category(BaseCoreModel):
    """name (display name) / slug / guid / description come from BaseCoreModel."""
    code = models.CharField(max_length=32, choices=CategoryCode.choices, unique=True)

    class Meta:
        ordering = ['name']
        verbose_name_plural = 'categories'


class Contractor(BaseCoreModel):
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name='contractors')
    phone = models.CharField(max_length=32, blank=True)
    email = models.EmailField(blank=True)

    class Meta:
        ordering = ['name']


class Ticket(Tracking):
    guid = models.UUIDField(editable=False, default=uuid.uuid4, unique=True)
    unit = models.ForeignKey(Unit, on_delete=models.PROTECT, related_name='tickets')
    reporter_name = models.CharField(max_length=150)
    description = models.TextField()
    # Default storage = S3Boto3Storage (MinIO locally, S3 in prod) when USE_S3 is on.
    photo = models.ImageField(upload_to='triage/tickets/%Y/%m/', null=True, blank=True)
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL, related_name='tickets')
    priority = models.CharField(max_length=16, choices=TicketPriority.choices, default=TicketPriority.NORMAL)
    contractor = models.ForeignKey(Contractor, null=True, blank=True, on_delete=models.SET_NULL, related_name='tickets')
    # Read-only mirror of the workflow state — see module docstring.
    status = models.CharField(max_length=16, choices=TicketStatus.choices, default=TicketStatus.NEW,
                              editable=False, db_index=True)
    # AI proposal: {"category": <code>, "priority": <code>, "contractor": <slug>, "reasoning": <str>}
    ai_suggestion = models.JSONField(default=dict, blank=True)
    # Admin correction of the AI proposal (empty when approved as-is):
    # {"changed_fields": {<field>: {"from": <ai value>, "to": <final value>}}, "comment": <str>,
    #  "corrected_by": <username>, "corrected_at": <iso datetime>}
    admin_correction = models.JSONField(default=dict, blank=True)

    workflow_instances = GenericRelation(WorkflowInstance, content_type_field='content_type', object_id_field='object_id')

    class Meta:
        ordering = ['-created_at']
        permissions = (
            ('approve_ticket', 'Can approve ticket triage (HITL)'),
        )

    def __str__(self):
        return f'#{str(self.guid)[:8]} {self.unit} – {self.description[:40]}'

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        if not is_new:
            # never let a stale in-memory status overwrite the workflow-owned mirror
            instance = self.workflow_instance
            if instance is not None:
                self.status = instance.current_state
        with transaction.atomic():
            super().save(*args, **kwargs)
            if is_new:
                self._start_workflow()

    def _start_workflow(self):
        from .workflow import get_ticket_workflow
        workflow = get_ticket_workflow()
        if workflow is None:
            raise ValidationError('Ticket triage workflow is not defined — run migrations or `manage.py seed_triage`.')
        instance = WorkflowInstance.start(workflow, self, self.created_by)
        self.status = instance.current_state

    @property
    def workflow_instance(self):
        return self.workflow_instances.select_related('workflow').order_by('-pk').first()

    def available_transitions(self, user=None) -> list[dict]:
        instance = self.workflow_instance
        return instance.get_available_transitions(user) if instance else []

    def transition(self, name: str, user, note: str = ''):
        """Run the named workflow transition (propose/approve/reject/assign/close) as ``user``."""
        from config.roles_gen import P

        if user is None or not user.is_authenticated:
            raise PermissionDenied('Authentication required')
        P.TICKET_CHANGE.check(user)
        if name == 'approve':
            P.TICKET_APPROVE.check(user)

        instance = self.workflow_instance
        if instance is None:
            raise ValidationError('Ticket has no workflow instance')
        transition_def = next(
            (t for t in instance.workflow.get_available_transitions(instance.current_state) if t.get('name') == name),
            None,
        )
        if transition_def is None:
            raise ValidationError(f'Transition "{name}" is not available from state "{instance.current_state}"')
        if name == 'assign' and self.contractor_id is None:
            raise ValidationError('Cannot assign a ticket without a contractor')

        log = instance.transition(transition_def['to_state'], user, note)
        self.status = instance.current_state
        return log


class TicketPhoto(Tracking):
    """A defect photo received in the copilot chat, stored before the ticket exists.

    The copilot view persists every image a resident attaches to a chat message (default storage —
    MinIO locally / S3 in prod) and tells the agent its ``guid``; ``create_ticket(photo_guid=...)``
    then links the same stored file to ``Ticket.photo``. Deduplicated per uploader by content hash,
    because AG-UI replays the whole conversation (images included) on every run.
    """
    guid = models.UUIDField(editable=False, default=uuid.uuid4, unique=True)
    image = models.ImageField(upload_to='triage/photos/%Y/%m/')
    sha256 = models.CharField(max_length=64, db_index=True)
    content_type = models.CharField(max_length=64)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(fields=['sha256', 'created_by'], name='triage_unique_photo_per_uploader'),
        ]

    def __str__(self):
        return f'photo {str(self.guid)[:8]}'
