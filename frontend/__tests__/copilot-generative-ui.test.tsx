// Covers the copilot generative-UI surfaces:
//   - the workflow-transition HITL approve/deny component in both its
//     interactive (pending) and resolved (approved / denied) states,
//   - the CopilotToolRenders wiring: the `confirm_workflow_transition` frontend
//     tool registered via v2 useHumanInTheLoop (parameter schema, args-driven
//     card, approved/denied respond payloads, the resolved card on thread
//     replay). `draft_form_definition` has no dedicated render any more (the
//     forms UI was removed); it falls back to the default tool-activity chip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactElement } from "react";
import { z } from "zod";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "@/messages/en.json";
import { WorkflowTransitionApproval } from "@/copilot/WorkflowTransitionApproval";
import { COPILOT_TOOL_CONFIRM_TRANSITION } from "@/copilot/config";

// Capture every v2 useHumanInTheLoop registration so the render components can be
// exercised directly, without a live CopilotKit provider.
const { registered } = vi.hoisted(() => ({ registered: [] as unknown[] }));
vi.mock("@copilotkit/react-core/v2", () => ({
  useHumanInTheLoop: (tool: unknown) => {
    registered.push(tool);
  },
  useDefaultRenderTool: () => {},
  useRenderTool: () => {},
  ToolCallStatus: { InProgress: "inProgress", Executing: "executing", Complete: "complete" },
}));

// vitest.config.ts does not enable `globals`, so @testing-library/react's
// auto-cleanup is not registered — unmount between tests explicitly.
afterEach(cleanup);

function renderIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe("WorkflowTransitionApproval (HITL)", () => {
  it("pending: renders the transition and fires approve/deny callbacks", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    renderIntl(
      <WorkflowTransitionApproval
        workflow="Invoice"
        fromState="draft"
        toState="in_review"
        status="pending"
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );

    expect(screen.getByText("draft")).toBeTruthy();
    expect(screen.getByText("in_review")).toBeTruthy();
    expect(screen.getByText("on Invoice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("approved: shows the resolved message and hides the action buttons", () => {
    renderIntl(
      <WorkflowTransitionApproval status="approved" onApprove={() => {}} onDeny={() => {}} />
    );

    expect(screen.getByText("Transition approved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("denied: shows the denied message", () => {
    renderIntl(
      <WorkflowTransitionApproval status="denied" onApprove={() => {}} onDeny={() => {}} />
    );

    expect(screen.getByText("Transition denied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });
});

// --- CopilotToolRenders wiring ---------------------------------------------

type RenderProps = {
  args: Record<string, unknown>;
  status: string;
  result?: string;
  respond?: (result: unknown) => Promise<void>;
};

type CapturedTool = {
  name: string;
  description?: string;
  parameters?: z.ZodObject<z.ZodRawShape>;
  render: ComponentType<RenderProps>;
};

function getTool(name: string): CapturedTool {
  const found = registered.find((t) => (t as CapturedTool).name === name);
  if (!found) throw new Error(`useHumanInTheLoop was not registered for "${name}"`);
  return found as CapturedTool;
}

describe("CopilotToolRenders", () => {
  beforeEach(async () => {
    registered.length = 0;
    const { CopilotToolRenders } = await import("@/copilot/CopilotToolRenders");
    render(<CopilotToolRenders />);
    cleanup();
  });

  describe("confirm_workflow_transition (frontend HITL tool)", () => {
    const ARGS = {
      instance_ref: "WI-1",
      workflow_name: "Invoice",
      from_state_label: "Draft",
      to_state_label: "In review",
    };

    it("registers under the frontend tool name with the agreed parameter schema", () => {
      const tool = getTool(COPILOT_TOOL_CONFIRM_TRANSITION);
      expect(tool.name).toBe("confirm_workflow_transition");
      expect(tool.description).toMatch(/approve or deny/i);

      const shape = tool.parameters!.shape;
      expect(Object.keys(shape)).toEqual([
        "instance_ref",
        "workflow_name",
        "from_state_label",
        "to_state_label",
        "label",
        "message",
      ]);
      expect(shape.instance_ref.isOptional()).toBe(false);
      for (const key of [
        "workflow_name",
        "from_state_label",
        "to_state_label",
        "label",
        "message",
      ]) {
        expect(shape[key].isOptional()).toBe(true);
      }
    });

    it("renders the approval card from args and responds { approved: true } on approve", () => {
      const { render: Card } = getTool(COPILOT_TOOL_CONFIRM_TRANSITION);
      const respond = vi.fn(async () => {});
      renderIntl(<Card args={ARGS} status="executing" respond={respond} />);

      expect(screen.getByText("Draft")).toBeTruthy();
      expect(screen.getByText("In review")).toBeTruthy();
      expect(screen.getByText("on Invoice")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(respond).toHaveBeenCalledWith({ approved: true });
      expect(screen.getByText("Transition approved")).toBeTruthy();
    });

    it("responds { approved: false } on deny", () => {
      const { render: Card } = getTool(COPILOT_TOOL_CONFIRM_TRANSITION);
      const respond = vi.fn(async () => {});
      renderIntl(<Card args={ARGS} status="executing" respond={respond} />);

      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
      expect(respond).toHaveBeenCalledWith({ approved: false });
    });

    it("shows a spinner and no buttons while the call is still streaming", () => {
      const { render: Card } = getTool(COPILOT_TOOL_CONFIRM_TRANSITION);
      renderIntl(<Card args={ARGS} status="inProgress" />);
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("rebuilds the decision from the result when a thread is replayed", () => {
      const { render: Card } = getTool(COPILOT_TOOL_CONFIRM_TRANSITION);
      renderIntl(
        <Card args={ARGS} status="complete" result={JSON.stringify({ approved: true })} />
      );
      expect(screen.getByText("Transition approved")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      cleanup();
      renderIntl(
        <Card args={ARGS} status="complete" result={JSON.stringify({ approved: false })} />
      );
      expect(screen.getByText("Transition denied")).toBeTruthy();
    });
  });

  it("registers no dedicated draft_form_definition render (default chip fallback)", () => {
    const names = registered.map((t) => (t as CapturedTool).name);
    expect(names).toContain(COPILOT_TOOL_CONFIRM_TRANSITION);
    expect(names).not.toContain("draft_form_definition");
  });
});
