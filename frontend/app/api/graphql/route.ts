// POST /api/graphql — same-origin proxy for the browser Apollo client.
//
// The session lives in the httpOnly `backend_jwt` cookie, which browser code
// cannot read. This route attaches it as `Authorization` on the server-to-server
// hop to Django, so the token never reaches JavaScript (an XSS cannot steal it).
import { cookies } from "next/headers";
import { serverApiRoot } from "@/lib/api-root";
import { SESSION_COOKIE, isSameOriginRequest } from "@/lib/auth/session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // The cookie is SameSite=Lax, so other sites can't send it here anyway; this
  // also refuses cross-site requests from browsers that mark them.
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const apiRoot = serverApiRoot();
  if (!apiRoot) {
    return Response.json({ error: "Backend URL is not configured" }, { status: 500 });
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const headers: Record<string, string> = {
    "content-type": request.headers.get("content-type") ?? "application/json",
    accept: request.headers.get("accept") ?? "application/json",
    "x-platform": "web",
  };
  if (token) headers.Authorization = token;
  const language = request.headers.get("accept-language");
  if (language) headers["accept-language"] = language;

  const upstream = await fetch(`${apiRoot}/app/gql/config/`, {
    method: "POST",
    headers,
    body: await request.text(),
    cache: "no-store",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store, private",
    },
  });
}
