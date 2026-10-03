// Server-only: the CopilotKit Intelligence client shared by the runtime route
// (`/api/copilotkit/*`) and the Skill delivery route (`/api/copilotkit-skills`).
// It holds the project key from `CPK_INTELLIGENCE_API_KEY`; never import this
// module from a client component.
//
// Intelligence is optional. Without the key the runtime runs in SSE mode: the
// chat, tools and human-in-the-loop cards work, but there are no durable
// threads (no threads drawer), no Automatic Learning and no Skill delivery.
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { COPILOT_AGENT_NAME } from "@/copilot/config";
import { isIntelligenceConfigured } from "@/copilot/agui-endpoint";

/**
 * Learning Container (created on the Intelligence platform) that collects
 * threads from the boilerworks agent for Automatic Learning, and whose
 * published Skills are delivered back to the same agent. Override with
 * `COPILOT_LEARNING_CONTAINER_ID` to start a fresh learning space.
 */
export const COPILOT_LEARNING_CONTAINER_ID =
  process.env.COPILOT_LEARNING_CONTAINER_ID?.trim() || "triage-demo-2";

let client: CopilotKitIntelligence | undefined;

/**
 * The process-wide Intelligence client (it holds no per-request state), or
 * `null` when `CPK_INTELLIGENCE_API_KEY` is not set. Created on first use, so
 * importing this module never fails (e.g. during `next build` without the key).
 */
export function getIntelligence(): CopilotKitIntelligence | null {
  if (!isIntelligenceConfigured()) return null;
  client ??= new CopilotKitIntelligence({
    apiKey: process.env.CPK_INTELLIGENCE_API_KEY!.trim(),
    getLearningContainerId: ({ agentId }) =>
      agentId === COPILOT_AGENT_NAME ? COPILOT_LEARNING_CONTAINER_ID : undefined,
  });
  return client;
}
