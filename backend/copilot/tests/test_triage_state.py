"""AG-UI shared state of the triage screen (copilot.triage_state).

CopilotDeps implements Pydantic AI's StateHandler; create_ticket returns a ToolReturn whose metadata is a
STATE_SNAPSHOT; the view's stream wrapper seeds the ticket list at run start and turns the propose_triage
frontend tool call into the draft. FunctionModel scripts only, never a live LLM.
"""
import json
from unittest import mock

from ag_ui.core import EventType, StateSnapshotEvent, ToolMessage, UserMessage
from asgiref.sync import async_to_sync
from copilot.agent import CopilotDeps, build_agent
from copilot.approvals import collect_approvals
from copilot.tests.support import hitl_history
from copilot.tests.test_triage_tools import TriageToolTestBase
from copilot.triage_state import reconcile_draft
from django.test import SimpleTestCase, override_settings
from pydantic_ai import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.ui import StateHandler
from triage.models import Ticket

PROPOSAL = {'category_code': 'plumbing', 'priority': 'normal', 'contractor_slug': 'flowfix-plumbing', 'reasoning': 'Tap.'}
FINAL = {k: v for k, v in PROPOSAL.items() if k != 'reasoning'}


def _create_args(unit):
    return {'unit_guid': str(unit.guid), 'reporter_name': 'Anna Novak', 'description': 'The kitchen tap keeps dripping',
            'proposal': PROPOSAL, 'final': FINAL, 'confirmed': True}


def _drain(resp):
    async def _go(stream):
        return b''.join([chunk async for chunk in stream])
    return async_to_sync(_go)(resp.streaming_content)


def _events(raw: bytes) -> list[dict]:
    return [json.loads(line[len(b'data: '):]) for line in raw.splitlines() if line.startswith(b'data: ')]


class DepsStateHandlerTest(SimpleTestCase):

    def test_copilot_deps_is_a_state_handler(self):
        deps = CopilotDeps(user=mock.sentinel.user)
        self.assertIsInstance(deps, StateHandler)
        self.assertEqual(deps.state, {})
        self.assertIsNot(deps.state, CopilotDeps(user=mock.sentinel.user).state)


class ReconcileDraftTest(SimpleTestCase):

    DRAFT = {'tool_call_id': 'call_1', 'unit_label': 'A/4', 'status': 'awaiting_decision'}

    def _answer(self, decision='approved'):
        return ToolMessage(id='t1', role='tool', tool_call_id='call_1', content=json.dumps({'decision': decision}))

    def test_unanswered_draft_is_kept(self):
        self.assertEqual(reconcile_draft(self.DRAFT, [UserMessage(id='u1', role='user', content='x')]), self.DRAFT)

    def test_answer_as_last_message_sets_the_decision(self):
        self.assertEqual(reconcile_draft(self.DRAFT, [self._answer('corrected')])['status'], 'corrected')

    def test_answer_followed_by_a_new_turn_drops_the_draft(self):
        messages = [self._answer(), UserMessage(id='u2', role='user', content='another request')]
        self.assertIsNone(reconcile_draft(self.DRAFT, messages))

    def test_missing_or_invalid_draft(self):
        self.assertIsNone(reconcile_draft(None, []))
        self.assertIsNone(reconcile_draft({'unit_label': 'A/4'}, []))


