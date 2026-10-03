"use client";

import { useTranslations } from "next-intl";
import { CheckIcon, Loader2Icon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { COPILOT_BACKEND_TRIAGE_TOOLS } from "./config";
import { parseToolResult } from "./toolResults";

export type ToolActivityStatus = "inProgress" | "executing" | "complete";

type Outcome = { kind: "ok" | "denied" | "failed"; summary?: string; count?: number };

/** Status + a short summary of a (backend-owned) tool result: unit labels, list counts, errors. */
export function summariseToolResult(result: unknown): Outcome {
  const record = parseToolResult(result);
  if (!record) return { kind: "ok" };
  const status = record.status;
  if (status === "permission_denied") return { kind: "denied" };
  if (status === "error" || status === "not_found" || status === "invalid_schema") {
    return {
      kind: "failed",
      summary: typeof record.message === "string" ? record.message : undefined,
    };
  }
  if (Array.isArray(record.units)) {
    const labels = record.units
      .map((u) => (u && typeof u === "object" ? (u as { label?: unknown }).label : undefined))
      .filter((l): l is string => typeof l === "string");
    if (labels.length > 0 && labels.length <= 3) return { kind: "ok", summary: labels.join(", ") };
    return { kind: "ok", count: labels.length };
  }
  const list = Object.values(record).find(Array.isArray);
  return list ? { kind: "ok", count: list.length } : { kind: "ok" };
}

/**
 * Compact, single-line activity chip for a backend tool call in the chat stream (the
 * `useDefaultRenderTool` fallback): spinner while it runs, then a check (or an error/permission
 * marker) with a short summary of the result.
 */
export function ToolActivityChip({
  name,
  status,
  result,
}: {
  name: string;
  status: ToolActivityStatus;
  result?: unknown;
}) {
  const t = useTranslations("copilot.tool");
  // The triage tools have a translated label under `copilot.tool.names`.
  const label = (COPILOT_BACKEND_TRIAGE_TOOLS as readonly string[]).includes(name)
    ? t(`names.${name}`)
    : name;
  const done = status === "complete";
  const outcome = done ? summariseToolResult(result) : null;

  const icon = !done ? (
    <Loader2Icon className="h-3 w-3 animate-spin" />
  ) : outcome?.kind === "denied" ? (
    <ShieldAlertIcon className="h-3 w-3" />
  ) : outcome?.kind === "failed" ? (
    <TriangleAlertIcon className="h-3 w-3" />
  ) : (
    <CheckIcon className="h-3 w-3" />
  );

  const detail = !done
    ? t("running")
    : outcome?.kind === "denied"
      ? t("denied")
      : outcome?.kind === "failed"
        ? (outcome.summary ?? t("failed"))
        : outcome?.summary
          ? outcome.summary
          : outcome?.count !== undefined
            ? t("results", { count: outcome.count })
            : null;

  return (
    <div
      data-testid="tool-chip"
      data-tool={name}
      data-status={status}
      className={cn(
        "bg-muted/60 text-muted-foreground my-1 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
        outcome?.kind === "failed" && "border-destructive/40 text-destructive",
        outcome?.kind === "denied" && "border-amber-500/40 text-amber-700 dark:text-amber-400"
      )}
    >
      <span className={cn("shrink-0", done && outcome?.kind === "ok" && "text-emerald-600")}>
        {icon}
      </span>
      <span className="text-foreground font-medium">{label}</span>
      <code className="text-[10px] opacity-70">{name}</code>
      {detail ? <span className="truncate">· {detail}</span> : null}
    </div>
  );
}
