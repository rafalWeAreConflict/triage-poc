"""Skill delivery: approved lessons from CopilotKit Intelligence for the copilot agent.

CopilotKit Intelligence (Automatic Learning) analyses the threads of the configured (``COPILOT_LEARNING_CONTAINER_ID``) Learning
Container, writes Insights and proposes Skills; an admin approves a candidate and it becomes a
published Skill. The runtime does **not** inject published Skills into the AG-UI request (it only tags
threads with the container); agents pull them through an Intelligence SDK adapter. There is no
Pydantic AI adapter, so:

1. the Next.js runtime (which holds ``CPK_INTELLIGENCE_API_KEY``) runs the runtime's own
   ``SkillRegistry`` and serves the verified snapshot at ``/api/copilotkit-skills``
   (``frontend/copilot/learned-skills.ts``);
2. this module pulls that snapshot server-to-server before each run from the configured
   ``settings.COPILOT_SKILLS_URL`` (authenticated with the run's own Django session), caches it for
   ``settings.COPILOT_SKILLS_CACHE_SECONDS`` and hands it to the agent in ``CopilotDeps.lessons``;
3. ``copilot.agent`` renders them as dynamic instructions.

Trust boundary: lessons only ever come from that server-side fetch. Nothing in the client-submitted
``RunAgentInput`` (``context``, ``forwardedProps``, ``state``, messages) is read as a lesson, so a
browser cannot inject "approved lessons".
"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

CACHE_KEY = 'copilot:learned_skills:v1'
ERROR_CACHE_SECONDS = 15
FETCH_TIMEOUT_SECONDS = 15.0  # the first hit may compile the Next dev route
MAX_LESSONS = 20
MAX_LESSON_CHARS = 8000

_FRONTMATTER = re.compile(r'\A---\s*\n.*?\n---\s*(?:\n|\Z)', re.DOTALL)


@dataclass(frozen=True)
class Lesson:
    """One published Skill: its name, description and SKILL.md instructions."""

    name: str
    description: str
    instructions: str


@dataclass(frozen=True)
class LessonSnapshot:
    """What the agent received for one run (also what ``triage_lessons`` prints)."""

    status: str  # ok | error | disabled
    lessons: tuple[Lesson, ...] = ()
    container_id: Optional[str] = None
    revision: Optional[str] = None
    fetched_at: Optional[str] = None
    error: Optional[str] = None
    source: str = 'fetch'  # fetch | cache

    def to_cache(self) -> dict[str, Any]:
        data = asdict(self)
        data['lessons'] = [asdict(lesson) for lesson in self.lessons]
        return data

    @classmethod
    def from_cache(cls, data: dict[str, Any]) -> 'LessonSnapshot':
        lessons = tuple(Lesson(**lesson) for lesson in data.get('lessons') or ())
        return cls(**{**data, 'lessons': lessons, 'source': 'cache'})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _strip_frontmatter(text: str) -> str:
    return _FRONTMATTER.sub('', text, count=1).strip()


def parse_payload(payload: Any) -> LessonSnapshot:
    """Validate the runtime's ``/api/copilotkit-skills`` JSON into a bounded snapshot."""
    if not isinstance(payload, dict):
        return LessonSnapshot(status='error', error='invalid payload', fetched_at=_now())
    container_id = payload.get('containerId') if isinstance(payload.get('containerId'), str) else None
    if payload.get('status') != 'ok':
        err = payload.get('error') if isinstance(payload.get('error'), dict) else {}
        return LessonSnapshot(status='error', container_id=container_id, fetched_at=_now(),
                              error=str(err.get('code') or 'delivery error'))
    lessons = []
    for skill in (payload.get('skills') or [])[:MAX_LESSONS]:
        if not isinstance(skill, dict):
            continue
        name, body = skill.get('name'), skill.get('instructions')
        if not isinstance(name, str) or not name.strip() or not isinstance(body, str):
            continue
        description = skill.get('description') if isinstance(skill.get('description'), str) else ''
        lessons.append(Lesson(
            name=name.strip()[:200],
            description=description.strip()[:1000],
            instructions=_strip_frontmatter(body)[:MAX_LESSON_CHARS],
        ))
    revision = payload.get('revision')
    return LessonSnapshot(
        status='ok', lessons=tuple(lessons), container_id=container_id,
        revision=str(revision) if revision is not None else None, fetched_at=_now(),
    )


