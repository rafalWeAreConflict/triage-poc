// GET /api/copilotkit-skills — published Skills of the configured Learning
// Container (CopilotKit Intelligence Skill delivery) for the Django agent.
//
// Django pulls this server-to-server before each agent run (cached there for
// 60 s) with the run's own `Authorization: Session <key>`; a signed-in browser
// can open it too, to check what the agent will receive. Read-only, and it
// exposes no more than the Inspector's Automatic Learning pane already shows.
import { CopilotUnauthorizedError, resolveCopilotUser } from "@/copilot/agui-endpoint";
import { getPublishedSkills } from "@/copilot/learned-skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" };

/**
 * The browser authenticates with its cookies; Django's server hop sends
 * `Authorization: Session <key>`, which is the value the `backend_jwt` cookie
 * carries, so both resolve the user through the same `/app/copilot/whoami/`.
 */
function credentialCookies(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Session ")) return cookie;
  const backendJwt = `backend_jwt=${encodeURIComponent(authorization)}`;
  return cookie ? `${backendJwt}; ${cookie}` : backendJwt;
}

export async function GET(request: Request): Promise<Response> {
  try {
    await resolveCopilotUser(credentialCookies(request));
  } catch (err) {
    if (err instanceof CopilotUnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    }
    return Response.json({ error: "User lookup failed" }, { status: 502, headers: NO_STORE });
  }
  const payload = await getPublishedSkills();
  return Response.json(payload, { status: payload.status === "ok" ? 200 : 503, headers: NO_STORE });
}
