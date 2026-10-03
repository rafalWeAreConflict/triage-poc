"""Custom Strawberry GraphQL view with logging and caching.

Replaces core/utils/core_graph_ql_view.py (Graphene's CoreGraphQLView).
"""
from __future__ import annotations

from core.schema.context import StrawberryContext
from strawberry.django.views import AsyncGraphQLView, GraphQLView


class CoreStrawberryView(GraphQLView):
    """Strawberry GraphQL view with request logging and context injection."""

    def get_context(self, request, response=None):
        return StrawberryContext(request)


class CoreAsyncStrawberryView(AsyncGraphQLView):
    """Async Strawberry view — required when serving ASGI.

    The sync view executes in a worker thread, where strawberry's DataLoader
    cannot obtain an event loop on Python 3.12+ ("There is no current event
    loop in thread ..."), breaking every dataloader-backed field. Under an
    ASGI server the async view runs on the loop and dataloaders batch
    correctly.
    """

    async def get_context(self, request, response=None):
        return StrawberryContext(request)
