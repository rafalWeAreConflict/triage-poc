// Covers Skill delivery for the Django agent (GET /api/copilotkit-skills):
//   - the route authenticates the caller (browser cookies or Django's
//     `Authorization: Session <key>` server hop) through /app/copilot/whoami/,
//   - the runtime SkillRegistry is bound to the shared Intelligence client and
//     the `triage-demo-2` Learning Container,
//   - verified snapshots are projected to { name, description, instructions },
//     and delivery errors surface as 503 with the stable code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intelligence: vi.fn(),
  registry: vi.fn(),
  acquireSnapshot: vi.fn(),
  status: { mode: "latest", stale: false, lastCheckedAt: "2026-10-02T10:00:00.000Z" },
}));

vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotKitIntelligence: class {
    constructor(config: unknown) {
      mocks.intelligence(config, this);
    }
  },
}));

vi.mock("@copilotkit/runtime/internal/learned-skills", () => {
  class SkillDeliveryError extends Error {
    constructor(
      public code: string,
      public retryable: boolean
    ) {
      super(`Learned skills delivery failed: ${code}`);
    }
  }
  return {
    SkillDeliveryError,
    SkillRegistry: class {
      constructor(options: unknown) {
        mocks.registry(options);
      }
      acquireSnapshot() {
        return mocks.acquireSnapshot();
      }
      get status() {
        return mocks.status;
      }
    },
  };
});

const file = (path: string, text?: string) => ({ path, size: 1, sha256: "x", text });
const SNAPSHOT = {
  revision: "rev-7",
  etag: "e",
  skills: [
    {
      name: "quiet-hours-routing",
      description: "Route noise complaints after 22:00.",
      files: [
        file("SKILL.md", "Noise after 22:00 goes to the night porter."),
        file("notes.md", "n"),
        file("img.png"),
      ],
    },
    { name: "broken", description: "no SKILL.md", files: [file("other.md", "x")] },
  ],
};

const whoami = () =>
  new Response(JSON.stringify({ id: "VXNlclR5cGU6MQ==", username: "admin", display_name: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("GET /api/copilotkit-skills", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.NEXT_PUBLIC_API_ROOT = "http://localhost:8000";
    process.env.CPK_INTELLIGENCE_API_KEY = "cpk-test-key";
    delete process.env.API_ROOT_INTERNAL;
    mocks.acquireSnapshot.mockResolvedValue(SNAPSHOT);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...original };
  });

  const get = async (headers: Record<string, string> = {}) => {
    const { GET } = await import("@/app/api/copilotkit-skills/route");
    return GET(new Request("http://ui:3000/api/copilotkit-skills", { headers }));
  };

  it("answers 401 without a session and never touches Intelligence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.acquireSnapshot).not.toHaveBeenCalled();
  });

  it("answers 401 when Django rejects the forwarded session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 }))
    );
    const res = await get({ authorization: "Session stale" });
    expect(res.status).toBe(401);
    expect(mocks.acquireSnapshot).not.toHaveBeenCalled();
  });

  it("accepts Django's Authorization: Session hop and returns the published Skills", async () => {
    const fetchMock = vi.fn(async () => whoami());
    vi.stubGlobal("fetch", fetchMock);

    const res = await get({ authorization: "Session sk-1" });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/app/copilot/whoami/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Session sk-1");
    expect(await res.json()).toEqual({
      status: "ok",
      containerId: "triage-demo-2",
      revision: "rev-7",
      mode: "latest",
      lastCheckedAt: "2026-10-02T10:00:00.000Z",
      stale: false,
      skills: [
        {
          name: "quiet-hours-routing",
          description: "Route noise complaints after 22:00.",
          instructions: "Noise after 22:00 goes to the night porter.",
          files: ["notes.md"],
        },
      ],
    });
  });

  it("binds the registry to the shared Intelligence client and the triage-demo-2 container", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => whoami())
    );
    await get({ cookie: "backend_jwt=Session%20sk-1" });
    expect(mocks.registry).toHaveBeenCalledTimes(1);
    const options = mocks.registry.mock.calls[0][0] as { client: unknown; containerId: string };
    expect(options.containerId).toBe("triage-demo-2");
    expect(options.client).toBe(mocks.intelligence.mock.calls[0][1]);
  });

  it("surfaces delivery errors as 503 with the stable code and no skills", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => whoami())
    );
    const { SkillDeliveryError } = await import("@copilotkit/runtime/internal/learned-skills");
    mocks.acquireSnapshot.mockRejectedValue(
      new (SkillDeliveryError as unknown as new (code: string, retryable: boolean) => Error)(
        "DELIVERY_DISABLED",
        false
      )
    );
    const res = await get({ cookie: "backend_jwt=Session%20sk-1" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("DELIVERY_DISABLED");
    expect(body.skills).toEqual([]);
  });

  it("answers NOT_CONFIGURED without CPK_INTELLIGENCE_API_KEY, so Django runs with no lessons", async () => {
    delete process.env.CPK_INTELLIGENCE_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => whoami())
    );
    const res = await get({ cookie: "backend_jwt=Session%20sk-1" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "NOT_CONFIGURED", retryable: false });
    expect(body.skills).toEqual([]);
    expect(mocks.intelligence).not.toHaveBeenCalled();
    expect(mocks.registry).not.toHaveBeenCalled();
  });

  it("reads the Learning Container from COPILOT_LEARNING_CONTAINER_ID", async () => {
    process.env.COPILOT_LEARNING_CONTAINER_ID = "fresh-space";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => whoami())
    );
    await get({ cookie: "backend_jwt=Session%20sk-1" });
    expect(mocks.registry).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: "fresh-space" })
    );
  });
});
