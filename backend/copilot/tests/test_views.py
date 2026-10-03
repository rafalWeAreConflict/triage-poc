"""Endpoint tests: the AG-UI view's session-auth gate.

These exercise the real view through Django's test client (full middleware
stack) and assert the auth boundary without contacting a model:
- anonymous POST is rejected before any model call,
- an authenticated request gets past the auth gate to payload validation.
"""
import importlib
import os
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import NoReverseMatch, clear_url_caches, reverse
from pydantic_ai import models

User = get_user_model()
models.ALLOW_MODEL_REQUESTS = False

# A real cache is required to exercise rate limiting: the Tests configuration
# uses DummyCache, under which django_ratelimit counts nothing (every add()
# "succeeds", so the counter never climbs).
_LOCMEM_CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        'LOCATION': 'copilot-ratelimit-test',
    },
    'memory_cache': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
    },
}


# The dev-only Debug Toolbar middleware tries to render itself into responses
# when DEBUG is on (it is, under the Tests configuration); disable it here so
# these tests exercise the endpoint's auth behaviour, not the toolbar.
@override_settings(
    DEBUG_TOOLBAR_CONFIG={
        'SHOW_TOOLBAR_CALLBACK': lambda request: False,
        'IS_RUNNING_TESTS': False,
    },
)
class CopilotEndpointAuthTest(TestCase):

    URL = '/app/copilot/agui/'

    def setUp(self):
        self.user = User.objects.create_user(
            username='cop', email='cop@test.com', password='x',
        )

    def test_get_not_allowed(self):
        resp = self.client.get(self.URL)
        self.assertEqual(resp.status_code, 405)

    def test_anonymous_post_rejected(self):
        resp = self.client.post(self.URL, data='{}', content_type='application/json')
        self.assertEqual(resp.status_code, 401)

    def test_authenticated_bad_payload_passes_auth_gate(self):
        self.client.force_login(self.user)
        resp = self.client.post(
            self.URL, data='definitely not valid json', content_type='application/json',
        )
        # 422 (not 401): auth passed, and the invalid AG-UI body was rejected
        # at the boundary before any model was contacted.
        self.assertEqual(resp.status_code, 422)


@override_settings(
    DEBUG_TOOLBAR_CONFIG={
        'SHOW_TOOLBAR_CALLBACK': lambda request: False,
        'IS_RUNNING_TESTS': False,
    },
)
class CopilotWhoamiTest(TestCase):
    """The runtime identifies users here, not via GraphQL ``me`` (whose DEBUG
    autologin answers anonymous requests as the default test user)."""

    URL = '/app/copilot/whoami/'

    def setUp(self):
        self.user = User.objects.create_user(
            username='who', email='who@test.com', password='x',
        )

    def test_anonymous_rejected(self):
        self.assertEqual(self.client.get(self.URL).status_code, 401)

    def test_session_without_user_rejected(self):
        # A session that exists but holds no logged-in user (e.g. a stale
        # backend_jwt) must be rejected exactly like the AG-UI view does.
        session = self.client.session
        session['foo'] = 'bar'
        session.save()
        resp = self.client.get(self.URL, HTTP_AUTHORIZATION=f'Session {session.session_key}')
        self.assertEqual(resp.status_code, 401)

    def test_post_not_allowed(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.post(self.URL).status_code, 405)

    def test_authenticated_returns_relay_id(self):
        from core.schema.common import GlobalIDUtils
        self.client.force_login(self.user)
        resp = self.client.get(self.URL)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body['id'], GlobalIDUtils.to_global_id('UserType', self.user.pk))
        self.assertEqual(body['username'], 'who')
        self.assertNotIn('pk', body)


@override_settings(
    DEBUG_TOOLBAR_CONFIG={
        'SHOW_TOOLBAR_CALLBACK': lambda request: False,
        'IS_RUNNING_TESTS': False,
    },
    CACHES=_LOCMEM_CACHES,
)
class CopilotEndpointRateLimitTest(TestCase):
    """FIX 6: each POST can trigger a paid model run, so the endpoint throttles
    per authenticated user (30/m) before parsing the payload."""

    URL = '/app/copilot/agui/'

    def setUp(self):
        from django.core.cache import caches
        caches['default'].clear()
        self.user = User.objects.create_user(
            username='rl', email='rl@test.com', password='x',
        )
        self.client.force_login(self.user)

    def _post_bad_payload(self):
        return self.client.post(
            self.URL, data='not valid json', content_type='application/json',
        )

    def test_authenticated_requests_are_throttled(self):
        # The first 30 clear the rate gate (then 422 on the bad payload); the
        # 31st is blocked at the rate gate with 429 before payload parsing.
        for _ in range(30):
            self.assertEqual(self._post_bad_payload().status_code, 422)
        self.assertEqual(self._post_bad_payload().status_code, 429)


class CopilotUrlGatingTest(TestCase):
    """FIX 1: the copilot mount is gated on FORMS and WORKFLOWS, because
    copilot.agent imports their models at module scope."""

    def test_mounted_when_features_enabled(self):
        # The Tests configuration leaves COPILOT/FORMS/WORKFLOWS at their
        # enabled defaults, so the endpoint is routed.
        self.assertTrue(reverse('copilot-agui').endswith('/copilot/agui/'))

    def test_unmounted_when_forms_disabled(self):
        # Reloading the URLconf with FORMS disabled re-runs the mount guard; the
        # named route must disappear rather than the include crashing.
        import config.urls as urlconf
        try:
            with mock.patch.dict(os.environ, {'FEATURE_FORMS': 'false'}):
                importlib.reload(urlconf)
                clear_url_caches()
                with self.assertRaises(NoReverseMatch):
                    reverse('copilot-agui')
        finally:
            importlib.reload(urlconf)
            clear_url_caches()
