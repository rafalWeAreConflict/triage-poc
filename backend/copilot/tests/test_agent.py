"""Tool-level tests: permission gating (allowed + denied) and HITL transitions.

The agent is driven by a FunctionModel that scripts exactly one tool call and
then a final text turn, so no live LLM is ever contacted. Assertions are made
against the real database and against the tool's returned payload.
"""
from asgiref.sync import async_to_sync
from config.roles_gen import P
from copilot.agent import SYSTEM_PROMPT, CopilotDeps, build_agent
from copilot.approvals import collect_approvals
from copilot.tests.support import grant, hitl_history, make_member_user, make_org
from core.schema.common import GlobalIDUtils
from django.test import TestCase
from forms.models import FormDefinition, FormStatus
from pydantic_ai import ModelResponse, TextPart, ToolCallPart, models
from pydantic_ai.messages import SystemPromptPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel
from workflows.models import WorkflowDefinition, WorkflowInstance

# Belt-and-suspenders: forbid any accidental real model request.
models.ALLOW_MODEL_REQUESTS = False


def _script(tool_name, tool_args):
    """FunctionModel body: call one tool once, then answer with plain text."""
    def fn(messages, info):
        already_called = any(
            isinstance(p, ToolReturnPart) for m in messages for p in m.parts
        )
        if already_called:
            return ModelResponse(parts=[TextPart('done')])
        return ModelResponse(parts=[ToolCallPart(tool_name=tool_name, args=tool_args)])
    return fn


class CopilotToolTestBase(TestCase):

    def setUp(self):
        self.org = make_org()
        self.allowed = make_member_user(self.org, 'allowed')
        self.denied = make_member_user(self.org, 'denied')
        # The placeholder model is never used — every run overrides it.
        self.agent = build_agent(model=TestModel(call_tools=[]))

    def run_tool(self, user, tool_name, tool_args, history=()):
        deps = CopilotDeps(user=user, approvals=collect_approvals(history))
        fn_model = FunctionModel(_script(tool_name, tool_args))
        agent = self.agent

        async def _go():
            with agent.override(model=fn_model):
                return await agent.run('please help', deps=deps)

        result = async_to_sync(_go)()
        return self._tool_return(result, tool_name)

    @staticmethod
    def _tool_return(result, tool_name):
        for msg in result.all_messages():
            for part in msg.parts:
                if isinstance(part, ToolReturnPart) and part.tool_name == tool_name:
                    return part.content
        return None


class DraftFormDefinitionToolTest(CopilotToolTestBase):

    SCHEMA = {
        'type': 'object',
        'properties': {'email': {'type': 'string', 'format': 'email'}},
        'required': ['email'],
    }

    def test_draft_allowed_creates_draft(self):
        grant(self.org, self.allowed, P.FORMDEFINITION_ADD)
        payload = self.run_tool(self.allowed, 'draft_form_definition', {
            'name': 'Contact', 'slug': 'contact',
            'description': 'Contact us', 'schema': self.SCHEMA,
        })
        self.assertEqual(payload['status'], 'created')
        self.assertEqual(payload['slug'], 'contact')
        self.assertEqual(payload['form_status'], FormStatus.DRAFT)

        # Exactly one draft row, in draft state, owned by the acting user.
        # (The engine's Tracking base owns the version number, so assert the
        # tool reports whatever it persisted rather than a hardcoded value.)
        forms = FormDefinition.objects.filter(slug='contact')
        self.assertEqual(forms.count(), 1)
        form = forms.get()
        self.assertEqual(form.status, FormStatus.DRAFT)
        self.assertEqual(form.created_by_id, self.allowed.pk)
        self.assertEqual(payload['version'], form.version)

    def test_draft_denied_makes_no_row(self):
        payload = self.run_tool(self.denied, 'draft_form_definition', {
            'name': 'Contact', 'slug': 'contact',
            'description': '', 'schema': self.SCHEMA,
        })
        self.assertEqual(payload['status'], 'permission_denied')
        self.assertFalse(FormDefinition.objects.filter(slug='contact').exists())


