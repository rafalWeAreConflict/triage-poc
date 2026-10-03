import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  type CopilotKitIntelligence,
} from "@copilotkit/runtime/v2";
import { HttpAgent } from "@ag-ui/client";
import type { NextRequest } from "next/server";
import { COPILOT_AGENT_NAME, COPILOT_RUNTIME_URL } from "@/copilot/config";
import {
  CopilotUnauthorizedError,
  buildForwardedHeaders,
  getCopilotBackendUrl,
  resolveCopilotUser,
  type CopilotUser,
} from "@/copilot/agui-endpoint";
// Shared Intelligence client + Learning Container (`COPILOT_LEARNING_CONTAINER_ID`, Automatic Learning).
// `null` without CPK_INTELLIGENCE_API_KEY: the runtime then runs in SSE mode.
import { getIntelligence } from "@/copilot/intelligence";

// The runtime does a server-to-server fetch to Django and relies on Node APIs.
export const runtime = "nodejs";
// Reads per-request cookies — never statically cache this route.
export const dynamic = "force-dynamic";

/**
 * Resolve the Django user once per request. The auth hook awaits it (to answer
 * 401 for a missing or stale session) and `identifyUser` reuses the same
 * promise, so Django is asked only once.
 */
const usersByRequest = new WeakMap<Request, Promise<CopilotUser>>();
function userFor(request: Request): Promise<CopilotUser> {
  let user = usersByRequest.get(request);
  if (!user) {
    user = resolveCopilotUser(request.headers.get("cookie") ?? "");
    usersByRequest.set(request, user);
  }
  return user;
}

/**
 * Answer 404 unless the thread belongs to this user and agent. The platform's
 * `getThread` is scoped by `userId` (another user's thread is a 404), the same
 * check the runtime's own agent/stop handler uses.
 */
async function requireOwnThread(
  intelligence: CopilotKitIntelligence,
  threadId: string,
  userId: string
): Promise<void> {
  const notFound = new Response("Thread not found", { status: 404 });
  let agentId: string | undefined;
  try {
    ({ agentId } = await intelligence.getThread({ threadId, userId }));
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) throw notFound;
    throw err;
  }
  if (agentId !== undefined && agentId !== COPILOT_AGENT_NAME) throw notFound;
}

const handle = async (req: NextRequest): Promise<Response> => {
  // Build the runtime per-request so the incoming session cookies are forwarded
  // to Django on the runtime -> backend hop (they are not forwarded by default).
  const forwardedHeaders = buildForwardedHeaders(req.headers.get("cookie") ?? "");

  const agents = {
    [COPILOT_AGENT_NAME]: new HttpAgent({
      url: getCopilotBackendUrl(),
      headers: forwardedHeaders,
    }),
  };
  const intelligence = getIntelligence();
  const copilotRuntime = intelligence
    ? new CopilotRuntime({
        agents,
        intelligence,
        // Threads are scoped to the Django user the forwarded session resolves to.
        identifyUser: (request) => userFor(request),
      })
    : // SSE mode: chat, tools and HITL cards work; no durable threads or learning.
      new CopilotRuntime({ agents });

  // Multi-route (the default mode): GET /info, GET /threads/:id/events, ...
  // under basePath, served by this optional catch-all route.
  const handler = createCopilotRuntimeHandler({
    runtime: copilotRuntime,
    basePath: COPILOT_RUNTIME_URL,
    hooks: {
      onBeforeHandler: async ({ request, route }) => {
        // Discovery stays public so the provider can detect the transport.
        if (route.method === "info") return;
        let user: CopilotUser;
        try {
          user = await userFor(request);
        } catch (err) {
          // The runtime turns identifyUser failures into a 500; a missing or
          // stale session is answered here as 401 instead.
          if (err instanceof CopilotUnauthorizedError) {
            throw new Response("Unauthorized", { status: 401 });
          }
          throw err;
        }
        if (!route.method.startsWith("threads/")) return;
        // Thread storage is an Intelligence feature; SSE mode has none to serve.
        if (!intelligence) throw new Response("Not found", { status: 404 });
        // These two read a thread by id alone; every other thread route is
        // already scoped to the user by the runtime.
        if (route.method === "threads/events" || route.method === "threads/state") {
          await requireOwnThread(intelligence, route.threadId, user.id);
        }
      },
    },
  });

  return handler(req);
};

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
