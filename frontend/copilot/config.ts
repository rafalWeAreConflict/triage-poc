// Client-safe CopilotKit configuration.
//
// This module is imported by both client components (the provider/sidebar) and
// the server route handler, so it must not touch server-only APIs. Server-only
// helpers (backend URL + cookie forwarding) live in `./agui-endpoint.ts`.

/**
 * Name the AG-UI agent is registered under in the CopilotRuntime `agents` map.
 * The `<CopilotKit agent={...}>` prop must match this exact key.
 */
export const COPILOT_AGENT_NAME = "boilerworks_agent";

/**
 * Same-origin Next.js route that hosts the self-hosted CopilotRuntime.
 * Used both as the provider `runtimeUrl` and as the runtime `endpoint`.
 */
export const COPILOT_RUNTIME_URL = "/api/copilotkit";

/**
 * Genuine FRONTEND tool. The agent calls this to obtain human approval before it
 * executes a workflow transition. Because it is advertised as a real frontend
 * tool (NOT `available: "disabled"`), its name must NOT collide with any backend
 * tool name in `backend/copilot/agent.py` — pydantic-ai rejects duplicate tool
 * names. The backend `execute_workflow_transition` tool stays backend-only; the
 * agent bridges the two: `execute_workflow_transition` (unconfirmed) →
 * `confirm_workflow_transition` → on `{ approved: true }` re-call
 * `execute_workflow_transition` with `confirmed=true`.
 */
export const COPILOT_TOOL_CONFIRM_TRANSITION = "confirm_workflow_transition";

/**
 * Genuine FRONTEND tool (human-in-the-loop generative UI, v2 `useHumanInTheLoop`).
 * The agent calls it with its triage proposal; the TriageProposalCard lets the admin
 * approve or correct it and returns the decision. Only then does the agent call the
 * backend `create_ticket` (confirmed=true). Its name must NOT collide with any backend
 * tool name (`backend/copilot/agent.py` + `backend/copilot/triage_tools.py`).
 */
export const COPILOT_TOOL_PROPOSE_TRIAGE = "propose_triage";

/**
 * Backend tool with a dedicated render (`TicketCreatedCard` via v2 `useRenderTool`). The other
 * backend tools render through the `useDefaultRenderTool` fallback (compact activity chips).
 */
export const COPILOT_TOOL_CREATE_TICKET = "create_ticket";

/**
 * Routes that embed their own v2 `<CopilotChat>`; the global `CopilotSidebar` is not mounted there.
 */
export const COPILOT_EMBEDDED_CHAT_ROUTES = ["/triage"] as const;

/**
 * Backend triage tools (`backend/copilot/triage_tools.py`), mirrored for reference:
 * they are not rendered by the frontend, but a frontend tool must never reuse a name.
 */
export const COPILOT_BACKEND_TRIAGE_TOOLS = [
  "list_categories",
  "list_contractors",
  "find_units",
  "list_tickets",
  "create_ticket",
] as const;

/**
 * Feature flag. The copilot surface is optional, mirroring how the template
 * gates other optional features. `NEXT_PUBLIC_COPILOT_ENABLED` is inlined at
 * build time, so this returns the same value on server and client.
 */
export function isCopilotEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COPILOT_ENABLED === "true";
}

/**
 * Optional CopilotKit Cloud public API key (`cpk-…`). NOT required — the
 * template self-hosts the runtime and the LLM lives in the Django agent.
 * Set `NEXT_PUBLIC_COPILOTKIT_API_KEY` (e.g. in `.env.local`) only to enable
 * Copilot Cloud features during development/testing.
 */
export function copilotPublicApiKey(): string | undefined {
  return process.env.NEXT_PUBLIC_COPILOTKIT_API_KEY || undefined;
}
