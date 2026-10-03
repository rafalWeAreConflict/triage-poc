"""
Dev-only login bridge for the Next.js frontend.

Local Auth0 settings are placeholders, so the frontend's Auth0 login cannot complete
locally. This view reuses the Django admin username/password login and hands the
resulting session to the frontend's `/auth/callback?token=Session <key>` page, the
same token format the Auth0 `callback` view produces.

Responds only when DEBUG is on and DJANGO_CONFIGURATION is `Local`; 404 otherwise.
"""
from urllib.parse import quote_plus, urlencode

from django.conf import settings
from django.core.handlers.wsgi import WSGIRequest
from django.http import Http404, HttpResponseRedirect
from django.urls import reverse

LOCAL_CONFIGURATION = 'local'


def is_local_development() -> bool:
    return bool(settings.DEBUG) and str(getattr(settings, 'CONFIGURATION', '') or '').lower() == LOCAL_CONFIGURATION


def dev_login(request: WSGIRequest):
    if not is_local_development():
        raise Http404()

    if not request.user.is_authenticated:
        login_url = reverse('admin:login')
        return HttpResponseRedirect(f"{login_url}?{urlencode({'next': request.get_full_path()})}")

    if not request.session.session_key:
        request.session.save()
    token = f"Session {request.session.session_key}"
    return HttpResponseRedirect(f"{settings.FRONTEND_URL}/auth/callback?token={quote_plus(token)}")
