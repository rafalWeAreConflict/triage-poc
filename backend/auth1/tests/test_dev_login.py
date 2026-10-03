from urllib.parse import parse_qs, urlsplit

from django.contrib.auth.models import User
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse

_FRESH_CACHE = {
    'default': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        'LOCATION': 'dev-login-test',
    }
}
_FRONTEND_URL = 'http://frontend.example.test'
# The project's toolbar callback reads the module-level DEBUG, and its URLs are not mounted under tests.
_NO_TOOLBAR = {'SHOW_TOOLBAR_CALLBACK': lambda request: False, 'IS_RUNNING_TESTS': False}


@override_settings(CACHES=_FRESH_CACHE, FRONTEND_URL=_FRONTEND_URL, DEBUG_TOOLBAR_CONFIG=_NO_TOOLBAR)
class DevLoginTest(TestCase):

    def setUp(self):
        cache.clear()
        self.url = reverse('dev-login')
        self.user = User.objects.create_user(username='dev_login_user', email='dev@boilerworks.dev', password='x', is_staff=True)

    @override_settings(DEBUG=False, CONFIGURATION='Local')
    def test_not_found_when_debug_off(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.get(self.url).status_code, 404)

    @override_settings(DEBUG=True, CONFIGURATION='Dev')
    def test_not_found_outside_local_configuration(self):
        self.client.force_login(self.user)
        self.assertEqual(self.client.get(self.url).status_code, 404)

    @override_settings(DEBUG=True, CONFIGURATION='Local')
    def test_anonymous_redirects_to_admin_login(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 302)
        location = urlsplit(response['Location'])
        self.assertEqual(location.path, reverse('admin:login'))
        self.assertEqual(parse_qs(location.query)['next'], [self.url])

    @override_settings(DEBUG=True, CONFIGURATION='Local')
    def test_authenticated_redirects_to_frontend_callback_with_session_token(self):
        self.client.force_login(self.user)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 302)
        location = urlsplit(response['Location'])
        self.assertEqual(f'{location.scheme}://{location.netloc}{location.path}', f'{_FRONTEND_URL}/auth/callback')
        session_key = self.client.session.session_key
        self.assertEqual(parse_qs(location.query)['token'], [f'Session {session_key}'])
