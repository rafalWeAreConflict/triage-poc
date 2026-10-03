"""Triage copilot tools: permission gating, the create_ticket HITL gate, corrections, workflow, photos.

Driven by FunctionModel scripts (one tool call, then a text turn) — never a live LLM. Photos use
in-memory storage so no MinIO/S3 is touched.
"""
import base64
import io
import json

from asgiref.sync import async_to_sync
from config.roles_gen import P
from copilot.agent import SYSTEM_PROMPT, CopilotDeps, build_agent
from copilot.approvals import collect_approvals
from copilot.tests.support import grant, hitl_history, make_member_user, make_org
from django.contrib.auth.models import Group
from django.test import TestCase, override_settings
from organization.models import OrganizationMember
from PIL import Image
from pydantic_ai import ModelResponse, TextPart, ToolCallPart, models
from pydantic_ai.messages import BinaryContent, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.ui.ag_ui import AGUIAdapter
from triage.models import Building, Category, CategoryCode, Contractor, Ticket, TicketPhoto, Unit
from triage.permissions import triage_admin_permissions
from triage.photos import annotate_run_input_photos
from triage.workflow import TRIAGE_ADMIN_GROUP
from workflows.models import TransitionLog

models.ALLOW_MODEL_REQUESTS = False

IN_MEMORY_STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.InMemoryStorage'},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
}


def _png_b64(color=(200, 30, 30)) -> str:
    buf = io.BytesIO()
    Image.new('RGB', (8, 8), color).save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def _script(tool_name, tool_args):
    def fn(messages, info):
        if any(isinstance(p, ToolReturnPart) for m in messages for p in m.parts):
            return ModelResponse(parts=[TextPart('done')])
        return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=tool_args)])
    return fn


# No Skill delivery fetch in tests (it would reach the live runtime and the shared Redis cache);
# copilot.tests.test_learned_skills covers it with the fetch mocked.
@override_settings(COPILOT_SKILLS_URL='')
class TriageToolTestBase(TestCase):

    def setUp(self):
        self.org = make_org('Test Cooperative')
        building_a = Building.objects.create(name='Building A', slug='building-a', address='12 Linden Street')
        building_b = Building.objects.create(name='Building B', slug='building-b', address='14 Linden Street')
        self.unit_a4 = Unit.objects.create(building=building_a, number='A/4')
        Unit.objects.create(building=building_a, number='A/1')
        self.unit_b3 = Unit.objects.create(building=building_b, number='B/3')
        Unit.objects.create(building=building_b, number='B/1')
        self.plumbing = Category.objects.create(code=CategoryCode.PLUMBING, name='Plumbing', slug='plumbing')
        self.elevator = Category.objects.create(code=CategoryCode.ELEVATOR, name='Elevators', slug='elevator')
        self.admin_cat = Category.objects.create(code=CategoryCode.BUILDING_ADMIN, name='Administracja budynku',
                                                 slug='building_admin')
        Contractor.objects.create(name='FlowFix Plumbing', slug='flowfix-plumbing', category=self.plumbing, phone='1')
        Contractor.objects.create(name='LiftPro Elevators', slug='liftpro-elevators', category=self.elevator)
        Contractor.objects.create(name='Linden Coop Building Management', slug='linden-coop-building-management', category=self.admin_cat)

        group = Group.objects.create(name=TRIAGE_ADMIN_GROUP)
        group.permissions.add(*[p.perm() for p in triage_admin_permissions()])
        self.org.groups.add(group)
        self.admin = make_member_user(self.org, 'triage-admin')
        OrganizationMember.objects.get(member=self.admin).groups.add(group)

        # may create tickets but not approve them
        self.clerk = make_member_user(self.org, 'clerk')
        for perm in (P.TICKET_ADD, P.TICKET_CHANGE, P.TICKET_VIEW, P.UNIT_VIEW):
            grant(self.org, self.clerk, perm)

        self.denied = make_member_user(self.org, 'nobody')
        self.agent = build_agent(model=TestModel(call_tools=[]))

    def run_tool(self, user, tool_name, tool_args, history=()):
        agent = self.agent
        deps = CopilotDeps(user=user, approvals=collect_approvals(history))

        async def _go():
            with agent.override(model=FunctionModel(_script(tool_name, tool_args))):
                return await agent.run('please help', deps=deps)

        result = async_to_sync(_go)()
        for msg in result.all_messages():
            for part in msg.parts:
                if isinstance(part, ToolReturnPart) and part.tool_name == tool_name:
                    return part.content
        return None


