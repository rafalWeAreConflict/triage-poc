// GET /auth/callback?token=Session <key> — the end of the backend login.
//
// auth1 (Auth0 callback or the dev-login bridge) redirects here with the
// session token. It goes straight into the httpOnly cookie and the browser is
// redirected on, so the token is never handed to JavaScript and the URL that
// carried it leaves the address bar and history.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, isSessionToken } from "@/lib/auth/session-cookie";

export const dynamic = "force-dynamic";

const AFTER_LOGIN = "/triage";

export function GET(request: NextRequest): NextResponse {
  const token = request.nextUrl.searchParams.get("token");
  const valid = isSessionToken(token);
  const response = NextResponse.redirect(
    new URL(valid ? AFTER_LOGIN : "/auth/login", request.url),
    303
  );
  if (valid) response.cookies.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
