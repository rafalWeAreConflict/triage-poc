// Covers the cookie-only session handling:
//   - /auth/callback moves the backend token into the httpOnly cookie and redirects,
//   - /auth/logout drops the cookie before the backend logout,
//   - /api/graphql attaches the cookie server-side and refuses cross-site requests,
//   - isSameOriginRequest, the CSRF guard both rely on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isSameOriginRequest, isSessionToken } from "@/lib/auth/session-cookie";

const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "backend_jwt" && mocks.cookie ? { name, value: mocks.cookie } : undefined,
  }),
}));

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  mocks.cookie = undefined;
});

describe("isSessionToken", () => {
  it("accepts only the `Session <key>` shape auth1 issues", () => {
    expect(isSessionToken("Session abc123def456")).toBe(true);
    for (const bad of [
      null,
      "",
      "abc123def456",
      "Session ",
      "Session a b",
      "Bearer abc123def456",
    ]) {
      expect(isSessionToken(bad)).toBe(false);
    }
  });
});

describe("isSameOriginRequest", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/graphql", { method: "POST", headers });

  it("allows same-origin and header-less (server-to-server) requests", () => {
    expect(isSameOriginRequest(req({}))).toBe(true);
    expect(
      isSameOriginRequest(req({ origin: "http://localhost:3000", host: "localhost:3000" }))
    ).toBe(true);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("refuses requests a browser marks as cross-site", () => {
    expect(
      isSameOriginRequest(req({ origin: "https://evil.example", host: "localhost:3000" }))
    ).toBe(false);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: "null", host: "localhost:3000" }))).toBe(false);
  });
});

describe("GET /auth/callback", () => {
  const callback = async (query: string) => {
    const { GET } = await import("@/app/(login)/auth/callback/route");
    return GET(new NextRequest(`http://localhost:3000/auth/callback${query}`));
  };

  it("stores a valid token in the httpOnly cookie and redirects without it", async () => {
    const res = await callback("?token=Session+abc123def456");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/triage");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("backend_jwt=Session%20abc123def456");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sends a missing or malformed token back to login without a cookie", async () => {
    for (const query of ["", "?token=", "?token=not-a-session"]) {
      const res = await callback(query);
      expect(res.headers.get("location")).toBe("http://localhost:3000/auth/login");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("GET /auth/logout", () => {
  it("expires the session cookie, then ends the backend session", async () => {
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000/";
    const { GET } = await import("@/app/(login)/auth/logout/route");
    const res = GET(new NextRequest("http://localhost:3000/auth/logout"));
    expect(res.headers.get("location")).toBe("http://localhost:8000/app/auth1/logout");
    expect(res.headers.get("set-cookie")).toMatch(/backend_jwt=;.*Expires=Thu, 01 Jan 1970/i);
  });
});

describe("POST /api/graphql", () => {
  beforeEach(() => {
    process.env.API_ROOT_INTERNAL = "http://boilerworks-local:8000";
  });

  const gql = async (headers: Record<string, string> = {}) => {
    const { POST } = await import("@/app/api/graphql/route");
    return POST(
      new Request("http://localhost:3000/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", ...headers },
        body: JSON.stringify({ query: "{ me { id } }" }),
      })
    );
  };

  it("forwards the query with the session from the cookie", async () => {
    mocks.cookie = "Session abc123def456";
    const fetchMock = vi.fn(async () =>
      Response.json({ data: { me: { id: "1" } } }, { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await gql({ origin: "http://localhost:3000" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { me: { id: "1" } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://boilerworks-local:8000/app/gql/config/");
    expect(init.headers).toMatchObject({
      Authorization: "Session abc123def456",
      "x-platform": "web",
    });
    expect(init.body).toBe(JSON.stringify({ query: "{ me { id } }" }));
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("forwards without Authorization when there is no session", async () => {
    const fetchMock = vi.fn(async () => Response.json({ errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await gql();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("refuses cross-site requests before touching the backend", async () => {
    mocks.cookie = "Session abc123def456";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await gql({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
