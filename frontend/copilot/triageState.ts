// AG-UI shared state of the triage screen (`/triage`).
//
// The Django agent owns this state (backend/copilot/triage_state.py) and pushes it as AG-UI
// STATE_SNAPSHOT events: at run start (fresh ticket list), when the model calls `propose_triage`
// (the draft) and after `create_ticket` (new ticket, draft cleared). The frontend reads it with
// v2 `useAgent` (`agent.state`). Before any run the list comes from the GraphQL `triageTickets`
// query; `mergeTickets` combines both sources by guid.

/** Ticket priorities (backend `TicketPriority`); each has a `priority.<p>` translation. */
export const TRIAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

/** Ticket workflow states (backend `TicketStatus`); each has a `status.<s>` translation. */
export const TICKET_STATUSES = ["new", "proposed", "approved", "assigned", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function isTriagePriority(value: unknown): value is TriagePriority {
  return (TRIAGE_PRIORITIES as readonly unknown[]).includes(value);
}

export function isTicketStatus(value: unknown): value is TicketStatus {
  return (TICKET_STATUSES as readonly unknown[]).includes(value);
}

/** One ticket row (snake_case, exactly as the agent state carries it). */
export type TriageTicketRow = {
  guid: string;
  unit: string;
  reporter_name: string;
  description: string;
  category_code: string | null;
  category_name: string | null;
  priority: string;
  contractor_slug: string | null;
  contractor_name: string | null;
  status: string;
  created_at: string;
  was_corrected: boolean;
  has_photo: boolean;
};

export type TriageDraftStatus = "awaiting_decision" | "approved" | "corrected" | "decided";

/** The proposal currently shown on the `propose_triage` card. */
export type TriageDraft = {
  tool_call_id: string;
  unit_guid?: string | null;
  unit_label: string;
  reporter_name: string;
  description: string;
  category_code: string | null;
  category_name: string | null;
  priority: string | null;
  contractor_slug: string | null;
  contractor_name: string | null;
  reasoning: string;
  has_photo: boolean;
  status: TriageDraftStatus;
};

export type TriageAgentState = {
  tickets: TriageTicketRow[];
  draft: TriageDraft | null;
  last_created_guid: string | null;
  last_updated: string | null;
};

/** GraphQL `triageTickets` row (camelCase). */
export type TriageTicketGql = {
  guid: string;
  unit: string;
  reporterName: string;
  description: string;
  categoryCode: string | null;
  categoryName: string | null;
  priority: string;
  contractorSlug: string | null;
  contractorName: string | null;
  status: string;
  createdAt: string;
  wasCorrected: boolean;
  hasPhoto: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toTicket(value: unknown): TriageTicketRow | null {
  if (!isRecord(value) || typeof value.guid !== "string" || !value.guid) return null;
  return {
    guid: value.guid,
    unit: str(value.unit),
    reporter_name: str(value.reporter_name),
    description: str(value.description),
    category_code: strOrNull(value.category_code),
    category_name: strOrNull(value.category_name),
    priority: str(value.priority),
    contractor_slug: strOrNull(value.contractor_slug),
    contractor_name: strOrNull(value.contractor_name),
    status: str(value.status),
    created_at: str(value.created_at),
    was_corrected: value.was_corrected === true,
    has_photo: value.has_photo === true,
  };
}

const DRAFT_STATUSES: TriageDraftStatus[] = [
  "awaiting_decision",
  "approved",
  "corrected",
  "decided",
];

function toDraft(value: unknown): TriageDraft | null {
  if (!isRecord(value) || typeof value.tool_call_id !== "string") return null;
  const status = DRAFT_STATUSES.includes(value.status as TriageDraftStatus)
    ? (value.status as TriageDraftStatus)
    : "awaiting_decision";
  return {
    tool_call_id: value.tool_call_id,
    unit_guid: strOrNull(value.unit_guid),
    unit_label: str(value.unit_label),
    reporter_name: str(value.reporter_name),
    description: str(value.description),
    category_code: strOrNull(value.category_code),
    category_name: strOrNull(value.category_name),
    priority: strOrNull(value.priority),
    contractor_slug: strOrNull(value.contractor_slug),
    contractor_name: strOrNull(value.contractor_name),
    reasoning: str(value.reasoning),
    has_photo: value.has_photo === true,
    status,
  };
}

/** Defensive parse of `agent.state` (partial while a run streams, `{}` on a fresh thread). */
export function parseTriageAgentState(state: unknown): TriageAgentState {
  const record = isRecord(state) ? state : {};
  const tickets = Array.isArray(record.tickets)
    ? record.tickets.map(toTicket).filter((t): t is TriageTicketRow => t !== null)
    : [];
  return {
    tickets,
    draft: toDraft(record.draft),
    last_created_guid: strOrNull(record.last_created_guid),
    last_updated: strOrNull(record.last_updated),
  };
}

export function ticketFromGql(row: TriageTicketGql): TriageTicketRow {
  return {
    guid: row.guid,
    unit: row.unit,
    reporter_name: row.reporterName,
    description: row.description,
    category_code: row.categoryCode,
    category_name: row.categoryName,
    priority: row.priority,
    contractor_slug: row.contractorSlug,
    contractor_name: row.contractorName,
    status: row.status,
    created_at: row.createdAt,
    was_corrected: row.wasCorrected,
    has_photo: row.hasPhoto,
  };
}

/**
 * Union of the agent-state tickets and the GraphQL tickets, by guid, newest first.
 * The agent state wins for a guid present in both (it is pushed right after a change);
 * GraphQL fills in tickets the current thread's state does not carry (other threads, admin edits).
 */
export function mergeTickets(
  stateTickets: TriageTicketRow[],
  gqlTickets: TriageTicketRow[],
  limit = 12
): TriageTicketRow[] {
  const byGuid = new Map<string, TriageTicketRow>();
  for (const ticket of gqlTickets) byGuid.set(ticket.guid, ticket);
  for (const ticket of stateTickets) byGuid.set(ticket.guid, ticket);
  return [...byGuid.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, limit);
}