class ReadToolsTest(TriageToolTestBase):

    def test_list_categories(self):
        payload = self.run_tool(self.admin, 'list_categories', {})
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual({c['code'] for c in payload['categories']}, {'plumbing', 'elevator', 'building_admin'})
        self.assertNotIn('id', payload['categories'][0])

    def test_list_categories_denied(self):
        self.assertEqual(self.run_tool(self.denied, 'list_categories', {})['status'], 'permission_denied')

    def test_list_contractors_filtered_by_category(self):
        payload = self.run_tool(self.admin, 'list_contractors', {'category_code': 'plumbing'})
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['contractors'], [{
            'slug': 'flowfix-plumbing', 'name': 'FlowFix Plumbing', 'category_code': 'plumbing', 'phone': '1', 'email': '',
        }])
        self.assertEqual(len(self.run_tool(self.admin, 'list_contractors', {})['contractors']), 3)
        self.assertEqual(self.run_tool(self.admin, 'list_contractors', {'category_code': 'nope'})['status'], 'error')

    def test_list_contractors_denied(self):
        self.assertEqual(self.run_tool(self.denied, 'list_contractors', {})['status'], 'permission_denied')

    def test_find_units_by_number_variants(self):
        for query in ('B/3', 'flat B/3', 'b3', 'B 3'):
            payload = self.run_tool(self.admin, 'find_units', {'query': query})
            self.assertEqual([u['label'] for u in payload['units']], ['B/3'], query)
            self.assertEqual(payload['units'][0]['guid'], str(self.unit_b3.guid))
            self.assertEqual(payload['units'][0]['building'], 'Building B')

    def test_find_units_by_staircase_or_building(self):
        for query in ('stairwell B', 'Building B'):
            labels = [u['label'] for u in self.run_tool(self.admin, 'find_units', {'query': query})['units']]
            self.assertEqual(sorted(labels), ['B/1', 'B/3'], query)
        self.assertEqual(len(self.run_tool(self.admin, 'find_units', {})['units']), 4)

    def test_find_units_denied(self):
        self.assertEqual(self.run_tool(self.denied, 'find_units', {'query': 'A/4'})['status'], 'permission_denied')

    def test_list_tickets(self):
        Ticket.objects.create(unit=self.unit_a4, reporter_name='Anna', description='x' * 300, category=self.plumbing,
                              created_by=self.admin)
        payload = self.run_tool(self.admin, 'list_tickets', {'status': 'new', 'limit': 5})
        self.assertEqual(payload['status'], 'ok')
        row = payload['tickets'][0]
        self.assertEqual(row['unit'], 'A/4')
        self.assertEqual(row['category_code'], 'plumbing')
        self.assertEqual(row['status'], 'new')
        self.assertLessEqual(len(row['description']), 160)
        self.assertNotIn('id', row)
        self.assertEqual(self.run_tool(self.admin, 'list_tickets', {'status': 'proposed'})['tickets'], [])
        self.assertEqual(self.run_tool(self.admin, 'list_tickets', {'status': 'bogus'})['status'], 'error')

    def test_list_tickets_denied(self):
        self.assertEqual(self.run_tool(self.denied, 'list_tickets', {})['status'], 'permission_denied')