class ListFormDefinitionsToolTest(CopilotToolTestBase):

    def setUp(self):
        super().setUp()
        FormDefinition.objects.create(
            name='Alpha', slug='alpha', schema={}, version=1, status=FormStatus.DRAFT,
        )

    def test_list_allowed(self):
        grant(self.org, self.allowed, P.FORMDEFINITION_VIEW)
        payload = self.run_tool(self.allowed, 'list_form_definitions', {})
        self.assertEqual(payload['status'], 'ok')
        self.assertTrue(any(f['slug'] == 'alpha' for f in payload['forms']))

    def test_list_denied(self):
        payload = self.run_tool(self.denied, 'list_form_definitions', {})
        self.assertEqual(payload['status'], 'permission_denied')


class WorkflowTransitionToolTest(CopilotToolTestBase):

    def setUp(self):
        super().setUp()
        self.wf = WorkflowDefinition.objects.create(
            name='Doc Review', slug='doc-review', model_label='forms.FormDefinition',
            states=[
                {'name': 'draft', 'label': 'Draft', 'is_initial': True},
                {'name': 'submitted', 'label': 'Submitted'},
                {'name': 'approved', 'label': 'Approved', 'is_final': True},
            ],
            transitions=[
                {'from_state': 'draft', 'to_state': 'submitted', 'label': 'Submit'},
                {'from_state': 'submitted', 'to_state': 'approved', 'label': 'Approve'},
            ],
        )
        self.target = FormDefinition.objects.create(
            name='Doc', slug='doc', schema={}, version=1,
        )
        self.instance = WorkflowInstance.start(self.wf, self.target, self.allowed)
        self.instance_ref = GlobalIDUtils.to_global_id('WorkflowInstance', self.instance.pk)

    def test_unconfirmed_does_not_transition(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_CHANGE)
        payload = self.run_tool(self.allowed, 'execute_workflow_transition', {
            'instance_ref': self.instance_ref, 'to_state': 'submitted', 'confirmed': False,
        })
        self.assertEqual(payload['status'], 'confirmation_required')
        # Explicit pass-through fields the frontend confirm tool renders (FIX 3).
        self.assertEqual(payload['workflow_name'], 'Doc Review')
        self.assertEqual(payload['from_state'], 'draft')
        self.assertEqual(payload['from_state_label'], 'Draft')
        self.assertEqual(payload['to_state'], 'submitted')
        self.assertEqual(payload['to_state_label'], 'Submitted')
        self.assertEqual(payload['label'], 'Submit')

        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'draft')
        self.assertEqual(self.instance.transition_logs.count(), 1)

    def _approved(self, to_state_label='Submitted', approved=True, instance_ref=None):
        """History in which the human answered confirm_workflow_transition."""
        return hitl_history('confirm_workflow_transition', {
            'instance_ref': instance_ref or self.instance_ref, 'workflow_name': 'Doc Review',
            'from_state_label': 'Draft', 'to_state_label': to_state_label, 'label': 'Submit',
        }, {'approved': approved})

    def test_confirmed_transitions(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_CHANGE)
        payload = self.run_tool(self.allowed, 'execute_workflow_transition', {
            'instance_ref': self.instance_ref, 'to_state': 'submitted', 'confirmed': True,
        }, history=self._approved())
        self.assertEqual(payload['status'], 'executed')
        self.assertEqual(payload['from_state'], 'draft')
        self.assertEqual(payload['to_state'], 'submitted')

        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'submitted')
        self.assertEqual(self.instance.transition_logs.count(), 2)

    def test_confirmed_without_human_approval_no_change(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_CHANGE)
        args = {'instance_ref': self.instance_ref, 'to_state': 'submitted', 'confirmed': True}
        for history in ((), self._approved(approved=False), self._approved(to_state_label='Approved')):
            payload = self.run_tool(self.allowed, 'execute_workflow_transition', args, history=history)
            self.assertEqual(payload['status'], 'confirmation_required')
        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'draft')
        self.assertEqual(self.instance.transition_logs.count(), 1)

    def test_approval_is_spent_by_the_transition_it_authorised(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_CHANGE)
        args = {'instance_ref': self.instance_ref, 'to_state': 'submitted', 'confirmed': True}
        executed = hitl_history('execute_workflow_transition', args,
                                {'status': 'executed', 'instance_ref': self.instance_ref}, tool_call_id='call-exec-1')
        payload = self.run_tool(self.allowed, 'execute_workflow_transition', args, history=self._approved() + executed)
        self.assertEqual(payload['status'], 'confirmation_required')
        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'draft')

    def test_confirmed_denied_no_change(self):
        payload = self.run_tool(self.denied, 'execute_workflow_transition', {
            'instance_ref': self.instance_ref, 'to_state': 'submitted', 'confirmed': True,
        })
        self.assertEqual(payload['status'], 'permission_denied')

        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'draft')
        self.assertEqual(self.instance.transition_logs.count(), 1)

    def test_list_workflow_states_allowed(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_VIEW)
        object_ref = GlobalIDUtils.to_global_id('FormDefinition', self.target.pk)
        payload = self.run_tool(self.allowed, 'list_workflow_states', {
            'model_label': 'forms.FormDefinition', 'object_ref': object_ref,
        })
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(len(payload['instances']), 1)
        self.assertEqual(payload['instances'][0]['current_state'], 'draft')
        self.assertEqual(payload['instances'][0]['instance_ref'], self.instance_ref)

    def test_list_workflow_states_denied(self):
        object_ref = GlobalIDUtils.to_global_id('FormDefinition', self.target.pk)
        payload = self.run_tool(self.denied, 'list_workflow_states', {
            'model_label': 'forms.FormDefinition', 'object_ref': object_ref,
        })
        self.assertEqual(payload['status'], 'permission_denied')

    def test_execute_bare_digit_ref_rejected(self):
        # A raw integer PK must be refused (no enumeration) and the agent run
        # must complete normally rather than raising (FIX 2).
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_CHANGE)
        payload = self.run_tool(self.allowed, 'execute_workflow_transition', {
            'instance_ref': str(self.instance.pk), 'to_state': 'submitted', 'confirmed': False,
        })
        self.assertEqual(payload['status'], 'error')
        self.assertIn('reference ids', payload['message'])
        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'draft')

    def test_execute_malformed_ref_not_found(self):
        # An undecodable ref becomes a not_found tool result, not a crash (FIX 2).
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_CHANGE)
        payload = self.run_tool(self.allowed, 'execute_workflow_transition', {
            'instance_ref': 'garbage-not-base64!!', 'to_state': 'submitted', 'confirmed': True,
        })
        self.assertEqual(payload['status'], 'not_found')
        self.instance.refresh_from_db()
        self.assertEqual(self.instance.current_state, 'draft')

    def test_list_workflow_states_bare_digit_object_ref_rejected(self):
        # The strict decode also guards the object_ref path (FIX 2).
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_VIEW)
        payload = self.run_tool(self.allowed, 'list_workflow_states', {
            'model_label': 'forms.FormDefinition', 'object_ref': str(self.target.pk),
        })
        self.assertEqual(payload['status'], 'error')
        self.assertIn('reference ids', payload['message'])


