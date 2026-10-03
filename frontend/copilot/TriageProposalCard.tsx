"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CheckCircle2Icon,
  GraduationCapIcon,
  ImageIcon,
  Loader2Icon,
  PencilIcon,
  WrenchIcon,
} from "lucide-react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTriageCategories, useTriageContractors } from "@/graphql/triage/triage.hooks";
import { parseToolResult } from "./toolResults";
import { TRIAGE_PRIORITIES, isTriagePriority } from "./triageState";

/**
 * Parameters of the `propose_triage` frontend HITL tool. The agent fills them from
 * find_units / list_categories / list_contractors results; ids are external only.
 */
export const triageProposalSchema = z.object({
  unit_guid: z.string().describe("Unit guid from find_units."),
  unit_label: z.string().describe('Unit label from find_units, e.g. "A/4".'),
  reporter_name: z.string().describe("Name of the resident reporting the issue."),
  description: z.string().describe("The defect description, in the resident's words."),
  category_code: z.string().describe("Proposed category code from list_categories."),
  priority: z.enum(TRIAGE_PRIORITIES).describe("Proposed priority: low / normal / high / urgent."),
  contractor_slug: z
    .string()
    .describe("Proposed contractor slug from list_contractors for that category."),
  reasoning: z.string().describe("Brief reasoning for the proposal (one or two sentences)."),
  photo_guid: z
    .string()
    .optional()
    .describe("photo_guid of an attached defect photo, if any (from the [photo_guid: ...] note)."),
});

export type TriageProposalArgs = z.infer<typeof triageProposalSchema>;

export type TriageDecision = {
  category_code: string;
  priority: string;
  contractor_slug: string;
};

type ChangedFields = Partial<
  Record<"category" | "priority" | "contractor", { from: string; to: string }>
>;

/** What the card hands back to the agent (JSON-serialised by CopilotKit). */
export type TriageResponse = {
  decision: "approved" | "corrected";
  proposal: TriageDecision & { reasoning: string };
  final: TriageDecision;
  changed_fields: ChangedFields;
  comment: string | null;
  message: string;
};

const FIELD_KEYS = [
  ["category", "category_code"],
  ["priority", "priority"],
  ["contractor", "contractor_slug"],
] as const;

function decisionOf(source: Partial<TriageDecision>): TriageDecision {
  return {
    category_code: source.category_code ?? "",
    priority: source.priority ?? "",
    contractor_slug: source.contractor_slug ?? "",
  };
}

function proposalOf(args: Partial<TriageProposalArgs>): TriageResponse["proposal"] {
  return { ...decisionOf(args), reasoning: args.reasoning ?? "" };
}

export function changedFields(proposal: TriageDecision, final: TriageDecision): ChangedFields {
  const changed: ChangedFields = {};
  for (const [field, key] of FIELD_KEYS) {
    if (proposal[key] !== final[key]) changed[field] = { from: proposal[key], to: final[key] };
  }
  return changed;
}

export function buildApprovedResponse(args: Partial<TriageProposalArgs>): TriageResponse {
  const proposal = proposalOf(args);
  const final = decisionOf(args);
  return {
    decision: "approved",
    proposal,
    final,
    changed_fields: {},
    comment: null,
    message:
      `Admin approved the triage proposal as-is: category ${final.category_code}, ` +
      `priority ${final.priority}, contractor ${final.contractor_slug}. ` +
      "Now call create_ticket with confirmed=true and final equal to the proposal.",
  };
}

/** Longest resident text quoted as the example in a lesson. */
const MAX_LESSON_EXAMPLE_CHARS = 160;

/**
 * The resident's text as a short, single-line quote. It comes from outside the cooperative
 * and ends up in the lesson Automatic Learning learns from, so it is kept to an example:
 * no line breaks, quotes or markup that could pass for instructions, and capped in length.
 */