class CreateTicketToolTest(TriageToolTestBase):

    PROPOSAL = {'category_code': 'elevator', 'priority': 'high', 'contractor_slug': 'liftpro-elevators',
                'reasoning': 'The elevator stops between floors.'}
    CORRECTED = {'category_code': 'building_admin', 'priority': 'high',
                 'contractor_slug': 'linden-coop-building-management'}

    def _args(self, **overrides):
        args = {
            'unit_guid': str(self.unit_b3.guid), 'reporter_name': 'John Smith',
            'description': 'The elevator in stairwell B stops between floors.',
            'proposal': self.PROPOSAL,
            'final': {k: v for k, v in self.PROPOSAL.items() if k != 'reasoning'},
        }
        args.update(overrides)
        return args

    def _decided(self, args, decision='approved', final=None, comment=None, tool_call_id='call-propose-1'):
        """History in which the admin answered the propose_triage card for ``args``."""
        card_args = {'unit_guid': args['unit_guid'], 'unit_label': 'B/3', 'reporter_name': args['reporter_name'],
                     'description': args['description'], **args['proposal']}
        if args.get('photo_guid'):
            card_args['photo_guid'] = args['photo_guid']
        result = {'decision': decision, 'final': final or args['final'], 'comment': comment}
        return hitl_history('propose_triage', card_args, result, tool_call_id=tool_call_id)

    def _steps(self, ticket):
        return list(TransitionLog.objects.filter(instance=ticket.workflow_instance)
                    .order_by('timestamp', 'pk').values_list('from_state', 'to_state'))

    def test_unconfirmed_creates_nothing(self):
        payload = self.run_tool(self.admin, 'create_ticket', self._args())
        self.assertEqual(payload['status'], 'confirmation_required')
        self.assertFalse(Ticket.objects.exists())

    def test_denied_creates_nothing(self):
        payload = self.run_tool(self.denied, 'create_ticket', self._args(confirmed=True))
        self.assertEqual(payload['status'], 'permission_denied')
        self.assertFalse(Ticket.objects.exists())

    def test_confirmed_approved_as_is(self):
        args = self._args(confirmed=True)
        payload = self.run_tool(self.admin, 'create_ticket', args, history=self._decided(args))
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['state'], 'approved')
        self.assertFalse(payload['was_corrected'])

        ticket = Ticket.objects.get(guid=payload['ticket_guid'])
        self.assertEqual(ticket.status, 'approved')
        self.assertEqual(ticket.category, self.elevator)
        self.assertEqual(ticket.contractor.slug, 'liftpro-elevators')
        self.assertEqual(ticket.priority, 'high')
        self.assertEqual(ticket.ai_suggestion, {'category': 'elevator', 'priority': 'high', 'contractor': 'liftpro-elevators',
                                                'reasoning': self.PROPOSAL['reasoning']})
        self.assertEqual(ticket.admin_correction, {})
        self.assertEqual(ticket.created_by, self.admin)
        self.assertEqual(self._steps(ticket), [('', 'new'), ('new', 'proposed'), ('proposed', 'approved')])
        approve_log = TransitionLog.objects.get(instance=ticket.workflow_instance, to_state='approved')
        self.assertEqual(approve_log.transitioned_by, self.admin)

    def test_confirmed_correction_is_stored(self):
        comment = 'In our cooperative all elevator issues go to building administration'
        args = self._args(final=self.CORRECTED, admin_comment=comment, confirmed=True)
        payload = self.run_tool(self.admin, 'create_ticket', args,
                                history=self._decided(args, 'corrected', self.CORRECTED, comment))
        self.assertEqual(payload['status'], 'ok')
        self.assertTrue(payload['was_corrected'])
        self.assertEqual(payload['state'], 'approved')

        ticket = Ticket.objects.get(guid=payload['ticket_guid'])
        self.assertEqual(ticket.category, self.admin_cat)
        self.assertEqual(ticket.contractor.slug, 'linden-coop-building-management')
        self.assertEqual(ticket.ai_suggestion['category'], 'elevator')  # the AI proposal is kept
        correction = ticket.admin_correction
        self.assertEqual(correction['changed_fields'], {
            'category': {'from': 'elevator', 'to': 'building_admin'},
            'contractor': {'from': 'liftpro-elevators', 'to': 'linden-coop-building-management'},
        })
        self.assertEqual(correction['comment'], 'In our cooperative all elevator issues go to building administration')
        self.assertEqual(correction['corrected_by'], 'triage-admin')
        note = TransitionLog.objects.get(instance=ticket.workflow_instance, to_state='approved').note
        self.assertIn('elevator → building_admin', note)

    def test_correction_requires_comment(self):
        payload = self.run_tool(self.admin, 'create_ticket', self._args(final=self.CORRECTED, confirmed=True))
        self.assertEqual(payload['status'], 'error')
        self.assertFalse(Ticket.objects.exists())

    def test_user_without_approve_stops_at_proposed(self):
        args = self._args(confirmed=True)
        payload = self.run_tool(self.clerk, 'create_ticket', args, history=self._decided(args))
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['state'], 'proposed')
        self.assertIn('Triage Admin', payload['message'])
        ticket = Ticket.objects.get(guid=payload['ticket_guid'])
        self.assertEqual(self._steps(ticket), [('', 'new'), ('new', 'proposed')])

    def test_contractor_must_match_category(self):
        payload = self.run_tool(self.admin, 'create_ticket', self._args(
            final={'category_code': 'building_admin', 'priority': 'high', 'contractor_slug': 'liftpro-elevators'},
            admin_comment='x', confirmed=True))
        self.assertEqual(payload['status'], 'error')
        self.assertFalse(Ticket.objects.exists())

    def test_unknown_unit_and_integer_ids_rejected(self):
        for unit_guid in ('42', 'not-a-guid', '00000000-0000-0000-0000-000000000000'):
            payload = self.run_tool(self.admin, 'create_ticket', self._args(unit_guid=unit_guid, confirmed=True))
            self.assertEqual(payload['status'], 'not_found', unit_guid)
        self.assertFalse(Ticket.objects.exists())

    def test_confirmed_without_admin_decision_creates_nothing(self):
        # The model claims confirmed=true, but the admin never answered a propose_triage card.
        payload = self.run_tool(self.admin, 'create_ticket', self._args(confirmed=True))
        self.assertEqual(payload['status'], 'confirmation_required')
        self.assertFalse(Ticket.objects.exists())

    def test_confirmed_with_values_other_than_the_decision_creates_nothing(self):
        approved = self._args(confirmed=True)
        swapped = self._args(final=self.CORRECTED, admin_comment='x', confirmed=True)
        payload = self.run_tool(self.admin, 'create_ticket', swapped, history=self._decided(approved))
        self.assertEqual(payload['status'], 'confirmation_required')
        other_unit = self._args(unit_guid=str(self.unit_a4.guid), confirmed=True)
        payload = self.run_tool(self.admin, 'create_ticket', other_unit, history=self._decided(approved))
        self.assertEqual(payload['status'], 'confirmation_required')
        self.assertFalse(Ticket.objects.exists())

    def test_rejected_decision_does_not_authorise(self):
        args = self._args(confirmed=True)
        history = hitl_history('propose_triage', {'unit_guid': args['unit_guid'], **args['proposal']},
                               {'decision': 'rejected', 'final': args['final']})
        payload = self.run_tool(self.admin, 'create_ticket', args, history=history)
        self.assertEqual(payload['status'], 'confirmation_required')
        self.assertFalse(Ticket.objects.exists())

    def test_one_decision_creates_one_ticket(self):
        args = self._args(confirmed=True)
        history = self._decided(args) + hitl_history('create_ticket', args, {'status': 'ok'}, tool_call_id='call-create-1')
        payload = self.run_tool(self.admin, 'create_ticket', args, history=history)
        self.assertEqual(payload['status'], 'confirmation_required')
        self.assertFalse(Ticket.objects.exists())

    def test_admin_comment_comes_from_the_decision(self):
        args = self._args(final=self.CORRECTED, admin_comment='model paraphrase', confirmed=True)
        payload = self.run_tool(self.admin, 'create_ticket', args,
                                history=self._decided(args, 'corrected', self.CORRECTED, 'the admin words'))
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(Ticket.objects.get().admin_correction['comment'], 'the admin words')


