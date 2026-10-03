"use client";

import { useState } from "react";
import { z } from "zod";
import {
  ToolCallStatus,
  useDefaultRenderTool,
  useHumanInTheLoop,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import {
  COPILOT_TOOL_CONFIRM_TRANSITION,
  COPILOT_TOOL_CREATE_TICKET,
  COPILOT_TOOL_PROPOSE_TRIAGE,
} from "./config";
import {
  TriageProposalCard,
  triageProposalSchema,
  type TriageCardStatus,
  type TriageProposalArgs,
} from "./TriageProposalCard";
import { TicketCreatedCard, createTicketParamsSchema } from "./TicketCreatedCard";
import { ToolActivityChip } from "./ToolActivityChip";
import { parseToolResult } from "./toolResults";
import {
  WorkflowTransitionApproval,
  type WorkflowApprovalStatus,
} from "./WorkflowTransitionApproval";

// --- HITL wrapper: workflow-transition approval (v2) --------------------------

/**
 * Parameters of the `confirm_workflow_transition` frontend tool: the pass-through fields of the
 * backend's `confirmation_required` payload. The backend matches `instance_ref` and
 * `to_state_label` against the transition it is asked to run (copilot/approvals.py).
 */
export const workflowTransitionSchema = z.object({
  instance_ref: z
    .string()
    .describe(
      "Reference id of the workflow instance being transitioned (from the confirmation_required payload)."
    ),
  workflow_name: z.string().optional().describe("Human-readable name of the workflow."),
  from_state_label: z.string().optional().describe("Human-readable label of the current state."),
  to_state_label: z.string().optional().describe("Human-readable label of the target state."),
  label: z.string().optional().describe("Label of the transition being applied."),
  message: z.string().optional().describe("Optional additional context to show the human."),
});

export type WorkflowTransitionArgs = z.infer<typeof workflowTransitionSchema>;

/** The decision recorded in a completed call's result (survives thread replay). */
export function transitionDecision(result: unknown): "approved" | "denied" {
  return parseToolResult(result)?.approved === true ? "approved" : "denied";
}

export function WorkflowTransitionHITL({
  args,
  status,
  result,
  respond,
}: {
  args: Partial<WorkflowTransitionArgs>;
  status: ToolCallStatus;
  result?: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  const [decision, setDecision] = useState<null | "approved" | "denied">(null);

  const cardStatus: WorkflowApprovalStatus =
    decision ??
    (status === ToolCallStatus.Complete
      ? transitionDecision(result)
      : status === ToolCallStatus.Executing && respond
        ? "pending"
        : "waiting");

  const answer = (approved: boolean) => {
    setDecision(approved ? "approved" : "denied");
    void respond?.({ approved });
  };

  return (
    <WorkflowTransitionApproval
      workflow={args.workflow_name}
      fromState={args.from_state_label}
      toState={args.to_state_label}
      status={cardStatus}
      onApprove={() => answer(true)}
      onDeny={() => answer(false)}
    />
  );
}

// --- HITL wrapper: maps the v2 tool-call status onto the triage card ---------

export const PROPOSE_TRIAGE_DESCRIPTION =
  "Show the triage proposal (unit, reporter, description, category, priority, contractor, " +
  "reasoning) to the admin as a card and wait for their decision. Returns JSON " +
  '{decision: "approved" | "corrected", final: {category_code, priority, contractor_slug}, ' +
  "comment, message}. Call it after find_units, list_categories and list_contractors, and " +
  "BEFORE create_ticket; then call create_ticket with confirmed=true and the returned final values.";

export function TriageProposalHITL({
  args,
  status,
  result,
  respond,
}: {
  args: Partial<TriageProposalArgs>;
  status: ToolCallStatus;
  result?: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  const cardStatus: TriageCardStatus =
    status === ToolCallStatus.Complete
      ? "resolved"
      : status === ToolCallStatus.Executing && respond
        ? "pending"
        : "streaming";
  return (
    <TriageProposalCard
      args={args}
      status={cardStatus}
      result={result}
      onRespond={respond ? (response) => void respond(response) : undefined}
    />
  );
}

/**
 * Registers CopilotKit renders for the agent's tool calls. Renders nothing
 * itself — the output is injected into the chat stream by CopilotKit. Must be
 * mounted inside `<CopilotKit>`.
 */
export function CopilotToolRenders() {
  // Human-in-the-loop (v2): a genuine FRONTEND tool the agent calls to obtain human approval
  // BEFORE it executes the (backend-only) workflow transition. `respond` resumes the agent with
  // `{ approved }`, which drives its confirmed=true re-call. The resolved card is rebuilt from the
  // tool result, so it survives thread replay.
  useHumanInTheLoop<WorkflowTransitionArgs>({
    name: COPILOT_TOOL_CONFIRM_TRANSITION,
    description:
      "Ask the human to approve or deny a workflow transition before executing it; returns {approved}.",
    parameters: workflowTransitionSchema,
    render: WorkflowTransitionHITL,
  });

  // Human-in-the-loop generative UI (v2): a FRONTEND tool the agent calls with its triage
  // proposal; the agent run pauses until the admin approves or corrects it on the card.
  // The resolved card is rebuilt from the tool result, so it survives thread replay.
  useHumanInTheLoop<TriageProposalArgs>({
    name: COPILOT_TOOL_PROPOSE_TRIAGE,
    description: PROPOSE_TRIAGE_DESCRIPTION,
    parameters: triageProposalSchema,
    render: TriageProposalHITL,
  });

  // Visible tool activity (v2): every backend tool call without a dedicated renderer
  // (find_units, list_categories, list_contractors, list_tickets, the forms/workflow tools)
  // renders as a compact status chip in the stream.
  useDefaultRenderTool({
    render: ({ name, status, result }) => (
      <ToolActivityChip name={name} status={status} result={result} />
    ),
  });

  // Dedicated render for the backend create_ticket tool: the created ticket with its workflow
  // state and the "corrected by admin" badge. Render-only — not advertised as a frontend tool.
  useRenderTool({
    name: COPILOT_TOOL_CREATE_TICKET,
    parameters: createTicketParamsSchema,
    render: ({ status, parameters, result }) => (
      <TicketCreatedCard status={status} parameters={parameters} result={result} />
    ),
  });

  return null;
}
