// Server-only helpers for the CopilotKit -> Django AG-UI bridge.
//
// The browser calls the same-origin `/api/copilotkit` route, so it forwards the
// Django session cookie automatically. The runtime's server-to-server fetch to
// Django does NOT forward those cookies, so we read them off the incoming
// request and inject them into the downstream AG-UI request. This mirrors how
// the Apollo server client re-attaches auth on the RSC hop.
import { serverApiRoot } from "@/lib/api-root";

/**
 * Resolve the Django AG-UI endpoint.
 *
 * Defaults to the `/app/` mount used by every other backend route in this
 * template (GraphQL lives at `${NEXT_PUBLIC_API_ROOT}/app/gql/config/`).
 * `COPILOT_AGUI_URL` overrides the whole URL when the AG-UI endpoint is mounted
 * elsewhere or served by a separate host.
 *
 * Throws when neither env var yields an absolute origin: falling back to a
 * relative `/app/copilot/agui/` would hand HttpAgent's Node `fetch` a URL it
 * cannot parse, surfacing as a cryptic runtime 500. Fail loudly at the source.
 */
export function getCopilotBackendUrl(): string {
  const override = process.env.COPILOT_AGUI_URL?.trim();
  if (override) return override;
  const apiRoot = serverApiRoot();
  if (!apiRoot) {
    throw new Error(
      "Copilot backend URL is not configured. Set NEXT_PUBLIC_API_ROOT to the Django " +
        "origin (e.g. http://localhost:8000), or COPILOT_AGUI_URL to the full AG-UI " +
        "endpoint URL when it is served elsewhere."
    );
  }
  return `${apiRoot}/app/copilot/agui/`;
}

/**
 * True when the CopilotKit Intelligence project key is set (server env only).
 * Without it the copilot still works, minus threads, learning and Skills.
 */
export function isIntelligenceConfigured(): boolean {
  return Boolean(process.env.CPK_INTELLIGENCE_API_KEY?.trim());
}

/**
 * Read a single cookie value out of a raw `Cookie` header. Returns null when the
 * header is empty or the cookie is absent.
 */
export function readCookie(cookieHeader: string, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Build the headers attached to the downstream AG-UI request.
 *
 * - `Authorization` carries the `backend_jwt` cookie value — the full
 *   `Session <session_key>` string auth1 issued at login. This is what
 *   actually authenticates the server-to-server hop: Django's session cookie
 *   lives on the backend origin and never reaches this route, and
 *   `Auth0SessionMiddleware` resolves `Authorization: Session <key>` exactly
 *   like the Apollo clients do.
 * - `Cookie` carries only the Django cookies (`sessionid`, `csrftoken`), for
 *   same-origin/proxied deploys where the Django session does ride along.
 *   Anything else in the browser's jar (analytics, other apps on the host)
 *   stays out of the backend hop.
 * - `X-CSRFToken` mirrors the `csrftoken` cookie so Django's session-auth CSRF
 *   check passes on this POST. Harmless when the backend exempts the view.
 */
export function buildForwardedHeaders(cookieHeader: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const backendJwt = readCookie(cookieHeader, "backend_jwt");
  if (backendJwt) headers.Authorization = backendJwt;
  const djangoCookies = FORWARDED_COOKIES.flatMap((name) => {
    const value = readCookie(cookieHeader, name);
    return value ? [`${name}=${encodeURIComponent(value)}`] : [];
  });
  if (djangoCookies.length > 0) headers.Cookie = djangoCookies.join("; ");
  const csrfToken = readCookie(cookieHeader, "csrftoken");
  if (csrfToken) headers["X-CSRFToken"] = csrfToken;
  return headers;
}

/** Django's own cookies; the only ones forwarded on the server-to-server hop. */
const FORWARDED_COOKIES = ["sessionid", "csrftoken"] as const;

/**
 * True when the incoming cookie jar carries a session credential Django can
 * resolve: the `backend_jwt` cookie (`Session <key>`) or a Django `sessionid`.
 */
export function hasCopilotSession(cookieHeader: string): boolean {
  return Boolean(readCookie(cookieHeader, "backend_jwt") || readCookie(cookieHeader, "sessionid"));
}

/**
 * Thrown by `resolveCopilotUser` when the request carries no session or Django
 * rejects it (401 / no `me`). The route maps it to an HTTP 401.
 */
export class CopilotUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "CopilotUnauthorizedError";
  }
}

/** Application user the Intelligence runtime scopes threads to. */
export type CopilotUser = { id: string; name: string };

type WhoamiResponse = { id: string; username: string; display_name: string | null };

/**
 * Resolve the signed-in user for the CopilotKit runtime's `identifyUser`.
 *
 * Asks Django's `/app/copilot/whoami/` who the forwarded session belongs to,
 * authenticated with the same `Authorization: Session <key>` header the AG-UI
 * hop uses. Unlike GraphQL `me`, that endpoint has no DEBUG `autologin`, so it
 * rejects exactly the sessions the agent endpoint would reject (e.g. a stale
 * `backend_jwt` pointing at a session with no user). Returns the relay global
 * id (never an integer PK) and a display name. Throws `CopilotUnauthorizedError`
 * when there is no session or Django resolves no user.
 */
export async function resolveCopilotUser(cookieHeader: string): Promise<CopilotUser> {
  const apiRoot = serverApiRoot();
  if (!apiRoot) {
    throw new Error("Copilot user lookup is not configured. Set NEXT_PUBLIC_API_ROOT.");
  }
  if (!hasCopilotSession(cookieHeader)) throw new CopilotUnauthorizedError();
  const forwarded = buildForwardedHeaders(cookieHeader);
  const headers: Record<string, string> = {};
  if (forwarded.Authorization) headers.Authorization = forwarded.Authorization;
  if (forwarded.Cookie) headers.Cookie = forwarded.Cookie;

  const res = await fetch(`${apiRoot}/app/copilot/whoami/`, {
    method: "GET",
    headers,
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) throw new CopilotUnauthorizedError();
  if (!res.ok) throw new Error(`Copilot user lookup failed: HTTP ${res.status}`);
  const me = (await res.json()) as WhoamiResponse;
  if (!me?.id) throw new CopilotUnauthorizedError();
  return { id: me.id, name: me.display_name || me.username };
}
