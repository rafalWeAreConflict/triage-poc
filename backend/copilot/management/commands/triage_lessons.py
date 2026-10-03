"""Show the approved lessons (published Skills) the copilot agent currently uses.

    python manage.py triage_lessons           # what the last run loaded (cached snapshot)
    python manage.py triage_lessons --full    # include each lesson's instructions
    python manage.py triage_lessons --clear   # drop the cache so the next run refetches now

Lessons are pulled from the CopilotKit runtime (``/api/copilotkit-skills``) at the start of an agent run
with that run's session and cached for ``COPILOT_SKILLS_CACHE_SECONDS``; see ``copilot.learned_skills``.
"""
from copilot.learned_skills import clear_cached_snapshot, format_lessons_instructions, read_cached_snapshot
from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Show (or clear) the approved CopilotKit Intelligence lessons the copilot agent uses.'

    def add_arguments(self, parser):
        parser.add_argument('--full', action='store_true', help='Print the instructions block given to the agent.')
        parser.add_argument('--clear', action='store_true', help='Clear the cached snapshot (next run refetches).')

    def handle(self, *args, full=False, clear=False, **options):
        out = self.stdout
        if clear:
            clear_cached_snapshot()
            out.write(self.style.SUCCESS('Cleared the cached lessons; the next agent run fetches them again.'))
            return
        url = settings.COPILOT_SKILLS_URL or '(disabled: COPILOT_SKILLS_URL is empty)'
        out.write(f'Skill delivery source: {url} (cache {settings.COPILOT_SKILLS_CACHE_SECONDS}s)')
        snapshot = read_cached_snapshot()
        if snapshot is None:
            out.write(self.style.WARNING(
                'No snapshot cached: no agent run in the last cache window. Send any message in /triage, then '
                're-run this command (or open http://localhost:3000/api/copilotkit-skills while signed in).'
            ))
            return
        out.write(
            f'status={snapshot.status} container={snapshot.container_id} revision={snapshot.revision} '
            f'fetched_at={snapshot.fetched_at}' + (f' error={snapshot.error}' if snapshot.error else '')
        )
        out.write(self.style.SUCCESS(f'{len(snapshot.lessons)} approved lesson(s) loaded'))
        for lesson in snapshot.lessons:
            out.write(f'- {lesson.name}: {lesson.description}')
        if full and snapshot.lessons:
            out.write('')
            out.write(format_lessons_instructions(snapshot.lessons))
