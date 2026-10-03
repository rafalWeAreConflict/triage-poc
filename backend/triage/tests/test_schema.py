from unittest.mock import MagicMock

from asgiref.sync import async_to_sync
from config.schema import schema
from core.schema.context import StrawberryContext
from django.contrib.auth.models import AnonymousUser
from django.test import TestCase
from triage.models import Category, CategoryCode, Contractor
from triage.tests.test_triage import TriageFixtureMixin, _member

QUERY = '''
query ($code: String) {
  triageCategories { code name description }
  triageContractors(categoryCode: $code) { slug name categoryCode phone email }
}
'''


class TriageDictionaryQueryTest(TriageFixtureMixin, TestCase):

    def setUp(self):
        super().setUp()
        heating = Category.objects.create(code=CategoryCode.HEATING, name='Heating', description='Central heating')
        Contractor.objects.create(name='WarmHome Heating', slug='warmhome-heating', category=heating, phone='+1 1')

    def _execute(self, user, code=None):
        request = MagicMock()
        request.user = user
        request.session = {}
        request.headers = {}
        return schema.execute_sync(QUERY, variable_values={'code': code}, context_value=StrawberryContext(request))

    def test_lists_categories_and_contractors_with_external_ids(self):
        result = self._execute(self.admin)
        self.assertIsNone(result.errors)
        self.assertEqual([c['code'] for c in result.data['triageCategories']], ['heating', 'plumbing'])
        self.assertEqual({c['slug'] for c in result.data['triageContractors']}, {'warmhome-heating', self.contractor.slug})
        self.assertNotIn('id', result.data['triageContractors'][0])

    def test_contractors_filtered_by_category(self):
        result = self._execute(self.admin, code='heating')
        self.assertIsNone(result.errors)
        self.assertEqual(result.data['triageContractors'], [{
            'slug': 'warmhome-heating', 'name': 'WarmHome Heating', 'categoryCode': 'heating', 'phone': '+1 1', 'email': '',
        }])

    def test_resolvers_work_under_the_async_view(self):
        # CoreStrawberryView executes asynchronously; the ORM work must not run in the event loop.
        request = MagicMock()
        request.user = self.admin
        request.session = {}
        request.headers = {}
        result = async_to_sync(schema.execute)(QUERY, variable_values={'code': None},
                                               context_value=StrawberryContext(request))
        self.assertIsNone(result.errors)
        self.assertEqual(len(result.data['triageCategories']), 2)

    def test_anonymous_rejected(self):
        result = self._execute(AnonymousUser())
        self.assertIsNone(result.data)
        self.assertIn('Authentication required', str(result.errors))

    def test_without_permission_rejected(self):
        result = self._execute(_member(self.org, 'no-perms'))
        self.assertIn('Permission denied', str(result.errors))


TICKETS_QUERY = '''
query ($limit: Int) {
  triageTickets(limit: $limit) {
    guid unit reporterName description categoryCode categoryName priority contractorSlug contractorName
    status createdAt wasCorrected hasPhoto
  }
}
'''


class TriageTicketsQueryTest(TriageFixtureMixin, TestCase):

    def _execute(self, user, limit=None):
        request = MagicMock()
        request.user = user
        request.session = {}
        request.headers = {}
        variables = {} if limit is None else {'limit': limit}
        return schema.execute_sync(TICKETS_QUERY, variable_values=variables, context_value=StrawberryContext(request))

    def test_lists_recent_tickets_newest_first_with_external_ids(self):
        older = self._ticket(description='Starsze', category=self.category, contractor=self.contractor)
        newer = self._ticket(description='x' * 400, admin_correction={'changed_fields': {'category': {}}})
        result = self._execute(self.admin)
        self.assertIsNone(result.errors)
        rows = result.data['triageTickets']
        self.assertEqual([r['guid'] for r in rows], [str(newer.guid), str(older.guid)])
        self.assertNotIn('id', rows[0])
        self.assertEqual(rows[0]['unit'], 'T/1')
        self.assertTrue(rows[0]['wasCorrected'])
        self.assertLessEqual(len(rows[0]['description']), 140)
        self.assertEqual(rows[1]['categoryName'], 'Plumbing')
        self.assertEqual(rows[1]['contractorName'], 'Hydro-Test')
        self.assertEqual(rows[1]['status'], 'new')
        self.assertEqual(len(self._execute(self.admin, limit=1).data['triageTickets']), 1)

    def test_anonymous_rejected(self):
        result = self._execute(AnonymousUser())
        self.assertIsNone(result.data)
        self.assertIn('Authentication required', str(result.errors))

    def test_without_permission_rejected(self):
        self._ticket()
        result = self._execute(_member(self.org, 'no-perms'))
        self.assertIsNone(result.data)
        self.assertIn('Permission denied', str(result.errors))