class GetFormDefinitionToolTest(CopilotToolTestBase):

    def setUp(self):
        super().setUp()
        FormDefinition.objects.create(
            name='Beta', slug='beta', schema={'type': 'object'}, version=1,
            status=FormStatus.DRAFT,
        )

    def test_get_allowed(self):
        grant(self.org, self.allowed, P.FORMDEFINITION_VIEW)
        payload = self.run_tool(self.allowed, 'get_form_definition', {'slug': 'beta'})
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['slug'], 'beta')
        self.assertEqual(payload['schema'], {'type': 'object'})

    def test_get_denied(self):
        payload = self.run_tool(self.denied, 'get_form_definition', {'slug': 'beta'})
        self.assertEqual(payload['status'], 'permission_denied')


class ListAvailableTransitionsToolTest(CopilotToolTestBase):

    def setUp(self):
        super().setUp()
        self.wf = WorkflowDefinition.objects.create(
            name='Doc Review', slug='doc-review', model_label='forms.FormDefinition',
            states=[
                {'name': 'draft', 'label': 'Draft', 'is_initial': True},
                {'name': 'submitted', 'label': 'Submitted', 'is_final': True},
            ],
            transitions=[
                {'from_state': 'draft', 'to_state': 'submitted', 'label': 'Submit'},
            ],
        )
        self.target = FormDefinition.objects.create(name='Doc', slug='doc', schema={}, version=1)
        self.instance = WorkflowInstance.start(self.wf, self.target, self.allowed)
        self.instance_ref = GlobalIDUtils.to_global_id('WorkflowInstance', self.instance.pk)

    def test_list_available_transitions_allowed(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_VIEW)
        payload = self.run_tool(self.allowed, 'list_available_transitions', {
            'instance_ref': self.instance_ref,
        })
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['current_state'], 'draft')
        self.assertTrue(any(t['to_state'] == 'submitted' for t in payload['available_transitions']))

    def test_list_available_transitions_denied(self):
        payload = self.run_tool(self.denied, 'list_available_transitions', {
            'instance_ref': self.instance_ref,
        })
        self.assertEqual(payload['status'], 'permission_denied')

    def test_list_available_transitions_malformed_ref_not_found(self):
        grant(self.org, self.allowed, P.WORKFLOWINSTANCE_VIEW)
        payload = self.run_tool(self.allowed, 'list_available_transitions', {
            'instance_ref': 'not-a-real-ref!!',
        })
        self.assertEqual(payload['status'], 'not_found')


