// Server-only: Skill delivery for the Django (Pydantic AI) agent.
//
// CopilotKit Intelligence does not inject published Skills into the AG-UI
// request: the runtime only tags threads with the Learning Container
// (`getLearningContainerId`), and agents pull published Skills themselves
// through an Intelligence SDK adapter (docs: /intelligence/learned-skills).
// There is no Pydantic AI adapter, so this module uses the runtime's own
// SkillRegistry (the one the Mastra/LangGraph/BuiltInAgent adapters use) with
// the server-held project key, and `/api/copilotkit-skills` serves the
// verified snapshot to Django, which pulls it server-to-server.
import {
  SkillDeliveryError,
  SkillRegistry,
  type VerifiedSnapshot,
} from "@copilotkit/runtime/internal/learned-skills";
import { COPILOT_LEARNING_CONTAINER_ID, getIntelligence } from "@/copilot/intelligence";

/** Bounds on what is handed to the agent prompt. */
export const MAX_DELIVERED_SKILLS = 20;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 8000;

export type DeliveredSkill = {
  name: string;
  description: string;
  /** SKILL.md content (the Skill's instructions). */
  instructions: string;
  /** Supporting text files in the Skill bundle (paths only). */
  files: string[];
};

export type SkillDeliveryPayload =
  | {
      status: "ok";
      containerId: string;
      revision: string;
      mode: "latest" | "pinned";
      lastCheckedAt: string | null;
      stale: boolean;
      skills: DeliveredSkill[];
    }
  | {
      status: "error";
      containerId: string;
      error: { code: string; message: string; retryable: boolean };
      skills: [];
    };

let registry: SkillRegistry | undefined;

/**
 * One registry per server process: it caches the verified snapshot and
 * revalidates it with an ETag after the freshness window (5 s default), so a
 * newly published Skill revision is picked up without a restart.
 */
function getRegistry(): SkillRegistry | null {
  const client = getIntelligence();
  if (!client) return null;
  registry ??= new SkillRegistry({ client, containerId: COPILOT_LEARNING_CONTAINER_ID });
  return registry;
}

/** Project a verified snapshot into the bounded JSON the agent consumes. */
export function toDeliveredSkills(snapshot: VerifiedSnapshot): DeliveredSkill[] {
  return snapshot.skills.slice(0, MAX_DELIVERED_SKILLS).flatMap((skill) => {
    const body = skill.files.find((file) => file.path === "SKILL.md")?.text;
    if (body === undefined) return [];
    return [
      {
        name: skill.name,
        description: skill.description,
        instructions: body.slice(0, MAX_SKILL_INSTRUCTIONS_CHARS),
        files: skill.files
          .filter((file) => file.path !== "SKILL.md" && file.text !== undefined)
          .map((file) => file.path),
      },
    ];
  });
}

/** Fetch (or reuse) the container's published Skills. Never throws. */
export async function getPublishedSkills(): Promise<SkillDeliveryPayload> {
  const skillRegistry = getRegistry();
  if (!skillRegistry) {
    return {
      status: "error",
      containerId: COPILOT_LEARNING_CONTAINER_ID,
      error: {
        code: "NOT_CONFIGURED",
        message: "CPK_INTELLIGENCE_API_KEY is not set; Skill delivery is off.",
        retryable: false,
      },
      skills: [],
    };
  }
  try {
    const snapshot = await skillRegistry.acquireSnapshot();
    const status = skillRegistry.status;
    return {
      status: "ok",
      containerId: COPILOT_LEARNING_CONTAINER_ID,
      revision: snapshot.revision,
      mode: status.mode,
      lastCheckedAt: status.lastCheckedAt ?? null,
      stale: status.stale,
      skills: toDeliveredSkills(snapshot),
    };
  } catch (err) {
    const known = err instanceof SkillDeliveryError;
    return {
      status: "error",
      containerId: COPILOT_LEARNING_CONTAINER_ID,
      error: {
        code: known ? err.code : "NETWORK_ERROR",
        message: known ? err.message : "Skill delivery failed.",
        retryable: known ? err.retryable : true,
      },
      skills: [],
    };
  }
}