@override_settings(STORAGES=IN_MEMORY_STORAGES)
class PhotoTest(TriageToolTestBase):

    def _run_input(self, *content):
        return AGUIAdapter.build_run_input(json.dumps({
            'threadId': 't1', 'runId': 'r1', 'state': {}, 'tools': [], 'context': [], 'forwardedProps': {},
            'messages': [{'id': 'm1', 'role': 'user', 'content': list(content)}],
        }).encode())

    def _image_part(self, b64=None):
        return {'type': 'image', 'source': {'type': 'data', 'value': b64 or _png_b64(), 'mimeType': 'image/png'}}

    def test_annotate_stores_photo_once_and_adds_guid_note(self):
        run_input = self._run_input({'type': 'text', 'text': 'Cieknie rura'}, self._image_part())
        self.assertEqual(annotate_run_input_photos(run_input, self.admin), 1)
        photo = TicketPhoto.objects.get()
        self.assertEqual(photo.created_by, self.admin)
        self.assertTrue(photo.image.name.endswith('.png'))
        parts = run_input.messages[0].content
        self.assertEqual([p.type for p in parts], ['text', 'image', 'text'])
        self.assertIn(str(photo.guid), parts[2].text)

        # AG-UI replays the thread: the same image maps to the same photo
        replay = self._run_input({'type': 'text', 'text': 'Cieknie rura'}, self._image_part())
        annotate_run_input_photos(replay, self.admin)
        self.assertEqual(TicketPhoto.objects.count(), 1)
        self.assertIn(str(photo.guid), replay.messages[0].content[2].text)

    def test_annotate_skips_users_without_ticket_add_and_non_images(self):
        run_input = self._run_input(self._image_part())
        self.assertEqual(annotate_run_input_photos(run_input, self.denied), 0)
        bogus = self._run_input(self._image_part(base64.b64encode(b'not an image').decode()))
        self.assertEqual(annotate_run_input_photos(bogus, self.admin), 0)
        self.assertFalse(TicketPhoto.objects.exists())

    def test_create_ticket_links_photo(self):
        run_input = self._run_input(self._image_part())
        annotate_run_input_photos(run_input, self.admin)
        photo = TicketPhoto.objects.get()
        final = {'category_code': 'plumbing', 'priority': 'normal', 'contractor_slug': 'flowfix-plumbing'}
        card = {'unit_guid': str(self.unit_a4.guid), **final, 'photo_guid': str(photo.guid)}
        payload = self.run_tool(self.admin, 'create_ticket', {
            'unit_guid': str(self.unit_a4.guid), 'reporter_name': 'Anna Novak', 'description': 'Dripping tap',
            'proposal': {**final, 'reasoning': 'Kran'}, 'final': final,
            'photo_guid': str(photo.guid), 'confirmed': True,
        }, history=hitl_history('propose_triage', card, {'decision': 'approved', 'final': final}))
        self.assertEqual(payload['status'], 'ok')
        self.assertTrue(payload['has_photo'])
        self.assertEqual(Ticket.objects.get(guid=payload['ticket_guid']).photo.name, photo.image.name)

    def test_create_ticket_rejects_foreign_photo(self):
        annotate_run_input_photos(self._run_input(self._image_part()), self.clerk)
        photo = TicketPhoto.objects.get()
        payload = self.run_tool(self.admin, 'create_ticket', {
            'unit_guid': str(self.unit_a4.guid), 'reporter_name': 'Anna Novak', 'description': 'Dripping tap',
            'proposal': {'category_code': 'plumbing', 'priority': 'normal', 'contractor_slug': 'flowfix-plumbing'},
            'final': {'category_code': 'plumbing', 'priority': 'normal', 'contractor_slug': 'flowfix-plumbing'},
            'photo_guid': str(photo.guid), 'confirmed': True,
        })
        self.assertEqual(payload['status'], 'not_found')
        self.assertFalse(Ticket.objects.exists())