async def _fetch(url: str, authorization: str) -> tuple[LessonSnapshot, bool]:
    """Fetch from the runtime. Returns ``(snapshot, cacheable)``."""
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, headers={'Authorization': authorization, 'Accept': 'application/json'})
    except httpx.HTTPError as exc:
        return LessonSnapshot(status='error', error=f'runtime unreachable: {type(exc).__name__}', fetched_at=_now()), True
    if resp.status_code in (401, 403):
        # Per-user auth failure: do not cache it for everyone.
        return LessonSnapshot(status='error', error=f'runtime HTTP {resp.status_code}', fetched_at=_now()), False
    try:
        payload = resp.json()
    except ValueError:
        return LessonSnapshot(status='error', error=f'runtime HTTP {resp.status_code} (not JSON)', fetched_at=_now()), True
    return parse_payload(payload), True


async def get_approved_lessons(authorization: Optional[str]) -> LessonSnapshot:
    """Published Skills for this run (cached). Never raises; errors yield zero lessons."""
    url = (getattr(settings, 'COPILOT_SKILLS_URL', '') or '').strip()
    if not url:
        return LessonSnapshot(status='disabled')
    cached = await cache.aget(CACHE_KEY)
    if isinstance(cached, dict):
        try:
            return LessonSnapshot.from_cache(cached)
        except TypeError:
            pass
    if not authorization:
        return LessonSnapshot(status='error', error='no session to authenticate the runtime hop')
    snapshot, cacheable = await _fetch(url, authorization)
    if cacheable:
        ttl = settings.COPILOT_SKILLS_CACHE_SECONDS if snapshot.status == 'ok' else ERROR_CACHE_SECONDS
        await cache.aset(CACHE_KEY, snapshot.to_cache(), ttl)
    if snapshot.status != 'ok':
        logger.warning('copilot skill delivery: no lessons loaded (%s)', snapshot.error)
    return snapshot


def read_cached_snapshot() -> Optional[LessonSnapshot]:
    """The snapshot the agent currently uses (``None`` when nothing is cached)."""
    cached = cache.get(CACHE_KEY)
    return LessonSnapshot.from_cache(cached) if isinstance(cached, dict) else None


def clear_cached_snapshot() -> None:
    cache.delete(CACHE_KEY)


def _sanitize(text: str) -> str:
    # Lessons are wrapped in <lesson> tags; keep a body from closing or opening one.
    return re.sub(r'</?\s*(lesson|approved_lessons)\b[^>]*>', '', text, flags=re.IGNORECASE)


def format_lessons_instructions(lessons: tuple[Lesson, ...] | list[Lesson]) -> str:
    """Instructions block for the agent; empty string when there are no lessons."""
    if not lessons:
        return ''
    blocks = []
    for lesson in lessons:
        name = _sanitize(lesson.name).replace('"', "'")
        parts = [f'<lesson name="{name}">']
        if lesson.description:
            parts.append(f'Description: {_sanitize(lesson.description)}')
        parts.append(_sanitize(lesson.instructions))
        parts.append('</lesson>')
        blocks.append('\n'.join(parts))
    return (
        'Approved lessons from CopilotKit Intelligence (organization scope)\n'
        '<approved_lessons>\n'
        'These Skills were learned from earlier admin corrections in this cooperative and approved by an '
        'administrator; they apply to every admin. The rules above (role, safety, permissions, tool use and '
        'human approval) still take precedence. Within them, when a lesson applies to the current request, '
        'follow it over your own defaults, and cite it in the reasoning field of propose_triage as '
        "'Lesson: <name>' (the lesson's exact name).\n\n"
        + '\n\n'.join(blocks)
        + '\n</approved_lessons>'
    )
