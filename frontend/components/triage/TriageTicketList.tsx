"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  ImageIcon,
  InboxIcon,
  Loader2Icon,
  PencilIcon,
  RadioIcon,
  SparklesIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  mergeTickets,
  type TriageAgentState,
  type TriageDraft,
  type TriageTicketRow,
  isTicketStatus,
  isTriagePriority,
} from "@/copilot/triageState";
import { TriageTicketDetails } from "./TriageTicketDetails";

export const HIGHLIGHT_MS = 6000;

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-secondary text-secondary-foreground",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  urgent: "bg-destructive/15 text-destructive",
};

const STATUS_STYLES: Record<string, string> = {
  new: "bg-muted text-muted-foreground",
  proposed: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  assigned: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  closed: "bg-muted text-muted-foreground line-through",
};

/**
 * Guids that appeared after the list was first shown, for a brief highlight. The first
 * non-empty list is the baseline (no highlight on page load or thread replay).
 */
export function useNewTicketHighlight(tickets: TriageTicketRow[], durationMs = HIGHLIGHT_MS) {
  const seen = useRef<Set<string> | null>(null);
  // Timers live outside the effect: the list re-renders (GraphQL refetch) while a highlight is
  // showing, and an effect cleanup would cancel the fade-out.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [highlighted, setHighlighted] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (tickets.length === 0) return;
    if (seen.current === null) {
      seen.current = new Set(tickets.map((t) => t.guid));
      return;
    }
    const fresh = tickets.map((t) => t.guid).filter((guid) => !seen.current!.has(guid));
    if (fresh.length === 0) return;
    fresh.forEach((guid) => seen.current!.add(guid));
    setHighlighted((prev) => new Set([...prev, ...fresh]));
    timers.current.push(
      setTimeout(() => {
        setHighlighted((prev) => new Set([...prev].filter((guid) => !fresh.includes(guid))));
      }, durationMs)
    );
  }, [tickets, durationMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return highlighted;
}

export type TriageTicketListProps = {
  /** Parsed AG-UI agent state (`agent.state`), see copilot/triageState.ts. */
  agentState: TriageAgentState;
  /** Tickets from the GraphQL `triageTickets` query (initial load / other threads). */
  gqlTickets: TriageTicketRow[];
  loading?: boolean;
  error?: boolean;
  isRunning?: boolean;
};

/**
 * The "Tickets" panel of the triage screen: the agent's shared-state ticket list merged with
 * the GraphQL list, the current draft as a "Draft / in progress" row, and a brief ring around a
 * ticket that has just been created. Clicking a row opens its details.
 */