export function lessonExample(text: string): string {
  const flat = text
    .replace(/["“”„«»`<>]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_LESSON_EXAMPLE_CHARS
    ? `${flat.slice(0, MAX_LESSON_EXAMPLE_CHARS - 1).trimEnd()}…`
    : flat;
}

/**
 * The corrected case is spelled out in natural language as well as JSON: CopilotKit
 * Intelligence (Automatic Learning) learns from what is in the thread.
 */
export function buildCorrectedResponse(
  args: Partial<TriageProposalArgs>,
  final: TriageDecision,
  comment: string
): TriageResponse {
  const proposal = proposalOf(args);
  const changed = changedFields(proposal, final);
  const diffs = Object.entries(changed)
    .map(([field, d]) => `${field} ${d!.from} → ${d!.to}`)
    .join(", ");
  const reason = comment.trim();
  const request = lessonExample(args.description ?? "");
  return {
    decision: "corrected",
    proposal,
    final,
    changed_fields: changed,
    comment: reason,
    message:
      `Admin corrected the AI triage proposal: ${diffs}. Reason: ${reason}. ` +
      `Lesson: for similar requests${request ? ` (like "${request}")` : ""} use category ` +
      `${final.category_code}, priority ${final.priority} and contractor ${final.contractor_slug}` +
      ` instead of ${proposal.category_code} / ${proposal.contractor_slug}. ` +
      "Now call create_ticket with confirmed=true, final = these corrected values and " +
      "admin_comment = the reason.",
  };
}

/** Parse the serialised tool result back into a TriageResponse (null when absent/invalid). */
export function parseTriageResponse(result: unknown): TriageResponse | null {
  const record = parseToolResult(result) as Partial<TriageResponse> | null;
  if (!record) return null;
  if (record.decision !== "approved" && record.decision !== "corrected") return null;
  if (!record.final || typeof record.final !== "object") return null;
  return {
    decision: record.decision,
    proposal: record.proposal ?? { ...decisionOf({}), reasoning: "" },
    final: decisionOf(record.final),
    changed_fields: record.changed_fields ?? {},
    comment: record.comment ?? null,
    message: record.message ?? "",
  };
}

/**
 * Approved CopilotKit Intelligence lessons the agent cites in its reasoning. The agent is told to
 * cite each applied lesson as "Lesson: <name>" (see backend/copilot/learned_skills.py); the Polish
 * "Lekcja:" is accepted too (older threads and Polish replies).
 */
const LESSON_CITATION =
  /(?:^|[^\p{L}])(?:lekcja|lesson)\s*:\s*["'„“«]?([\p{L}\p{N}][\p{L}\p{N}_\-./]*)/giu;

export function citedLessons(reasoning?: string | null): string[] {
  if (!reasoning) return [];
  const names = new Set<string>();
  for (const match of reasoning.matchAll(LESSON_CITATION)) {
    const name = match[1].replace(/[./]+$/, "");
    if (name) names.add(name);
  }
  return [...names];
}

export type TriageCardStatus = "streaming" | "pending" | "resolved";

export type TriageProposalCardProps = {
  args: Partial<TriageProposalArgs>;
  status: TriageCardStatus;
  /** Raw tool result (resolved state). */
  result?: unknown;
  onRespond?: (response: TriageResponse) => void;
};

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-secondary text-secondary-foreground",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  urgent: "bg-destructive/15 text-destructive",
};

const SELECT_CLASS =
  "border-input bg-background focus-visible:ring-ring/50 h-8 w-full rounded-md border px-2 text-sm " +
  "outline-none focus-visible:ring-[3px]";

/**
 * Generative-UI + human-in-the-loop card for a triage proposal. The admin either approves
 * it as-is ("Approve") or corrects category / priority / contractor with a required
 * comment ("Correct"). Resolved calls (incl. threads reopened from the drawer) render a
 * read-only summary rebuilt from the tool result.
 */
export function TriageProposalCard({ args, status, result, onRespond }: TriageProposalCardProps) {
  const t = useTranslations("copilot.triage");
  const { categories } = useTriageCategories();
  const { contractors } = useTriageContractors();

  const [editing, setEditing] = useState(false);
  const [submitted, setSubmitted] = useState<TriageResponse | null>(null);
  const [draft, setDraft] = useState<TriageDecision>(() => decisionOf(args));
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const response = submitted ?? (status === "resolved" ? parseTriageResponse(result) : null);
  const shown: TriageDecision = response ? response.final : decisionOf(args);

  const categoryName = (code: string) => categories.find((c) => c.code === code)?.name ?? code;
  const contractorName = (slug: string) => contractors.find((c) => c.slug === slug)?.name ?? slug;
  const priorityLabel = (p: string) => (isTriagePriority(p) ? t(`priority.${p}`) : p);

  const contractorOptions = useMemo(
    () => contractors.filter((c) => c.categoryCode === draft.category_code),
    [contractors, draft.category_code]
  );

  const respond = (payload: TriageResponse) => {
    setSubmitted(payload);
    setEditing(false);
    onRespond?.(payload);
  };

  const startEditing = () => {
    setDraft(decisionOf(args));
    setComment("");
    setError(null);
    setEditing(true);
  };

  const saveCorrection = () => {
    if (!comment.trim()) {
      setError(t("commentRequired"));
      return;
    }
    if (!draft.contractor_slug) {
      setError(t("contractorRequired"));
      return;
    }
    if (Object.keys(changedFields(decisionOf(args), draft)).length === 0) {
      setError(t("nothingChanged"));
      return;
    }
    respond(buildCorrectedResponse(args, draft, comment));
  };

  const interactive = status === "pending" && !submitted && Boolean(onRespond);
  const lessons = citedLessons(args.reasoning);

  return (
    <div className="bg-card text-card-foreground w-full rounded-lg border p-3 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-primary/10 text-primary rounded-md p-1.5">
            <WrenchIcon className="h-4 w-4" />
          </div>
          <span className="truncate font-medium">{t("title")}</span>
        </div>
        {shown.priority ? (
          <Badge
            data-testid="triage-priority"
            className={cn("shrink-0 border-transparent", PRIORITY_STYLES[shown.priority])}
          >
            {priorityLabel(shown.priority)}
          </Badge>
        ) : null}
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("unit")}</dt>
        <dd className="font-medium">{args.unit_label ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("reporter")}</dt>
        <dd>{args.reporter_name ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("description")}</dt>
        <dd className="whitespace-pre-wrap">{args.description ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("category")}</dt>
        <dd data-testid="triage-category">
          {shown.category_code ? categoryName(shown.category_code) : "—"}
        </dd>
        <dt className="text-muted-foreground">{t("contractor")}</dt>
        <dd data-testid="triage-contractor">
          {shown.contractor_slug ? contractorName(shown.contractor_slug) : "—"}
        </dd>
        {args.photo_guid ? (
          <>
            <dt className="text-muted-foreground">{t("photo")}</dt>
            <dd className="flex items-center gap-1">
              <ImageIcon className="h-3.5 w-3.5" />
              {t("photoAttached")}
            </dd>
          </>
        ) : null}
      </dl>

      {lessons.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <Badge
            data-testid="triage-lesson-applied"
            title={lessons.join(", ")}
            className="border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300"
          >
            <GraduationCapIcon className="h-3 w-3" />
            {t("lessonApplied")}
          </Badge>
          <span className="text-muted-foreground truncate">{lessons.join(", ")}</span>
        </div>
      ) : null}

      {args.reasoning ? (
        <p className="bg-muted/50 mt-2 rounded-md p-2 text-xs">
          <span className="text-muted-foreground">{t("reasoning")}: </span>
          {args.reasoning}
        </p>
      ) : null}

      {status === "streaming" ? (
        <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          {t("preparing")}
        </p>
      ) : null}

      {interactive && !editing ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => respond(buildApprovedResponse(args))}>
            {t("approve")}
          </Button>
          <Button size="sm" variant="outline" className="flex-1" onClick={startEditing}>
            <PencilIcon className="h-3.5 w-3.5" />
            {t("correct")}
          </Button>
        </div>
      ) : null}

      {interactive && editing ? (
        <div className="mt-3 space-y-2" data-testid="triage-correction-form">
          <label className="block text-xs">
            <span className="text-muted-foreground">{t("category")}</span>
            <select
              aria-label={t("category")}
              className={SELECT_CLASS}
              value={draft.category_code}
              onChange={(e) => {
                const category_code = e.target.value;
                const first = contractors.find((c) => c.categoryCode === category_code);
                setDraft((d) => ({ ...d, category_code, contractor_slug: first?.slug ?? "" }));
              }}
            >
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">{t("priorityLabel")}</span>
            <select
              aria-label={t("priorityLabel")}
              className={SELECT_CLASS}
              value={draft.priority}
              onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
            >
              {TRIAGE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">{t("contractor")}</span>
            <select
              aria-label={t("contractor")}
              className={SELECT_CLASS}
              value={draft.contractor_slug}
              onChange={(e) => setDraft((d) => ({ ...d, contractor_slug: e.target.value }))}
            >
              {contractorOptions.length === 0 ? <option value="">—</option> : null}
              {contractorOptions.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">{t("comment")}</span>
            <Textarea
              aria-label={t("comment")}
              className="mt-0.5 min-h-16 text-sm"
              placeholder={t("commentPlaceholder")}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setError(null);
              }}
            />
          </label>
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={saveCorrection}>
              {t("saveCorrection")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {response ? <ResolvedSummary response={response} /> : null}
    </div>
  );
}

function ResolvedSummary({ response }: { response: TriageResponse }) {
  const t = useTranslations("copilot.triage");
  const changes = Object.entries(response.changed_fields);
  if (response.decision === "approved") {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2Icon className="h-3.5 w-3.5" />
        {t("approved")}
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
        <PencilIcon className="h-3.5 w-3.5" />
        {t("corrected")}
      </p>
      {changes.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {changes.map(([field, d]) => (
            <li key={field}>
              <span className="text-muted-foreground">{t(`field.${field}`)}:</span>{" "}
              <span className="line-through opacity-70">{d!.from}</span> → {d!.to}
            </li>
          ))}
        </ul>
      ) : null}
      {response.comment ? (
        <p className="mt-1">
          <span className="text-muted-foreground">{t("comment")}:</span> {response.comment}
        </p>
      ) : null}
    </div>
  );
}
