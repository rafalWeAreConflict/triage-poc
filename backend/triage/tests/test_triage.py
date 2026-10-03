from io import StringIO

from config.roles_gen import P
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management import call_command
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from organization.models import Organization, OrganizationMember
from triage.management.commands.seed_triage import CONTRACTORS, TICKETS
from triage.models import Building, Category, CategoryCode, Contractor, Ticket, Unit
from triage.permissions import triage_admin_permissions
from triage.workflow import TICKET_WORKFLOW_SLUG, TRIAGE_ADMIN_GROUP, get_ticket_workflow
from workflows.models import TransitionLog, WorkflowInstance

User = get_user_model()


def _member(org, username, perms=(), groups=()):
    user = User.objects.create_user(username=username, email=f'{username}@example.test', password='x')
    membership = OrganizationMember.objects.create(organization=org, member=user, is_active=True)
    user.profile.active_organization = org
    user.profile.save()
    if perms:
        group = Group.objects.create(name=f'grp-{username}')
        group.permissions.add(*[p.perm() for p in perms])
        org.groups.add(group)
        membership.groups.add(group)
    for group in groups:
        org.groups.add(group)
        membership.groups.add(group)
    return user


class TriageFixtureMixin:

    def setUp(self):
        self.org = Organization.objects.create(name='TriageTestOrg')
        self.building = Building.objects.create(name='Test Building', address='1 Test Street, Springfield')
        self.unit = Unit.objects.create(building=self.building, number='T/1')
        self.category = Category.objects.create(code=CategoryCode.PLUMBING, name='Plumbing')
        self.contractor = Contractor.objects.create(name='Hydro-Test', category=self.category)
        self.admin_group = Group.objects.create(name=TRIAGE_ADMIN_GROUP)
        self.admin_group.permissions.add(*[p.perm() for p in triage_admin_permissions()])
        self.admin = _member(self.org, 'triage-admin', groups=[self.admin_group])

    def _ticket(self, **kwargs):
        defaults = {'unit': self.unit, 'reporter_name': 'John Test', 'description': 'Dripping tap'}
        return Ticket.objects.create(**{**defaults, **kwargs})


class ModelTest(TriageFixtureMixin, TestCase):

    def test_unit_number_unique_per_building(self):
        with transaction.atomic(), self.assertRaises(IntegrityError):
            Unit.objects.create(building=self.building, number='T/1')
        other = Building.objects.create(name='Other Building', address='2 Test Street')
        self.assertEqual(Unit.objects.create(building=other, number='T/1').number, 'T/1')

    def test_soft_deleted_unit_number_can_be_reused(self):
        self.unit.deleted_at = timezone.now()
        self.unit.save()
        self.assertEqual(Unit.objects.create(building=self.building, number='T/1').building, self.building)

    def test_category_code_unique(self):
        with transaction.atomic(), self.assertRaises(IntegrityError):
            Category.objects.create(code=CategoryCode.PLUMBING, name='Duplikat')

    def test_ticket_defaults(self):
        ticket = self._ticket()
        self.assertEqual(ticket.priority, 'normal')
        self.assertEqual(ticket.ai_suggestion, {})
        self.assertIsNone(ticket.category)
        self.assertIsNotNone(ticket.guid)


