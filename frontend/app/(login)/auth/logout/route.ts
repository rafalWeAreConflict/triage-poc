// GET /auth/logout — drop the frontend session cookie, then end the backend
// session (auth1 clears it and signs out of the identity provider).
//
// The cookie lives on the frontend origin, so the backend logout alone would
// leave a stale `backend_jwt` behind.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session-cookie";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): NextResponse {
  const apiRoot = (process.env.NEXT_PUBLIC_API_ROOT ?? "").trim().replace(/\/+$/, "");
  const target = apiRoot ? `${apiRoot}/app/auth1/logout` : new URL("/auth/login", request.url);
  const response = NextResponse.redirect(target, 303);
  response.cookies.delete(SESSION_COOKIE);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
