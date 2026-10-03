"""GraphQL types for the triage dictionaries (external identifiers only: category code, contractor slug)."""
from typing import Optional

import strawberry


@strawberry.type(description='Maintenance-ticket category.')
class TriageCategoryType:
    code: str
    name: str
    description: str


@strawberry.type(description='Contractor that handles one triage category.')
class TriageContractorType:
    slug: str
    name: str
    category_code: str
    phone: str
    email: str


@strawberry.type(description='Maintenance ticket as listed on the triage screen (external guid only).')
class TriageTicketType:
    guid: str
    unit: str
    reporter_name: str
    description: str = strawberry.field(description='Excerpt of the description.')
    category_code: Optional[str]
    category_name: Optional[str]
    priority: str
    contractor_slug: Optional[str]
    contractor_name: Optional[str]
    status: str
    created_at: str = strawberry.field(description='ISO 8601 timestamp.')
    was_corrected: bool = strawberry.field(description='The admin corrected the AI proposal.')
    has_photo: bool
