// Covers the CopilotKit -> Django AG-UI bridge:
//   1. the pure cookie/CSRF forwarding + URL helpers,
//   2. resolveCopilotUser (the runtime's identifyUser) with fetch mocked, and
//   3. the /api/copilotkit route handler wiring — with the v2 CopilotRuntime,
//      CopilotKitIntelligence, handler factory and AG-UI HttpAgent mocked,
//      asserting cookie forwarding, the backend URL, Intelligence wiring, the
//      Learning Container selector and the session gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CopilotUnauthorizedError,
  buildForwardedHeaders,
  getCopilotBackendUrl,
  readCookie,
  resolveCopilotUser,
} from "@/copilot/agui-endpoint";

// --- pure helpers ----------------------------------------------------------

describe("readCookie", () => {
  it("extracts a named cookie value", () => {
    expect(readCookie("sessionid=abc; csrftoken=xyz", "csrftoken")).toBe("xyz");
  });

  it("url-decodes the value", () => {
    expect(readCookie("k=a%20b", "k")).toBe("a b");
  });

  it("returns null when the cookie or header is absent", () => {
    expect(readCookie("sessionid=abc", "csrftoken")).toBeNull();
    expect(readCookie("", "csrftoken")).toBeNull();
  });
});

describe("buildForwardedHeaders", () => {
  it("promotes the backend_jwt cookie to the Authorization header", () => {
    const headers = buildForwardedHeaders("backend_jwt=Session%20sk-123; csrftoken=tok");
    expect(headers.Authorization).toBe("Session sk-123");
  });

  it("sends no Authorization header without a backend_jwt cookie", () => {
    const headers = buildForwardedHeaders("sessionid=s1; csrftoken=tok");
    expect(headers.Authorization).toBeUndefined();
  });

  it("forwards only the Django cookies and mirrors csrftoken into X-CSRFToken", () => {
    const headers = buildForwardedHeaders(
      "_ga=GA1.1; csrftoken=tok123; backend_jwt=Session%20sk-1; sessionid=s1; other=x"
    );
    expect(headers.Cookie).toBe("sessionid=s1; csrftoken=tok123");
    expect(headers["X-CSRFToken"]).toBe("tok123");
  });

  it("sends no Cookie header when the jar has no Django cookies", () => {
    expect(buildForwardedHeaders("_ga=GA1.1; backend_jwt=Session%20sk-1").Cookie).toBeUndefined();
  });

  it("forwards Cookie without X-CSRFToken when there is no csrftoken", () => {
    const headers = buildForwardedHeaders("sessionid=s1");
    expect(headers.Cookie).toBe("sessionid=s1");
    expect(headers["X-CSRFToken"]).toBeUndefined();
  });

  it("returns no headers when there is no incoming cookie", () => {
    expect(buildForwardedHeaders("")).toEqual({});
  });
});

describe("getCopilotBackendUrl", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  beforeEach(() => {
    // The docker ui container sets API_ROOT_INTERNAL; each case opts in explicitly.
    delete process.env.API_ROOT_INTERNAL;
  });

  it("derives the endpoint from NEXT_PUBLIC_API_ROOT under the /app/ mount", () => {
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000";
    delete process.env.COPILOT_AGUI_URL;
    expect(getCopilotBackendUrl()).toBe("http://localhost:8000/app/copilot/agui/");
  });

  it("prefers the COPILOT_AGUI_URL override when set", () => {
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000";
    process.env.COPILOT_AGUI_URL = "https://agent.example.com/agui/";
    expect(getCopilotBackendUrl()).toBe("https://agent.example.com/agui/");
  });

  it("prefers API_ROOT_INTERNAL over NEXT_PUBLIC_API_ROOT for the server hop", () => {
    delete process.env.COPILOT_AGUI_URL;
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000";
    process.env.API_ROOT_INTERNAL = "http://boilerworks-local:8000";
    expect(getCopilotBackendUrl()).toBe("http://boilerworks-local:8000/app/copilot/agui/");
  });

  it("throws a configuration error when neither env var yields an origin", () => {
    delete process.env.COPILOT_AGUI_URL;
    delete process.env.NEXT_PUBLIC_API_ROOT;
    // A relative fallback would hand HttpAgent's Node fetch an unparseable URL.
    expect(() => getCopilotBackendUrl()).toThrow(/NEXT_PUBLIC_API_ROOT/);
    expect(() => getCopilotBackendUrl()).toThrow(/COPILOT_AGUI_URL/);
  });

  it("throws when NEXT_PUBLIC_API_ROOT is whitespace-only and no override is set", () => {
    delete process.env.COPILOT_AGUI_URL;
    process.env.NEXT_PUBLIC_API_ROOT = "   ";
    expect(() => getCopilotBackendUrl()).toThrow(/not configured/i);
  });
});