class AgentPromptAndToolSetTest(TestCase):
    """The agent sends the system prompt and exposes exactly the backend tool set; the frontend
    tools (confirm_workflow_transition, propose_triage) are advertised by CopilotKit instead."""

    EXPECTED_BACKEND_TOOLS = {
        'list_form_definitions',
        'get_form_definition',
        'draft_form_definition',
        'list_workflow_states',
        'list_available_transitions',
        'execute_workflow_transition',
        # triage (copilot/triage_tools.py)
        'list_categories',
        'list_contractors',
        'find_units',
        'list_tickets',
        'create_ticket',
    }

    def test_prompt_no_longer_mentions_removed_show_form_definitions_tool(self):
        self.assertNotIn('show_form_definitions', SYSTEM_PROMPT)
        self.assertIn('confirm_workflow_transition', SYSTEM_PROMPT)
        self.assertIn('propose_triage', SYSTEM_PROMPT)

    def test_agent_sends_prompt_and_keeps_backend_tool_set(self):
        seen = {}

        def fn(messages, info):
            seen['tools'] = {t.name for t in info.function_tools}
            seen['system'] = ''.join(
                p.content for m in messages for p in m.parts if isinstance(p, SystemPromptPart))
            return ModelResponse(parts=[TextPart('done')])

        org = make_org()
        user = make_member_user(org, 'prompt_user')
        agent = build_agent(model=TestModel(call_tools=[]))

        async def _go():
            with agent.override(model=FunctionModel(fn)):
                return await agent.run('show me the forms', deps=CopilotDeps(user=user))

        async_to_sync(_go)()
        self.assertEqual(seen['tools'], self.EXPECTED_BACKEND_TOOLS)
        self.assertNotIn('show_form_definitions', seen['tools'])
        self.assertIn('confirm_workflow_transition', seen['system'])
