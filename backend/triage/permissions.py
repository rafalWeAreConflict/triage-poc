"""Triage permission sets (group-based; the ``P`` members are generated from model Meta by ``./run.sh perms``)."""
from config.roles_gen import P


def triage_admin_permissions():
    """Permissions granted to the "Triage Admin" group."""
    return [
        P.TICKET_VIEW, P.TICKET_ADD, P.TICKET_CHANGE, P.TICKET_APPROVE,
        P.BUILDING_VIEW, P.UNIT_VIEW, P.CATEGORY_VIEW, P.CONTRACTOR_VIEW,
    ]