// --- resolveCopilotUser (identifyUser) ------------------------------------

describe("resolveCopilotUser", () => {
  const original = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.API_ROOT_INTERNAL;
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...original };
  });

  // Shape of Django's /app/copilot/whoami/ body, built from a GraphQL-like `me`.
  type Me = { id: string; username: string; profile: { displayName: string } | null } | null;
  const meResponse = (me: Me) =>
    new Response(
      JSON.stringify(
        me
          ? { id: me.id, username: me.username, display_name: me.profile?.displayName ?? null }
          : {}
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  it("asks Django whoami with the forwarded session and returns the relay id + display name", async () => {
    fetchMock.mockResolvedValue(
      meResponse({ id: "VXNlclR5cGU6MQ==", username: "ada", profile: { displayName: "Ada L." } })
    );

    const user = await resolveCopilotUser("backend_jwt=Session%20sk-1");

    expect(user).toEqual({ id: "VXNlclR5cGU6MQ==", name: "Ada L." });
    const [url, init] = fetchMock.mock.calls[0];
    // whoami, not GraphQL `me`: GraphQL's DEBUG autologin would answer a
    // stale/anonymous session as the default test user.
    expect(url).toBe("http://localhost:8000/app/copilot/whoami/");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Session sk-1");
  });

  it("prefers API_ROOT_INTERNAL for the server hop", async () => {
    process.env.API_ROOT_INTERNAL = "http://boilerworks-local:8000";
    fetchMock.mockResolvedValue(meResponse({ id: "id-1", username: "ada", profile: null }));

    await resolveCopilotUser("backend_jwt=Session%20sk-1");

    expect(fetchMock.mock.calls[0][0]).toBe("http://boilerworks-local:8000/app/copilot/whoami/");
  });

  it("falls back to the username when the profile has no display name", async () => {
    fetchMock.mockResolvedValue(
      meResponse({ id: "id-1", username: "ada", profile: { displayName: "" } })
    );
    await expect(resolveCopilotUser("backend_jwt=Session%20sk-1")).resolves.toEqual({
      id: "id-1",
      name: "ada",
    });
  });

  it("throws CopilotUnauthorizedError when Django rejects the session with 401", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(resolveCopilotUser("backend_jwt=Session%20stale")).rejects.toBeInstanceOf(
      CopilotUnauthorizedError
    );
  });

  it("throws a non-auth error for other Django failures", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const err = await resolveCopilotUser("backend_jwt=Session%20sk-1").catch((e) => e);
    expect(err).not.toBeInstanceOf(CopilotUnauthorizedError);
    expect(String(err)).toMatch(/HTTP 500/);
  });

  it("throws Unauthorized when Django resolves no user", async () => {
    fetchMock.mockResolvedValue(meResponse(null));
    await expect(resolveCopilotUser("backend_jwt=Session%20sk-1")).rejects.toThrow("Unauthorized");
  });

  it("throws Unauthorized without asking Django when there is no session cookie", async () => {
    await expect(resolveCopilotUser("csrftoken=tok")).rejects.toThrow("Unauthorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- route handler wiring (runtime boundary mocked) ------------------------

type RuntimeConfig = {
  agents: Record<string, unknown>;
  intelligence: unknown;
  runner?: unknown;
  identifyUser: (request: Request) => Promise<{ id: string; name: string }>;
};
type IntelligenceConfig = {
  apiKey: string;
  getLearningContainerId: (input: { agentId: string }) => string | null | undefined;
};
type HandlerOptions = {
  runtime: unknown;
  basePath: string;
  mode: string;
  hooks: {
    onBeforeHandler: (ctx: {
      request: Request;
      route: { method: string; threadId?: string };
    }) => Promise<unknown>;
  };
};

const mocks = vi.hoisted(() => ({
  httpAgent: vi.fn(),
  copilotRuntime: vi.fn(),
  intelligence: vi.fn(),
  createHandler: vi.fn(),
  handler: vi.fn(async () => new Response("ok")),
  getThread: vi.fn(),
}));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(config: unknown) {
      mocks.httpAgent(config);
    }
  },
}));

vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotRuntime: class {
    constructor(config: unknown) {
      mocks.copilotRuntime(config);
    }
  },
  CopilotKitIntelligence: class {
    constructor(config: unknown) {
      mocks.intelligence(config, this);
    }
    getThread(params: unknown) {
      return mocks.getThread(params);
    }
  },
  createCopilotRuntimeHandler: (options: unknown) => {
    mocks.createHandler(options);
    return mocks.handler;
  },
}));

describe("/api/copilotkit/[[...slug]] route", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000";
    process.env.CPK_INTELLIGENCE_API_KEY = "cpk-test-key";
    delete process.env.COPILOT_AGUI_URL;
    delete process.env.API_ROOT_INTERNAL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...original };
  });

  const post = async (cookie?: string) => {
    const { POST } = await import("@/app/api/copilotkit/[[...slug]]/route");
    const req = new Request("http://localhost:3000/api/copilotkit", {
      method: "POST",
      headers: cookie ? { cookie } : {},
    });
    return POST(req as never);
  };
  const runtimeConfig = () => mocks.copilotRuntime.mock.calls[0][0] as RuntimeConfig;
  const intelligenceConfig = () => mocks.intelligence.mock.calls[0][0] as IntelligenceConfig;
  const handlerOptions = () => mocks.createHandler.mock.calls[0][0] as HandlerOptions;

  it("forwards session cookies + CSRF to the AG-UI agent and delegates to the handler", async () => {
    const res = await post("sessionid=s1; csrftoken=tok");

    expect(mocks.httpAgent).toHaveBeenCalledWith({
      url: "http://localhost:8000/app/copilot/agui/",
      headers: { Cookie: "sessionid=s1; csrftoken=tok", "X-CSRFToken": "tok" },
    });
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(res).toBeInstanceOf(Response);
  });

  it("sends no auth headers when the request carries no cookies", async () => {
    await post();
    expect(mocks.httpAgent).toHaveBeenCalledWith({
      url: "http://localhost:8000/app/copilot/agui/",
      headers: {},
    });
  });

  it("passes the Intelligence client to the runtime and no runner", async () => {
    await post("backend_jwt=Session%20sk-1");

    expect(mocks.intelligence).toHaveBeenCalledTimes(1);
    expect(intelligenceConfig().apiKey).toBe("cpk-test-key");
    const config = runtimeConfig();
    expect(Object.keys(config.agents)).toEqual(["boilerworks_agent"]);
    expect(config.intelligence).toBe(mocks.intelligence.mock.calls[0][1]);
    expect("runner" in config).toBe(false);
  });

  it("mounts a multi-route handler at /api/copilotkit for GET, POST, PATCH and DELETE", async () => {
    const route = await import("@/app/api/copilotkit/[[...slug]]/route");
    await post("backend_jwt=Session%20sk-1");
    expect(handlerOptions().basePath).toBe("/api/copilotkit");
    // Multi-route is the default mode: no `mode` option is passed.
    expect("mode" in handlerOptions()).toBe(false);
    expect(route.GET).toBe(route.POST);
    expect(route.PATCH).toBe(route.POST);
    expect(route.DELETE).toBe(route.POST);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("assigns boilerworks_agent threads to the triage-demo-2 Learning Container only", async () => {
    await post("backend_jwt=Session%20sk-1");
    const select = intelligenceConfig().getLearningContainerId;
    expect(select({ agentId: "boilerworks_agent" })).toBe("triage-demo-2");
    expect(select({ agentId: "some_other_agent" })).toBeUndefined();
  });

  type Me = { id: string; username: string; profile?: { displayName: string } | null } | null;
  const meResponse = (me: Me, status = 200) =>
    new Response(
      JSON.stringify(
        me
          ? { id: me.id, username: me.username, display_name: me.profile?.displayName ?? null }
          : {}
      ),
      { status, headers: { "content-type": "application/json" } }
    );
  const request = (cookie?: string) =>
    new Request("http://localhost:3000/api/copilotkit/threads", {
      headers: cookie ? { cookie } : {},
    });
  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it("identifyUser rejects a request without a session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await post();
    const identify = runtimeConfig().identifyUser;
    await expect(identify(request())).rejects.toThrow("Unauthorized");
  });

  it("identifyUser returns the Django user and reuses the hook's lookup", async () => {
    const fetchMock = vi.fn(async () => meResponse({ id: "id-1", username: "ada", profile: null }));
    vi.stubGlobal("fetch", fetchMock);
    await post();
    const req = request("backend_jwt=Session%20sk-1");

    await handlerOptions().hooks.onBeforeHandler({
      request: req,
      route: { method: "threads/list" },
    });
    await expect(runtimeConfig().identifyUser(req)).resolves.toEqual({ id: "id-1", name: "ada" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("onBeforeHandler lets info through without a session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await post();
    await expect(
      handlerOptions().hooks.onBeforeHandler({ request: request(), route: { method: "info" } })
    ).resolves.toBeUndefined();
  });

  it("onBeforeHandler answers 401 for other routes without a session cookie", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await post();
    const thrown = await rejection(
      handlerOptions().hooks.onBeforeHandler({ request: request(), route: { method: "agent/run" } })
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("onBeforeHandler answers 401 (not 500) when Django rejects a stale session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 }))
    );
    await post();
    const thrown = await rejection(
      handlerOptions().hooks.onBeforeHandler({
        request: request("backend_jwt=Session%20stale"),
        route: { method: "threads/events" },
      })
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });

  it("onBeforeHandler lets a signed-in request through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => meResponse({ id: "id-1", username: "ada", profile: null }))
    );
    await post();
    await expect(
      handlerOptions().hooks.onBeforeHandler({
        request: request("backend_jwt=Session%20sk-1"),
        route: { method: "agent/run" },
      })
    ).resolves.toBeUndefined();
  });

  describe("thread ownership", () => {
    const signedIn = () => request("backend_jwt=Session%20sk-1");
    const before = (method: string, threadId = "t-1") =>
      handlerOptions().hooks.onBeforeHandler({ request: signedIn(), route: { method, threadId } });

    beforeEach(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => meResponse({ id: "id-1", username: "ada", profile: null }))
      );
      await post();
    });

    for (const method of ["threads/events", "threads/state"]) {
      it(`${method}: lets the owner through`, async () => {
        mocks.getThread.mockResolvedValue({ id: "t-1", agentId: "boilerworks_agent" });
        await expect(before(method)).resolves.toBeUndefined();
        expect(mocks.getThread).toHaveBeenCalledWith({ threadId: "t-1", userId: "id-1" });
      });

      it(`${method}: answers 404 for another user's thread`, async () => {
        mocks.getThread.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
        const thrown = await rejection(before(method));
        expect(thrown).toBeInstanceOf(Response);
        expect((thrown as Response).status).toBe(404);
      });
    }

    it("answers 404 for a thread of another agent", async () => {
      mocks.getThread.mockResolvedValue({ id: "t-1", agentId: "some_other_agent" });
      expect(((await rejection(before("threads/events"))) as Response).status).toBe(404);
    });

    it("surfaces platform outages instead of hiding them as 404", async () => {
      mocks.getThread.mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));
      expect(await rejection(before("threads/state"))).not.toBeInstanceOf(Response);
    });

    it("leaves routes the runtime already scopes to the user alone", async () => {
      await expect(before("threads/messages")).resolves.toBeUndefined();
      await expect(before("agent/stop")).resolves.toBeUndefined();
      expect(mocks.getThread).not.toHaveBeenCalled();
    });
  });

  describe("without CPK_INTELLIGENCE_API_KEY (SSE mode)", () => {
    beforeEach(() => {
      delete process.env.CPK_INTELLIGENCE_API_KEY;
    });

    it("imports cleanly and runs the agent without Intelligence", async () => {
      const res = await post("backend_jwt=Session%20sk-1");
      expect(res).toBeInstanceOf(Response);
      expect(mocks.intelligence).not.toHaveBeenCalled();
      const config = runtimeConfig();
      expect(Object.keys(config.agents)).toEqual(["boilerworks_agent"]);
      expect("intelligence" in config).toBe(false);
      expect("identifyUser" in config).toBe(false);
    });

    it("still requires a session, and has no thread routes", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => meResponse({ id: "id-1", username: "ada", profile: null }))
      );
      await post();
      const hook = handlerOptions().hooks.onBeforeHandler;
      const anonymous = await rejection(
        hook({ request: request(), route: { method: "agent/run" } })
      );
      expect((anonymous as Response).status).toBe(401);
      await expect(
        hook({ request: request("backend_jwt=Session%20sk-1"), route: { method: "agent/run" } })
      ).resolves.toBeUndefined();
      const threads = await rejection(
        hook({ request: request("backend_jwt=Session%20sk-1"), route: { method: "threads/list" } })
      );
      expect((threads as Response).status).toBe(404);
    });
  });
});
