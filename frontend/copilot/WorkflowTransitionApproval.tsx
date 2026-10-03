"use client";

import { useTranslations } from "next-intl";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type WorkflowApprovalStatus = "pending" | "approved" | "denied" | "waiting";

export type WorkflowTransitionApprovalProps = {
  workflow?: string;
  fromState?: string;
  toState?: string;
  status: WorkflowApprovalStatus;
  onApprove: () => void;
  onDeny: () => void;
};

/**
 * Human-in-the-loop approve/deny surface for a workflow-transition confirmation.
 * Presentational only — the v2 `useHumanInTheLoop` glue (which calls
 * `respond({ approved })`) lives in `CopilotToolRenders`.
 */
export function WorkflowTransitionApproval({
  workflow,
  fromState,
  toState,
  status,
  onApprove,
  onDeny,
}: WorkflowTransitionApprovalProps) {
  const t = useTranslations("copilot.workflowApproval");

  return (
    <div className="bg-card text-card-foreground w-full rounded-lg border p-3 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        <div className="bg-primary/10 text-primary rounded-md p-1.5">
          <GitBranchIcon className="h-4 w-4" />
        </div>
        <span className="font-medium">{t("title")}</span>
      </div>

      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-1.5">
        <span className="bg-muted text-foreground rounded-md px-2 py-0.5 text-xs font-medium">
          {fromState ?? "—"}
        </span>
        <ArrowRightIcon className="h-3.5 w-3.5" />
        <span className="bg-primary/10 text-primary rounded-md px-2 py-0.5 text-xs font-medium">
          {toState ?? "—"}
        </span>
        {workflow ? <span className="text-xs">{t("on", { workflow })}</span> : null}
      </div>

      {status === "pending" ? (
        <div className="mt-3">
          <p className="text-muted-foreground mb-2 text-xs">{t("question")}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove} className="flex-1">
              {t("approve")}
            </Button>
            <Button size="sm" variant="outline" onClick={onDeny} className="flex-1">
              {t("deny")}
            </Button>
          </div>
        </div>
      ) : null}

      {status === "waiting" ? (
        <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          {t("waiting")}
        </p>
      ) : null}

      {status === "approved" ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon className="h-3.5 w-3.5" />
          {t("approved")}
        </p>
      ) : null}

      {status === "denied" ? (
        <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs font-medium">
          <XCircleIcon className="h-3.5 w-3.5" />
          {t("denied")}
        </p>
      ) : null}
    </div>
  );
}
