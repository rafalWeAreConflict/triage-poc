// Server-only: the httpOnly cookie that carries the backend session.
//
// The value is the `Session <key>` string auth1 issues at login. Browser code
// never reads it: client GraphQL goes through the same-origin `/api/graphql`
// proxy, which attaches it server-side.

export const SESSION_COOKIE = "backend_jwt";

/** The only token shape auth1 issues: `Session <django session key>`. */
const SESSION_TOKEN = /^Session [A-Za-z0-9]{8,128}$/;

export function isSessionToken(value: string | null | undefined): value is string {
  return typeof value === "string" && SESSION_TOKEN.test(value);
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;

/**
 * False for requests a browser marks as coming from another site. Cookie
 * routes that change or use the session refuse those (CSRF). Requests without
 * the browser headers (server-to-server, tests) pass.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}
