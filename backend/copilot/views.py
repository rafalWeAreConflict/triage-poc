"""AG-UI endpoint for the copilot.

A single Django async view that serves the Pydantic AI agent over the AG-UI
protocol. Session auth (the platform's normal middleware) gates the endpoint —
anonymous requests are rejected with 401 before any model call. The request
body is parsed into an AG-UI ``RunAgentInput`` and the agent's event stream is
returned as Server-Sent Events via ``StreamingHttpResponse``.

The lower-level ``AGUIAdapter`` primitives are used (not ``dispatch_request``),
because that helper expects a Starlette request/response; this keeps the
endpoint native to Django so ``request.user`` and the auth stack apply directly.
"""
from __future__ import annotations

import json
import logging
from http import HTTPStatus

from asgiref.sync import sync_to_async
from copilot.agent import CopilotDeps, CopilotNotConfigured, get_agent
from copilot.approvals import collect_approvals
from copilot.learned_skills import get_approved_lessons
from copilot.triage_state import with_triage_state
from core.schema.common import GlobalIDUtils
from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django_ratelimit.core import is_ratelimited
from pydantic import ValidationError
from pydantic_ai.ui import SSE_CONTENT_TYPE
from pydantic_ai.ui.ag_ui import AGUIAdapter
from triage.photos import annotate_run_input_photos

MAX_AGUI_BODY_BYTES = 25 * 1024 * 1024

logger = logging.getLogger(__name__)


def _whoami_payload(user) -> dict:
    profile = getattr(user, 'profile', None)
    return {
        'id': GlobalIDUtils.to_global_id('UserType', user.pk),
        'username': user.get_username(),
        'display_name': getattr(profile, 'display_name', None) or None,
    }


async def copilot_whoami(request):
    """GET /copilot/whoami/ — the user the session resolves to, for the runtime.

    The CopilotKit runtime calls this to identify the user before it starts a
    run. Unlike the GraphQL endpoint it has no DEBUG ``autologin``, so it agrees
    with the AG-UI view: a session the agent would reject is rejected here too.
    The id is the same relay global id GraphQL ``me`` returns.
    """
    if request.method != 'GET':
        return JsonResponse(
            {'error': 'Method not allowed. Use GET.'},
            status=HTTPStatus.METHOD_NOT_ALLOWED,
        )
    user = await request.auser()
    if not user or not user.is_authenticated:
        return JsonResponse(
            {'error': 'Authentication required.'},
            status=HTTPStatus.UNAUTHORIZED,
        )
    return JsonResponse(await sync_to_async(_whoami_payload, thread_sensitive=True)(user))


@csrf_exempt
async def copilot_agui(request):
    """POST /copilot/agui/ — stream an AG-UI agent run as SSE."""
    if request.method != 'POST':
        return JsonResponse(
            {'error': 'Method not allowed. Use POST.'},
            status=HTTPStatus.METHOD_NOT_ALLOWED,
        )

    # Auth gate: reject anonymous callers before touching the model.
    user = await request.auser()
    if not user or not user.is_authenticated:
        return JsonResponse(
            {'error': 'Authentication required.'},
            status=HTTPStatus.UNAUTHORIZED,
        )

    # Rate limit per user: each POST can trigger a paid model run, so throttle
    # like the sibling GraphQL endpoints do. django_ratelimit's decorator is
    # sync-only, so call its core primitive under sync_to_async. Pin request.user
    # to the already-resolved user so the 'user' key needs no extra DB hit.
    request.user = user
    limited = await sync_to_async(is_ratelimited, thread_sensitive=True)(
        request, group='copilot:agui', key='user', rate='30/m', increment=True,
    )
    if limited:
        return JsonResponse(
            {'error': 'Rate limit exceeded. Please slow down and retry shortly.'},
            status=HTTPStatus.TOO_MANY_REQUESTS,
        )

    # AG-UI replays the whole thread (inline photo attachments included) on every run, so the
    # copilot accepts a larger body than Django's form-oriented DATA_UPLOAD_MAX_MEMORY_SIZE.
    try:
        content_length = int(request.headers.get('content-length') or 0)
    except ValueError:
        content_length = 0
    if content_length > MAX_AGUI_BODY_BYTES:
        return JsonResponse({'error': 'Request too large.'}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    body = request.read(MAX_AGUI_BODY_BYTES + 1)
    if len(body) > MAX_AGUI_BODY_BYTES:
        return JsonResponse({'error': 'Request too large.'}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

    # Validate the AG-UI request payload at the boundary.
    try:
        run_input = AGUIAdapter.build_run_input(body)
    except ValidationError as exc:
        return JsonResponse(
            {'error': 'Invalid AG-UI request payload.', 'detail': json.loads(exc.json())},
            status=HTTPStatus.UNPROCESSABLE_ENTITY,
        )

    # Multimodal: store chat photo attachments (MinIO/S3) and note their photo_guid for the agent.
    await sync_to_async(annotate_run_input_photos, thread_sensitive=True)(run_input, user)

    try:
        agent = get_agent()
    except CopilotNotConfigured as exc:
        return JsonResponse({'error': str(exc)}, status=HTTPStatus.SERVICE_UNAVAILABLE)

    accept = request.headers.get('accept') or SSE_CONTENT_TYPE
    adapter = AGUIAdapter(agent=agent, run_input=run_input, accept=accept)
    # Skill delivery: approved lessons (published Skills of the Learning Container) are pulled server-to-server
    # from the CopilotKit runtime with this run's own session — never read from the client-submitted
    # RunAgentInput (context / forwardedProps / state). See copilot.learned_skills.
    session_key = getattr(getattr(request, 'session', None), 'session_key', None)
    snapshot = await get_approved_lessons(f'Session {session_key}' if session_key else None)
    logger.info(
        'copilot skill delivery: %d approved lesson(s) loaded [%s] (status=%s, container=%s, revision=%s, source=%s)',
        len(snapshot.lessons), ', '.join(lesson.name for lesson in snapshot.lessons),
        snapshot.status, snapshot.container_id, snapshot.revision, snapshot.source,
    )
    # Admin decisions (frontend HITL tool results) in the submitted history; confirmed tools need one.
    deps = CopilotDeps(user=user, lessons=snapshot.lessons, approvals=collect_approvals(run_input.messages))

    # Shared state: the adapter loads RunAgentInput.state into deps.state (StateHandler); the wrapper adds
    # the triage STATE_SNAPSHOT events (run start, propose_triage draft). See copilot.triage_state.
    events = with_triage_state(adapter.run_stream(deps=deps), deps, run_input)
    sse_stream = adapter.encode_stream(events)
    response = StreamingHttpResponse(sse_stream, content_type=SSE_CONTENT_TYPE)
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response