@override_settings(
    STORAGES=IN_MEMORY_STORAGES,
    DEBUG_TOOLBAR_CONFIG={'SHOW_TOOLBAR_CALLBACK': lambda request: False, 'IS_RUNNING_TESTS': False},
)
class PhotoReachesModelThroughViewTest(TriageToolTestBase):
    """End to end through the AG-UI view: an image attachment reaches the model as BinaryContent,
    followed by the photo_guid note."""

    def test_image_attachment_is_model_input(self):
        from unittest import mock

        seen = {}

        async def stream_fn(messages, info):
            prompt = next(p for m in messages for p in m.parts if isinstance(p, UserPromptPart))
            seen['content'] = prompt.content
            yield 'ok'

        agent = build_agent(model=FunctionModel(stream_function=stream_fn))
        self.client.force_login(self.admin)
        body = {
            'threadId': 't1', 'runId': 'r1', 'state': {}, 'tools': [], 'context': [], 'forwardedProps': {},
            'messages': [{'id': 'm1', 'role': 'user', 'content': [
                {'type': 'text', 'text': 'Co to za usterka?'},
                {'type': 'image', 'source': {'type': 'data', 'value': _png_b64(), 'mimeType': 'image/png'}},
            ]}],
        }
        with mock.patch('copilot.views.get_agent', return_value=agent):
            resp = self.client.post('/app/copilot/agui/', data=json.dumps(body), content_type='application/json')
            self.assertEqual(resp.status_code, 200)

            async def _drain(stream):
                return b''.join([chunk async for chunk in stream])

            events = async_to_sync(_drain)(resp.streaming_content)
        self.assertIn(b'RUN_FINISHED', events)

        content = seen['content']
        images = [c for c in content if isinstance(c, BinaryContent)]
        self.assertEqual(len(images), 1)
        self.assertTrue(images[0].is_image)
        photo = TicketPhoto.objects.get()
        self.assertTrue(any(isinstance(c, str) and str(photo.guid) in c for c in content))


class TriagePromptTest(TestCase):

    def test_prompt_drives_triage_flow(self):
        for needle in ('Linden Street Housing Cooperative', 'find_units', 'list_categories', 'list_contractors',
                       'propose_triage', 'create_ticket', 'confirmed=true', 'admin_comment'):
            self.assertIn(needle, SYSTEM_PROMPT)

    def test_prompt_does_not_encode_the_learning_demo_rule(self):
        # The demo depends on the agent learning "elevators → building administration" from one correction.
        lowered = SYSTEM_PROMPT.lower()
        for forbidden in ('elevator', 'winda', 'windy', 'dźwig', 'dzwig', 'lift'):
            self.assertNotIn(forbidden, lowered)

    def test_propose_triage_is_not_a_backend_tool(self):
        agent = build_agent(model=TestModel(call_tools=[]))
        names = set(agent._function_toolset.tools)
        self.assertNotIn('propose_triage', names)
        self.assertIn('create_ticket', names)
