"""Seed the triage POC domain (idempotent).

Usage:
    python manage.py seed_triage           # create / update what is missing
    python manage.py seed_triage --flush   # hard-delete triage data (tickets + their workflow instances, contractors,
                                           # units, buildings, categories) first — dev reset only

Creates: 2 buildings, 10 units, 7 categories, 7 contractors, the "Ticket triage" workflow definition,
the "Triage Admin" group (linked to the "Linden Street Housing Cooperative" organization, with all
superusers and a passwordless staff user ``triage.admin`` as members) and 6 sample tickets driven
through the workflow engine, so TransitionLog rows exist.

Learning demo (plan 5.3): the cooperative's own routing rule for elevator issues is intentionally NOT
seeded — no elevator tickets exist and nothing in data, descriptions or code encodes it; the agent has
to learn it from a single admin correction (see README, "Learning demo").
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.management.base import BaseCommand
from django.db import transaction
from organization.models import Organization, OrganizationMember
from triage.models import Building, Category, CategoryCode, Contractor, Ticket, TicketPriority, Unit
from triage.permissions import triage_admin_permissions
from triage.workflow import TICKET_MODEL_LABEL, TRIAGE_ADMIN_GROUP, ensure_ticket_workflow
from workflows.models import TransitionLog, WorkflowDefinition, WorkflowInstance

ORG_NAME = 'Linden Street Housing Cooperative'
ORG_SLUG = 'linden-coop'
SEED_USERNAME = 'triage.admin'

BUILDINGS = [
    # slug, name, address, unit prefix
    ('building-a', 'Building A', '12 Linden Street, Springfield', 'A'),
    ('building-b', 'Building B', '14 Linden Street, Springfield', 'B'),
]
UNITS_PER_BUILDING = 5

CATEGORIES = [
    (CategoryCode.PLUMBING, 'Water and drainage: taps, pipes, drains, leaks.'),
    (CategoryCode.ELECTRICAL, 'Electrical installation: lighting, sockets, fuses, power outages.'),
    (CategoryCode.HEATING, 'Central heating: radiators, valves, hot water from the heating substation.'),
    (CategoryCode.BUILDING_ADMIN, 'Administrative matters and the property manager: common areas, service contracts.'),
    (CategoryCode.ELEVATOR, 'Passenger elevators.'),
    (CategoryCode.CLEANING, 'Cleaning of stairwells and the grounds around the building.'),
    (CategoryCode.OTHER, 'Small repairs and anything that does not fit another category.'),
]

CONTRACTORS = [
    # slug, name, category, phone, email
    ('flowfix-plumbing', 'FlowFix Plumbing', CategoryCode.PLUMBING, '+1 555 0101', 'jobs@flowfix.example.test'),
    ('brightspark-electric', 'BrightSpark Electric', CategoryCode.ELECTRICAL, '+1 555 0102', 'office@brightspark.example.test'),
    ('warmhome-heating', 'WarmHome Heating', CategoryCode.HEATING, '+1 555 0103', 'service@warmhome.example.test'),
    ('linden-coop-building-management', 'Linden Coop Building Management', CategoryCode.BUILDING_ADMIN,
     '+1 555 0104', 'management@linden-coop.example.test'),
    ('liftpro-elevators', 'LiftPro Elevators', CategoryCode.ELEVATOR, '+1 555 0105', 'service@liftpro.example.test'),
    ('cleanblock-services', 'CleanBlock Services', CategoryCode.CLEANING, '+1 555 0106', 'contact@cleanblock.example.test'),
    ('handycrew', 'HandyCrew', CategoryCode.OTHER, '+1 555 0107', 'hello@handycrew.example.test'),
]


def _suggestion(category, priority, contractor, reasoning):
    return {'category': category, 'priority': priority, 'contractor': contractor, 'reasoning': reasoning}


# path = workflow transitions applied in order; ticket fields are filled from ai_suggestion on approve.
TICKETS = [
    {
        'unit': 'A/2', 'reporter_name': 'Emily Carter',
        'description': 'Kitchen tap is dripping constantly, even when turned off hard.',
        'ai_suggestion': {}, 'path': [],
    },
    {
        'unit': 'B/3', 'reporter_name': 'David Miller',
        'description': 'Hallway light on the 2nd and 3rd floor is out; the stairwell is completely dark in the evening.',
        'ai_suggestion': _suggestion(
            CategoryCode.ELECTRICAL, TicketPriority.HIGH, 'brightspark-electric',
            'No stairwell lighting is an electrical fault; a dark stairwell is a fall risk, so priority is high.'),
        # first proposal rejected by the admin (priority too low), then re-proposed
        'path': [('propose', 'AI proposal: electrical, normal priority'),
                 ('reject', 'A dark stairwell is a safety hazard - raise the priority'),
                 ('propose', 'AI proposal after correction: electrical, high priority')],
    },
    {
        'unit': 'A/3', 'reporter_name': 'Sarah Johnson',
        'description': 'The lamp at the building entrance flickers and then goes out.',
        'ai_suggestion': _suggestion(
            CategoryCode.ELECTRICAL, TicketPriority.NORMAL, 'brightspark-electric',
            'Faulty light fitting at the entrance - electrician; the entrance is lit by a street lamp, so priority is normal.'),
        'path': [('propose', ''), ('approve', 'Approved by the administrator')],
    },
    {
        'unit': 'B/4', 'reporter_name': 'Michael Brown',
        'description': 'Stairwell needs cleaning after renovation of a flat on the 4th floor - dust and rubble on the stairs.',
        'ai_suggestion': _suggestion(
            CategoryCode.CLEANING, TicketPriority.LOW, 'cleanblock-services',
            'Common areas dirty after a renovation - cleaning company; no hazard, so priority is low.'),
        'path': [('propose', ''), ('approve', ''), ('assign', 'Handed over to CleanBlock Services')],
    },
    {
        'unit': 'B/5', 'reporter_name': 'Olivia Davis',
        'description': 'Bathroom pipe under the sink is leaking; water is on the floor and dripping into the flat below.',
        'ai_suggestion': _suggestion(
            CategoryCode.PLUMBING, TicketPriority.URGENT, 'flowfix-plumbing',
            'Active leak flooding the flat below - plumber, urgent priority.'),
        'path': [('propose', ''), ('approve', ''), ('assign', 'FlowFix Plumbing: visit this afternoon')],
    },
    {
        'unit': 'A/1', 'reporter_name': 'James Taylor',
        'description': 'Radiator in the bedroom is cold even though the thermostatic valve is fully open.',
        'ai_suggestion': _suggestion(
            CategoryCode.HEATING, TicketPriority.NORMAL, 'warmhome-heating',
            'Cold radiator with an open valve - trapped air or a stuck valve; heating service, normal priority.'),
        'path': [('propose', ''), ('approve', ''), ('assign', ''), ('close', 'Radiator bled, working again')],
    },
]


class Command(BaseCommand):
    help = 'Seed triage POC data (buildings, units, categories, contractors, workflow, sample tickets). Idempotent.'

    def add_arguments(self, parser):
        parser.add_argument('--flush', action='store_true', help='Delete triage data before seeding (triage tables only).')

    def handle(self, *args, **options):
        with transaction.atomic():
            if options['flush']:
                self._flush()
            ensure_ticket_workflow(WorkflowDefinition)
            actor = self._ensure_admin_group()
            self._seed_dictionaries()
            self._seed_tickets(actor)
        self._report()

    # ── steps ────────────────────────────────────────────────────────────────

    def _flush(self):
        tickets = Ticket.objects.all()
        WorkflowInstance.objects.filter(workflow__model_label=TICKET_MODEL_LABEL, object_id__in=tickets.values('pk')).delete()
        for model in (Ticket, Contractor, Unit, Building, Category):
            deleted, _ = model.objects.all().delete()
            self.stdout.write(f'  flushed {model.__name__}: {deleted} row(s)')

    def _ensure_admin_group(self):
        User = get_user_model()
        group, _ = Group.objects.get_or_create(name=TRIAGE_ADMIN_GROUP)
        group.permissions.add(*[p.perm() for p in triage_admin_permissions()])

        org, _ = Organization.objects.get_or_create(name=ORG_NAME, defaults={'slug': ORG_SLUG})
        org.groups.add(group)

        actor, created = User.objects.get_or_create(
            username=SEED_USERNAME, defaults={'email': f'{SEED_USERNAME}@example.test', 'is_staff': True},
        )
        if created:
            actor.set_unusable_password()
            actor.save()

        for user in [actor, *User.objects.filter(is_superuser=True)]:
            membership, _ = OrganizationMember.objects.get_or_create(organization=org, member=user, defaults={'is_active': True})
            membership.groups.add(group)  # signal mirrors it into user.groups (used by the workflow role condition)
            if user.profile.active_organization_id is None:
                user.profile.active_organization = org
                user.profile.save()
        return actor

    def _seed_dictionaries(self):
        for code, description in CATEGORIES:
            Category.objects.update_or_create(code=code, defaults={'slug': code.value, 'name': code.label, 'description': description})

        for slug, name, address, prefix in BUILDINGS:
            building, _ = Building.objects.update_or_create(slug=slug, defaults={'name': name, 'address': address})
            for i in range(1, UNITS_PER_BUILDING + 1):
                Unit.objects.get_or_create(building=building, number=f'{prefix}/{i}', deleted_at__isnull=True)

        for slug, name, category_code, phone, email in CONTRACTORS:
            Contractor.objects.update_or_create(slug=slug, defaults={
                'name': name, 'category': Category.objects.get(code=category_code), 'phone': phone, 'email': email,
            })

    def _seed_tickets(self, actor):
        for spec in TICKETS:
            unit = Unit.objects.get(number=spec['unit'], deleted_at__isnull=True)
            if Ticket.objects.filter(unit=unit, description=spec['description'], deleted_at__isnull=True).exists():
                continue
            ticket = Ticket.objects.create(
                unit=unit, reporter_name=spec['reporter_name'], description=spec['description'],
                ai_suggestion=spec['ai_suggestion'], created_by=actor, updated_by=actor,
            )
            for name, note in spec['path']:
                if name == 'approve':
                    suggestion = spec['ai_suggestion']
                    ticket.category = Category.objects.get(code=suggestion['category'])
                    ticket.priority = suggestion['priority']
                    ticket.contractor = Contractor.objects.get(slug=suggestion['contractor'])
                    ticket.updated_by = actor
                    ticket.save()
                ticket.transition(name, actor, note)

    def _report(self):
        self.stdout.write(self.style.SUCCESS('Triage seed done.'))
        for model in (Building, Unit, Category, Contractor, Ticket):
            self.stdout.write(f'  {model.__name__:<11} {model.objects.filter(deleted_at__isnull=True).count()}')
        instances = WorkflowInstance.objects.filter(workflow__model_label=TICKET_MODEL_LABEL)
        self.stdout.write(f'  {"Workflow":<11} {instances.count()} instance(s), '
                          f'{TransitionLog.objects.filter(instance__in=instances).count()} transition log(s)')
        self.stdout.write('')
        self.stdout.write(f'  {"unit":<6} {"category":<15} {"priority":<8} {"status":<9} contractor')
        for t in Ticket.objects.filter(deleted_at__isnull=True).select_related('unit', 'category', 'contractor').order_by('unit__number'):
            self.stdout.write(f'  {t.unit.number:<6} {(t.category.code if t.category else "-"):<15} {t.priority:<8} {t.status:<9} '
                              f'{t.contractor.name if t.contractor else "-"}')