export function TriageTicketList({
  agentState,
  gqlTickets,
  loading,
  error,
  isRunning,
}: TriageTicketListProps) {
  const t = useTranslations("triage");
  const format = useFormatter();
  const tickets = useMemo(
    () => mergeTickets(agentState.tickets, gqlTickets),
    [agentState.tickets, gqlTickets]
  );
  const highlighted = useNewTicketHighlight(tickets);
  const [selected, setSelected] = useState<TriageTicketRow | null>(null);

  const updated = agentState.last_updated
    ? format.dateTime(new Date(agentState.last_updated), { timeStyle: "medium" })
    : null;

  return (
    <section
      aria-label={t("title")}
      className="bg-card text-card-foreground flex h-full min-h-0 flex-col rounded-xl border shadow-sm"
    >
      <header className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-semibold">
            <InboxIcon className="h-4 w-4" />
            {t("title")}
            <span className="text-muted-foreground text-sm font-normal">({tickets.length})</span>
          </h2>
          <p className="text-muted-foreground truncate text-xs">{t("subtitle")}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge
            variant="outline"
            title={t("liveHint")}
            data-testid="shared-state-badge"
            className="gap-1 text-[11px]"
          >
            <RadioIcon className={cn("h-3 w-3", isRunning && "animate-pulse text-emerald-600")} />
            {t("live")}
          </Badge>
          {updated ? (
            <span className="text-muted-foreground text-[11px]" data-testid="state-updated">
              {t("updated", { time: updated })}
            </span>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {agentState.draft ? <DraftRow draft={agentState.draft} /> : null}

        {loading && tickets.length === 0 ? (
          <div className="space-y-2" aria-label={t("loading")}>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}
        {error && tickets.length === 0 ? (
          <p className="text-destructive text-sm">{t("loadError")}</p>
        ) : null}
        {!loading && !error && tickets.length === 0 && !agentState.draft ? (
          <p className="text-muted-foreground py-8 text-center text-sm">{t("empty")}</p>
        ) : null}

        <ul className="space-y-2">
          {tickets.map((ticket) => (
            <li key={ticket.guid}>
              <TicketRow
                ticket={ticket}
                fresh={highlighted.has(ticket.guid)}
                onOpen={() => setSelected(ticket)}
              />
            </li>
          ))}
        </ul>
      </div>

      <TriageTicketDetails ticket={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function TicketRow({
  ticket,
  fresh,
  onOpen,
}: {
  ticket: TriageTicketRow;
  fresh: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations("triage");
  const format = useFormatter();
  const created = ticket.created_at
    ? format.dateTime(new Date(ticket.created_at), { dateStyle: "short", timeStyle: "short" })
    : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("details.open", { unit: ticket.unit })}
      data-testid="ticket-row"
      data-guid={ticket.guid}
      data-fresh={fresh || undefined}
      className={cn(
        "hover:bg-muted/50 w-full rounded-lg border p-2.5 text-left text-sm transition-all duration-500",
        fresh && "bg-emerald-500/5 ring-2 ring-emerald-500 ring-offset-1"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-semibold">{ticket.unit}</span>
          <span className="text-muted-foreground truncate text-xs">{ticket.reporter_name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {fresh ? (
            <Badge className="border-transparent bg-emerald-600 text-white">
              <SparklesIcon className="h-3 w-3" />
              {t("newTicket")}
            </Badge>
          ) : null}
          <Badge className={cn("border-transparent", STATUS_STYLES[ticket.status])}>
            {isTicketStatus(ticket.status) ? t(`status.${ticket.status}`) : ticket.status}
          </Badge>
        </div>
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{ticket.description}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">{ticket.category_name ?? t("noCategory")}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{ticket.contractor_name ?? t("noContractor")}</span>
        {ticket.priority ? (
          <Badge
            className={cn(
              "h-4 border-transparent px-1.5 text-[10px]",
              PRIORITY_STYLES[ticket.priority]
            )}
          >
            {isTriagePriority(ticket.priority) ? t(`priority.${ticket.priority}`) : ticket.priority}
          </Badge>
        ) : null}
        {ticket.was_corrected ? (
          <Badge
            data-testid="row-corrected"
            className="h-4 border-transparent bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400"
          >
            <PencilIcon className="h-2.5 w-2.5" />
            {t("corrected")}
          </Badge>
        ) : null}
        {ticket.has_photo ? (
          <ImageIcon className="text-muted-foreground h-3 w-3" aria-label={t("photo")} />
        ) : null}
        <span className="text-muted-foreground ml-auto text-[11px]">{created}</span>
      </div>
    </button>
  );
}

function DraftRow({ draft }: { draft: TriageDraft }) {
  const t = useTranslations("triage");
  const saving = draft.status !== "awaiting_decision";
  return (
    <div
      data-testid="draft-row"
      data-status={draft.status}
      className="rounded-lg border-2 border-dashed border-amber-500/60 bg-amber-500/5 p-2.5 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          {t("draft")}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {saving ? t("draftSaving") : t("draftAwaiting")}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-semibold">{draft.unit_label || "—"}</span>
        <span className="text-muted-foreground truncate text-xs">{draft.reporter_name}</span>
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{draft.description}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">
          {draft.category_name ?? draft.category_code ?? t("noCategory")}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {draft.contractor_name ?? draft.contractor_slug ?? t("noContractor")}
        </span>
        {draft.priority ? (
          <Badge
            className={cn(
              "h-4 border-transparent px-1.5 text-[10px]",
              PRIORITY_STYLES[draft.priority]
            )}
          >
            {isTriagePriority(draft.priority) ? t(`priority.${draft.priority}`) : draft.priority}
          </Badge>
        ) : null}
        {draft.has_photo ? (
          <ImageIcon className="text-muted-foreground h-3 w-3" aria-label={t("photo")} />
        ) : null}
      </div>
    </div>
  );
}
