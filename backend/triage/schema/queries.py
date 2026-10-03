"""Read-only triage queries for the frontend: dictionaries (TriageProposalCard correction selects) and the
recent-ticket list of the /triage screen (initial load before any agent run; the agent then keeps it in sync
through AG-UI shared state, see copilot.triage_state)."""
from __future__ import annotations

from typing import Optional

import strawberry
import strawberry_django
from config.roles_gen import P
from graphql import GraphQLError
from strawberry.types import Info
from triage.listing import MAX_TICKET_LIMIT, RECENT_TICKET_LIMIT, recent_tickets
from triage.models import Category, Contractor

from .types import TriageCategoryType, TriageContractorType, TriageTicketType


def _require(info: Info, perm) -> None:
    user = info.context.user
    if not user or not user.is_authenticated:
        raise GraphQLError('Authentication required')
    if not perm.check(user, raised_error=False):
        raise GraphQLError('Permission denied')


@strawberry.type
class Query:

    # strawberry_django.field runs the sync (ORM) resolver via sync_to_async under the async view.
    @strawberry_django.field(description='Triage categories (code, name, description), ordered by code.')
    def triage_categories(self, info: Info) -> list[TriageCategoryType]:
        _require(info, P.CATEGORY_VIEW)
        return [
            TriageCategoryType(code=c.code, name=c.name or c.code, description=c.description or '')
            for c in Category.objects.filter(deleted_at__isnull=True).order_by('code')
        ]

    @strawberry_django.field(description='Contractors, optionally only those of one category code.')
    def triage_contractors(self, info: Info, category_code: Optional[str] = None) -> list[TriageContractorType]:
        _require(info, P.CONTRACTOR_VIEW)
        qs = Contractor.objects.select_related('category').filter(deleted_at__isnull=True)
        if category_code:
            qs = qs.filter(category__code=category_code)
        return [
            TriageContractorType(slug=c.slug, name=c.name or c.slug, category_code=c.category.code,
                                 phone=c.phone, email=c.email)
            for c in qs.order_by('name')
        ]

    @strawberry_django.field(
        description=f'Most recent tickets, newest first (limit 1-{MAX_TICKET_LIMIT}, default {RECENT_TICKET_LIMIT}).')
    def triage_tickets(self, info: Info, limit: int = RECENT_TICKET_LIMIT) -> list[TriageTicketType]:
        _require(info, P.TICKET_VIEW)
        return [TriageTicketType(**row) for row in recent_tickets(info.context.user, limit)]