class WorkflowTest(TriageFixtureMixin, TestCase):

    def test_workflow_definition_exists_after_migrate(self):
        workflow = get_ticket_workflow()
        self.assertEqual(workflow.slug, TICKET_WORKFLOW_SLUG)
        self.assertEqual(workflow.validate_definition(), [])
        self.assertEqual(workflow.get_initial_state(), 'new')
        self.assertEqual(workflow.get_final_states(), {'closed'})

    def test_new_ticket_starts_in_new(self):
        ticket = self._ticket(created_by=self.admin)
        instance = ticket.workflow_instance
        self.assertEqual(instance.current_state, 'new')
        self.assertEqual(Ticket.objects.get(pk=ticket.pk).status, 'new')
        self.assertEqual(instance.transition_logs.count(), 1)

    def test_full_path_to_closed_logs_transitions(self):
        ticket = self._ticket()
        ticket.transition('propose', self.admin)
        ticket.transition('approve', self.admin)
        ticket.contractor = self.contractor
        ticket.save()
        ticket.transition('assign', self.admin)
        ticket.transition('close', self.admin)

        instance = ticket.workflow_instance
        self.assertEqual(instance.current_state, 'closed')
        self.assertTrue(instance.is_completed)
        self.assertEqual(Ticket.objects.get(pk=ticket.pk).status, 'closed')
        steps = list(TransitionLog.objects.filter(instance=instance).order_by('timestamp', 'pk').values_list('from_state', 'to_state'))
        self.assertEqual(steps, [('', 'new'), ('new', 'proposed'), ('proposed', 'approved'),
                                 ('approved', 'assigned'), ('assigned', 'closed')])

    def test_reject_returns_to_new(self):
        ticket = self._ticket()
        ticket.transition('propose', self.admin)
        ticket.transition('reject', self.admin, 'Wrong category')
        self.assertEqual(Ticket.objects.get(pk=ticket.pk).status, 'new')

    def test_invalid_transition_rejected(self):
        ticket = self._ticket()
        with self.assertRaises(ValidationError):
            ticket.transition('close', self.admin)

    def test_assign_requires_contractor(self):
        ticket = self._ticket()
        ticket.transition('propose', self.admin)
        ticket.transition('approve', self.admin)
        with self.assertRaises(ValidationError):
            ticket.transition('assign', self.admin)

    def test_approve_requires_permission(self):
        clerk = _member(self.org, 'clerk', perms=[P.TICKET_VIEW, P.TICKET_CHANGE])
        ticket = self._ticket()
        ticket.transition('propose', clerk)
        with self.assertRaises(PermissionDenied):
            ticket.transition('approve', clerk)
        self.assertEqual(ticket.workflow_instance.current_state, 'proposed')

    def test_approve_engine_condition_requires_triage_admin_role(self):
        # has the permission but not the "Triage Admin" group: the workflow definition's own condition blocks it
        approver = _member(self.org, 'approver', perms=[P.TICKET_CHANGE, P.TICKET_APPROVE])
        ticket = self._ticket()
        ticket.transition('propose', approver)
        with self.assertRaises(ValidationError):
            ticket.transition('approve', approver)

    def test_transition_without_change_permission_denied(self):
        viewer = _member(self.org, 'viewer', perms=[P.TICKET_VIEW])
        ticket = self._ticket()
        with self.assertRaises(PermissionDenied):
            ticket.transition('propose', viewer)

    def test_status_mirrors_engine_driven_transition(self):
        ticket = self._ticket()
        WorkflowInstance.objects.get(pk=ticket.workflow_instance.pk).transition('proposed', self.admin)
        self.assertEqual(Ticket.objects.get(pk=ticket.pk).status, 'proposed')
        ticket.reporter_name = 'Stale instance save'
        ticket.save()  # in-memory status is still "new" — must not overwrite the mirror
        self.assertEqual(Ticket.objects.get(pk=ticket.pk).status, 'proposed')


class SeedCommandTest(TestCase):

    def _seed(self, *args):
        call_command('seed_triage', *args, stdout=StringIO())

    def _counts(self):
        return {m.__name__: m.objects.count() for m in (Building, Unit, Category, Contractor, Ticket, TransitionLog)}

    def test_seed_is_idempotent(self):
        self._seed()
        first = self._counts()
        self._seed()
        self.assertEqual(self._counts(), first)
        self.assertEqual(first['Building'], 2)
        self.assertEqual(first['Unit'], 10)
        self.assertEqual(first['Category'], 7)
        self.assertEqual(first['Contractor'], len(CONTRACTORS))
        self.assertEqual(first['Ticket'], len(TICKETS))

    def test_seed_covers_all_states_with_logs(self):
        self._seed()
        self.assertEqual(set(Ticket.objects.values_list('status', flat=True)), {'new', 'proposed', 'approved', 'assigned', 'closed'})
        closed = Ticket.objects.get(status='closed')
        self.assertEqual(closed.workflow_instance.transition_logs.count(), 5)
        self.assertTrue(Ticket.objects.get(status='proposed').ai_suggestion['reasoning'])

    def test_seed_does_not_encode_elevator_rule(self):
        self._seed()
        self.assertFalse(Ticket.objects.filter(category__code=CategoryCode.ELEVATOR).exists())
        self.assertFalse(Ticket.objects.filter(description__icontains='elevator').exists())
        self.assertFalse(Ticket.objects.filter(description__icontains='lift').exists())
        self.assertEqual(Contractor.objects.get(slug='liftpro-elevators').category.code, CategoryCode.ELEVATOR)

    def test_seed_admin_group_and_superusers(self):
        root = User.objects.create_superuser(username='root-test', email='root@example.test', password='x')
        self._seed()
        group = Group.objects.get(name=TRIAGE_ADMIN_GROUP)
        self.assertTrue(group.permissions.filter(codename='approve_ticket').exists())
        self.assertTrue(root.groups.filter(name=TRIAGE_ADMIN_GROUP).exists())
        seed_admin = User.objects.get(username='triage.admin')
        self.assertFalse(seed_admin.has_usable_password())
        self.assertTrue(P.TICKET_APPROVE.check(seed_admin, False))

    def test_flush_resets_triage_data(self):
        self._seed()
        self._seed('--flush')
        self.assertEqual(Ticket.objects.count(), len(TICKETS))
        self.assertEqual(WorkflowInstance.objects.filter(workflow__slug=TICKET_WORKFLOW_SLUG).count(), len(TICKETS))
