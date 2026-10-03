"use client";

import { useTranslations } from "next-intl";
import {
  CheckCircle2Icon,
  ImageIcon,
  Loader2Icon,
  PencilIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTriageCategories, useTriageContractors } from "@/graphql/triage/triage.hooks";
import type { ToolActivityStatus } from "./ToolActivityChip";
import { parseToolResult } from "./toolResults";
import { isTicketStatus, isTriagePriority } from "./triageState";

/**
 * Typing for the backend `create_ticket` arguments (only what the card reads). The backend owns
 * the real schema (backend/copilot/triage_tools.py), so everything is optional here.
 */
export const createTicketParamsSchema = z.object({
  unit_guid: z.string().optional(),
  reporter_name: z.string().optional(),
  description: z.string().optional(),
  final: z
    .object({
      category_code: z.string().optional(),
      priority: z.string().optional(),
      contractor_slug: z.string().optional(),
    })
    .partial()
    .optional(),
  admin_comment: z.string().nullable().optional(),
  confirmed: z.boolean().optional(),
});

export type CreateTicketParams = z.infer<typeof createTicketParamsSchema>;

/** The backend `create_ticket` result (status "ok"), see `_create_ticket_sync`. */
export type CreateTicketResult = {
  status: string;
  ticket_guid?: string;
  state?: string;
  unit?: string;
  category_code?: string;
  priority?: string;
  contractor_slug?: string;
  was_corrected?: boolean;
  has_photo?: boolean;
  message?: string;
};

export function parseCreateTicketResult(result: unknown): CreateTicketResult | null {
  const record = parseToolResult(result);
  return typeof record?.status === "string" ? (record as CreateTicketResult) : null;
}

/**
 * Dedicated render for the backend `create_ticket` tool (v2 `useRenderTool`): spinner while the
 * ticket is being created, then unit, category, contractor, priority and workflow state, with a
 * "corrected by admin" badge when the admin changed the AI proposal.
 */
export function TicketCreatedCard({
  status,
  parameters,
  result,
}: {
  status: ToolActivityStatus;
  parameters?: Partial<CreateTicketParams>;
  result?: unknown;
}) {
  const t = useTranslations("copilot.ticketCreated");
  const tt = useTranslations("triage");
  const { categories } = useTriageCategories();
  const { contractors } = useTriageContractors();

  if (status !== "complete") {
    return (
      <div
        className="text-muted-foreground my-1 flex items-center gap-1.5 text-xs"
        data-testid="ticket-creating"
      >
        <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
        {t("creating")}
      </div>
    );
  }

  const res = parseCreateTicketResult(result);
  if (!res || res.status !== "ok") {
    // confirmation_required is the HITL gate (nothing written) — still a "not created" outcome.
    return (
      <div
        data-testid="ticket-failed"
        className="border-destructive/40 text-destructive my-1 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs"
      >
        <TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <span className="font-medium">{t("failed")}</span>
          {res?.message ? `: ${res.message}` : null}
        </span>
      </div>
    );
  }

  const categoryCode = res.category_code ?? parameters?.final?.category_code ?? "";
  const contractorSlug = res.contractor_slug ?? parameters?.final?.contractor_slug ?? "";
  const priority = res.priority ?? parameters?.final?.priority ?? "";
  const state = res.state ?? "";
  const categoryName = categories.find((c) => c.code === categoryCode)?.name ?? categoryCode;
  const contractorName = contractors.find((c) => c.slug === contractorSlug)?.name ?? contractorSlug;

  return (
    <div
      data-testid="ticket-created"
      className="bg-card text-card-foreground my-1 w-full rounded-lg border border-emerald-500/40 p-3 text-sm shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CheckCircle2Icon className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="truncate font-medium">{t("title")}</span>
        </div>
        {res.was_corrected ? (
          <Badge
            data-testid="ticket-corrected"
            className="shrink-0 border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
          >
            <PencilIcon className="h-3 w-3" />
            {t("corrected")}
          </Badge>
        ) : null}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("unit")}</dt>
        <dd className="font-medium">{res.unit ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("category")}</dt>
        <dd>{categoryName || "—"}</dd>
        <dt className="text-muted-foreground">{t("contractor")}</dt>
        <dd>{contractorName || "—"}</dd>
        <dt className="text-muted-foreground">{t("priority")}</dt>
        <dd>{isTriagePriority(priority) ? tt(`priority.${priority}`) : priority || "—"}</dd>
        <dt className="text-muted-foreground">{t("state")}</dt>
        <dd>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-medium",
              state === "approved"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-muted"
            )}
          >
            {isTicketStatus(state) ? tt(`status.${state}`) : state || "—"}
          </span>
        </dd>
      </dl>
      {res.has_photo ? (
        <p className="text-muted-foreground mt-2 flex items-center gap-1 text-xs">
          <ImageIcon className="h-3.5 w-3.5" />
          {t("photo")}
        </p>
      ) : null}
      {res.message ? <p className="text-muted-foreground mt-2 text-xs">{res.message}</p> : null}
    </div>
  );
}