class CreateTicketEmitsStateTest(TriageToolTestBase):

    def _run(self, user, args, state=None):
        agent = build_agent(model=FunctionModel(_script_fn('create_ticket', args)))
        decided = hitl_history('propose_triage', {'unit_guid': args['unit_guid'], **args['proposal']},
                               {'decision': 'approved', 'final': args['final']})
        deps = CopilotDeps(user=user, state=state if state is not None else {}, approvals=collect_approvals(decided))
        result = async_to_sync(agent.run)('go', deps=deps)
        part = next(p for m in result.all_messages() for p in m.parts
                    if isinstance(p, ToolReturnPart) and p.tool_name == 'create_ticket')
        return part, deps

    def test_snapshot_after_create_ticket(self):
        old = Ticket.objects.create(unit=self.unit_b3, reporter_name='Jan', description='stare', created_by=self.admin)
        part, deps = self._run(self.admin, _create_args(self.unit_a4), state={'draft': {'tool_call_id': 'c1'}})
        self.assertEqual(part.content['status'], 'ok')  # the model still sees the plain result
        events = part.metadata
        self.assertEqual(len(events), 1)
        self.assertIsInstance(events[0], StateSnapshotEvent)
        snapshot = events[0].snapshot
        new_guid = part.content['ticket_guid']
        self.assertEqual([t['guid'] for t in snapshot['tickets']], [new_guid, str(old.guid)])
        row = snapshot['tickets'][0]
        self.assertEqual(row['unit'], 'A/4')
        self.assertEqual(row['category_name'], 'Plumbing')
        self.assertEqual(row['contractor_name'], 'FlowFix Plumbing')
        self.assertEqual(row['status'], 'approved')
        self.assertFalse(row['was_corrected'])
        self.assertNotIn('id', row)
        self.assertIsNone(snapshot['draft'])
        self.assertEqual(snapshot['last_created_guid'], new_guid)
        self.assertIn('last_updated', snapshot)
        self.assertEqual(deps.state, snapshot)  # deps.state carries the change into later snapshots

    def test_failed_create_ticket_emits_no_state(self):
        args = {**_create_args(self.unit_a4), 'confirmed': False}
        part, deps = self._run(self.admin, args)
        self.assertEqual(part.content['status'], 'confirmation_required')
        self.assertIsNone(part.metadata)
        self.assertEqual(deps.state, {})


def _script_fn(tool_name, tool_args):
    def fn(messages, info):
        if any(isinstance(p, ToolReturnPart) for m in messages for p in m.parts):
            return ModelResponse(parts=[TextPart('done')])
        return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=tool_args)])
    return fn


