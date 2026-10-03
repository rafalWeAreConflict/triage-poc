import logging
from asyncio import iscoroutinefunction
from functools import wraps

from asgiref.sync import sync_to_async
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied

logger = logging.getLogger(__name__)


def _resolve_user(request):
    if settings.DEBUG and request.user.is_anonymous:
        user = get_user_model().objects.filter(username=settings.DEFAULT_USER_TEST).first()
        if not user:
            raise PermissionDenied('User is not authenticated')
        request.user = user
    elif request.user.is_anonymous:
        raise PermissionDenied('User is not authenticated')


def autologin(view_func):
    """DEBUG convenience: anonymous requests act as DEFAULT_USER_TEST.

    Async-aware: around an async view the ORM lookup (and the lazy
    ``request.user`` resolution) must run off the event loop, or Django
    raises SynchronousOnlyOperation under ASGI.
    """
    if iscoroutinefunction(view_func):
        async def wrapped_view(*args, **kwargs):
            await sync_to_async(_resolve_user, thread_sensitive=True)(args[0])
            return await view_func(*args, **kwargs)
    else:
        def wrapped_view(*args, **kwargs):
            _resolve_user(args[0])
            return view_func(*args, **kwargs)

    return wraps(view_func)(wrapped_view)