@override_settings(DEBUG_TOOLBAR_CONFIG={'SHOW_TOOLBAR_CALLBACK': lambda request: False, 'IS_RUNNING_TESTS': False})
class StateThroughViewTest(TriageToolTestBase):
    """End to end through the AG-UI view: STATE_SNAPSHOT events in the SSE stream."""

    PROPOSE_TOOL = {'name': 'propose_triage', 'description': 'Show the triage card.', 'parameters': {
        'type': 'object', 'properties': {k: {'type': 'string'} for k in (
            'unit_guid', 'unit_label', 'reporter_name', 'description', 'category_code', 'priority',
            'contractor_slug', 'reasoning')},
    }}

    def _post(self, stream_fn, state=None, tools=(), messages=None):
        agent = build_agent(model=FunctionModel(stream_function=stream_fn))
        self.client.force_login(self.admin)
        body = {
            'threadId': 't1', 'runId': 'r1', 'state': state or {}, 'tools': list(tools), 'context': [],
            'forwardedProps': {},
            'messages': messages or [{'id': 'm1', 'role': 'user', 'content': 'The kitchen tap in flat A/4 keeps dripping'}],
        }
        with mock.patch('copilot.views.get_agent', return_value=agent):
            resp = self.client.post('/app/copilot/agui/', data=json.dumps(body), content_type='application/json')
            self.assertEqual(resp.status_code, 200)
            return _events(_drain(resp))

    def _snapshots(self, events):
        return [e['snapshot'] for e in events if e['type'] == EventType.STATE_SNAPSHOT.value]

    def test_run_start_seeds_tickets(self):
        Ticket.objects.create(unit=self.unit_b3, reporter_name='John', description='Door is leaking', created_by=self.admin)

        async def stream_fn(messages, info):
            yield 'Hej'

        events = self._post(stream_fn)
        types = [e['type'] for e in events]
        self.assertEqual(types[:2], ['RUN_STARTED', 'STATE_SNAPSHOT'])
        seeded = self._snapshots(events)[0]
        self.assertEqual([t['unit'] for t in seeded['tickets']], ['B/3'])
        self.assertIsNone(seeded['draft'])

    def test_frontend_state_is_received_and_refreshed(self):
        state = {'tickets': [{'guid': 'stale'}], 'draft': None, 'ui_note': 'kept'}

        async def stream_fn(messages, info):
            yield 'ok'

        seeded = self._snapshots(self._post(stream_fn, state=state))[0]
        self.assertEqual(seeded['tickets'], [])  # refreshed from the database
        self.assertEqual(seeded['ui_note'], 'kept')  # the frontend's other keys survive

    def test_propose_triage_call_becomes_the_draft(self):
        args = {'unit_guid': str(self.unit_a4.guid), 'unit_label': 'A/4', 'reporter_name': 'Anna Novak',
                'description': 'Cieknie kran w kuchni', 'category_code': 'plumbing', 'priority': 'normal',
                'contractor_slug': 'flowfix-plumbing', 'reasoning': 'Typical plumbing defect.'}

        async def stream_fn(messages, info):
            yield {0: DeltaToolCall(name='propose_triage', json_args=json.dumps(args), tool_call_id='call_p1')}

        events = self._post(stream_fn, tools=[self.PROPOSE_TOOL])
        draft = self._snapshots(events)[-1]['draft']
        self.assertEqual(draft['tool_call_id'], 'call_p1')
        self.assertEqual(draft['unit_label'], 'A/4')
        self.assertEqual(draft['category_name'], 'Plumbing')
        self.assertEqual(draft['contractor_name'], 'FlowFix Plumbing')
        self.assertEqual(draft['status'], 'awaiting_decision')
        end = next(i for i, e in enumerate(events) if e['type'] == 'TOOL_CALL_END')
        snap = max(i for i, e in enumerate(events) if e['type'] == 'STATE_SNAPSHOT')
        self.assertGreater(snap, end)
        self.assertFalse(Ticket.objects.exists())

    def test_create_ticket_snapshot_follows_the_tool_result(self):
        args = _create_args(self.unit_a4)

        async def stream_fn(messages, info):
            if any(isinstance(p, ToolReturnPart) and p.tool_name == 'create_ticket' for m in messages for p in m.parts):
                yield 'Utworzono.'
            else:
                yield {0: DeltaToolCall(name='create_ticket', json_args=json.dumps(args), tool_call_id='call_c1')}

        draft = {'tool_call_id': 'call_p1', 'unit_label': 'A/4', 'status': 'awaiting_decision'}
        messages = [
            {'id': 'm1', 'role': 'user', 'content': 'Cieknie kran'},
            {'id': 'a1', 'role': 'assistant', 'content': '', 'toolCalls': [{
                'id': 'call_p1', 'type': 'function', 'function': {'name': 'propose_triage', 'arguments': json.dumps({'unit_guid': args['unit_guid'], **PROPOSAL})}}]},
            {'id': 't1', 'role': 'tool', 'toolCallId': 'call_p1',
             'content': json.dumps({'decision': 'approved', 'final': FINAL})},
        ]
        events = self._post(stream_fn, state={'draft': draft}, tools=[self.PROPOSE_TOOL], messages=messages)
        snapshots = self._snapshots(events)
        self.assertEqual(snapshots[0]['draft']['status'], 'approved')  # run start: the admin's answer
        ticket = Ticket.objects.get()
        result = next(i for i, e in enumerate(events) if e['type'] == 'TOOL_CALL_RESULT'
                      and e['toolCallId'] == 'call_c1')
        self.assertEqual(events[result + 1]['type'], 'STATE_SNAPSHOT')
        final = events[result + 1]['snapshot']
        self.assertIsNone(final['draft'])
        self.assertEqual(final['last_created_guid'], str(ticket.guid))
        self.assertEqual(final['tickets'][0]['guid'], str(ticket.guid))
