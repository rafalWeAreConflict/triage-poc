// Covers the /triage screen (Stage 3):
//   - copilot/triageState.ts: parsing the AG-UI agent state and merging it with GraphQL tickets,
//   - TriageTicketList: renders the merged list, the draft row and a brief highlight for a new ticket,
//   - LiveTriageTicketList: reads agent.state through v2 useAgent and merges the GraphQL list,
//   - the create_ticket render (TicketCreatedCard) and the default tool chip, both registered by
//     CopilotToolRenders, the nav item and the sidebar being skipped on /triage.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "@/messages/en.json";
import plMessages from "@/messages/pl.json";
import {
  mergeTickets,
  parseTriageAgentState,
  ticketFromGql,
  type TriageTicketGql,
  type TriageTicketRow,
} from "@/copilot/triageState";

const mocks = vi.hoisted(() => ({
  agentState: {} as unknown,
  isRunning: false,
  gqlTickets: [] as unknown[],
  refetch: vi.fn(),
  renderTools: [] as { name: string }[],
  defaultRenders: [] as unknown[],
  pathname: "/workflows",
}));

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({
    agent: { state: mocks.agentState, isRunning: mocks.isRunning },
    isReady: true,
  }),
  UseAgentUpdate: {
    OnMessagesChanged: "OnMessagesChanged",
    OnStateChanged: "OnStateChanged",
    OnRunStatusChanged: "OnRunStatusChanged",
  },
  useComponent: () => {},
  useHumanInTheLoop: () => {},
  useDefaultRenderTool: (config: unknown) => {
    mocks.defaultRenders.push(config);
  },
  useRenderTool: (config: { name: string }) => {
    mocks.renderTools.push(config);
  },
  ToolCallStatus: { InProgress: "inProgress", Executing: "executing", Complete: "complete" },
  CopilotKit: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CopilotChatConfigurationProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  CopilotThreadsDrawer: () => <div data-testid="threads-drawer" />,
  CopilotSidebar: () => <div data-testid="copilot-sidebar" />,
  CopilotChat: () => <div data-testid="copilot-chat" />,
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/graphql/triage/triage.hooks", () => ({
  useTriageTickets: () => ({
    tickets: mocks.gqlTickets,
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
  }),
  useTriageCategories: () => ({
    categories: [{ code: "plumbing", name: "Plumbing", description: "" }],
    loading: false,
    error: undefined,
  }),
  useTriageContractors: () => ({
    contractors: [
      {
        slug: "flowfix-plumbing",
        name: "FlowFix Plumbing",
        categoryCode: "plumbing",
        phone: "",
        email: "",
      },
    ],
    loading: false,
    error: undefined,
  }),
}));

import { TriageTicketList } from "@/components/triage/TriageTicketList";
import { LiveTriageTicketList } from "@/components/triage/LiveTriageTicketList";
import { TicketCreatedCard } from "@/copilot/TicketCreatedCard";
import { ToolActivityChip, summariseToolResult } from "@/copilot/ToolActivityChip";
import { CopilotToolRenders } from "@/copilot/CopilotToolRenders";
import { CopilotProvider } from "@/copilot/CopilotProvider";
import { getNavMain } from "@/components/navItems";
import { COPILOT_TOOL_CREATE_TICKET } from "@/copilot/config";

afterEach(() => {
  cleanup();
  mocks.agentState = {};
  mocks.isRunning = false;
  mocks.gqlTickets = [];
  mocks.refetch.mockReset();
  mocks.renderTools.length = 0;
  mocks.defaultRenders.length = 0;
  mocks.pathname = "/workflows";
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function renderIntl(ui: ReactElement, locale: "en" | "pl" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Europe/Warsaw"
      messages={locale === "en" ? enMessages : plMessages}
    >
      {ui}
    </NextIntlClientProvider>
  );
}

function row(overrides: Partial<TriageTicketRow> = {}): TriageTicketRow {
  return {
    guid: "g-1",
    unit: "A/4",
    reporter_name: "Anna Novak",
    description: "The kitchen tap keeps dripping",
    category_code: "plumbing",
    category_name: "Plumbing",
    priority: "normal",
    contractor_slug: "flowfix-plumbing",
    contractor_name: "FlowFix Plumbing",
    status: "approved",
    created_at: "2026-10-02T10:00:00+00:00",
    was_corrected: false,
    has_photo: false,
    ...overrides,
  };
}

function gql(overrides: Partial<TriageTicketGql> = {}): TriageTicketGql {
  return {
    guid: "g-old",
    unit: "B/3",
    reporterName: "John Smith",
    description: "Hallway light is out",
    categoryCode: "electrical",
    categoryName: "Electrical",
    priority: "high",
    contractorSlug: "brightspark-electric",
    contractorName: "BrightSpark Electric",
    status: "proposed",
    createdAt: "2026-10-01T08:00:00+00:00",
    wasCorrected: true,
    hasPhoto: false,
    ...overrides,
  };
}

const DRAFT = {
  tool_call_id: "call_1",
  unit_label: "A/4",
  reporter_name: "Anna Novak",
  description: "The kitchen tap keeps dripping",
  category_code: "plumbing",
  category_name: "Plumbing",
  priority: "normal",
  contractor_slug: "flowfix-plumbing",
  contractor_name: "FlowFix Plumbing",
  reasoning: "Typical defect.",
  has_photo: false,
  status: "awaiting_decision",
};

describe("triage agent state", () => {
  it("parses partial / empty agent state defensively", () => {
    expect(parseTriageAgentState(undefined)).toEqual({
      tickets: [],
      draft: null,
      last_created_guid: null,
      last_updated: null,
    });
    const parsed = parseTriageAgentState({
      tickets: [row(), { unit: "no guid" }, null],
      draft: { ...DRAFT, status: "bogus" },
      last_updated: "2026-10-02T10:00:01+00:00",
    });
    expect(parsed.tickets.map((t) => t.guid)).toEqual(["g-1"]);
    expect(parsed.draft?.status).toBe("awaiting_decision");
    expect(parsed.last_updated).toBe("2026-10-02T10:00:01+00:00");
  });

  it("merges agent state and GraphQL tickets by guid, newest first, state wins", () => {
    const fromGql = [ticketFromGql(gql()), ticketFromGql(gql({ guid: "g-1", status: "proposed" }))];
    const merged = mergeTickets([row({ status: "approved" })], fromGql);
    expect(merged.map((t) => t.guid)).toEqual(["g-1", "g-old"]);
    expect(merged[0].status).toBe("approved");
    expect(merged[1].reporter_name).toBe("John Smith");
    expect(mergeTickets([row()], fromGql, 1)).toHaveLength(1);
  });
});

describe("TriageTicketList", () => {
  it("renders the merged list with the draft row", () => {
    renderIntl(
      <TriageTicketList
        agentState={parseTriageAgentState({ tickets: [row()], draft: DRAFT })}
        gqlTickets={[ticketFromGql(gql())]}
      />
    );
    const rows = screen.getAllByTestId("ticket-row");
    expect(rows.map((r) => r.getAttribute("data-guid"))).toEqual(["g-1", "g-old"]);
    expect(within(rows[0]).getByText("Plumbing")).toBeTruthy();
    expect(within(rows[0]).getByText("Approved")).toBeTruthy();
    expect(within(rows[1]).getByTestId("row-corrected").textContent).toContain(
      "Corrected by admin"
    );
    const draft = screen.getByTestId("draft-row");
    expect(draft.textContent).toContain("Draft / in progress");
    expect(draft.textContent).toContain("Waiting for the admin's decision");
    expect(screen.getByText("Tickets")).toBeTruthy();
  });

  it("highlights a ticket that appears after the first render, not on load", () => {
    vi.useFakeTimers();
    const gqlTickets = [ticketFromGql(gql())];
    const { rerender } = renderIntl(
      <TriageTicketList agentState={parseTriageAgentState({})} gqlTickets={gqlTickets} />
    );
    expect(screen.getByTestId("ticket-row").getAttribute("data-fresh")).toBeNull();

    rerender(
      <NextIntlClientProvider locale="en" timeZone="Europe/Warsaw" messages={enMessages}>
        <TriageTicketList
          agentState={parseTriageAgentState({ tickets: [row({ guid: "g-new" })], draft: null })}
          gqlTickets={gqlTickets}
        />
      </NextIntlClientProvider>
    );
    const fresh = screen
      .getAllByTestId("ticket-row")
      .find((r) => r.getAttribute("data-guid") === "g-new")!;
    expect(fresh.getAttribute("data-fresh")).toBe("true");
    expect(fresh.textContent).toContain("New");

    // the GraphQL refetch re-renders with a new (equal) list while the highlight is showing
    rerender(
      <NextIntlClientProvider locale="en" timeZone="Europe/Warsaw" messages={enMessages}>
        <TriageTicketList
          agentState={parseTriageAgentState({ tickets: [row({ guid: "g-new" })], draft: null })}
          gqlTickets={[...gqlTickets]}
        />
      </NextIntlClientProvider>
    );
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(
      screen
        .getAllByTestId("ticket-row")
        .find((r) => r.getAttribute("data-guid") === "g-new")!
        .getAttribute("data-fresh")
    ).toBeNull();
  });

  it("shows the empty state", () => {
    renderIntl(<TriageTicketList agentState={parseTriageAgentState({})} gqlTickets={[]} />);
    expect(screen.getByText("No tickets yet.")).toBeTruthy();
  });
});

describe("LiveTriageTicketList", () => {
  it("reads agent.state through useAgent and merges the GraphQL list", () => {
    mocks.gqlTickets = [gql()];
    mocks.agentState = {
      tickets: [row()],
      draft: null,
      last_created_guid: "g-1",
      last_updated: "2026-10-02T10:00:01+00:00",
    };
    renderIntl(<LiveTriageTicketList />);
    expect(screen.getAllByTestId("ticket-row").map((r) => r.getAttribute("data-guid"))).toEqual([
      "g-1",
      "g-old",
    ]);
    expect(screen.getByTestId("state-updated")).toBeTruthy();
    // a new state snapshot refetches the GraphQL list (keeps other threads' tickets in the cache)
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("works from GraphQL alone before any agent run", () => {
    mocks.gqlTickets = [gql()];
    renderIntl(<LiveTriageTicketList />);
    expect(screen.getAllByTestId("ticket-row")).toHaveLength(1);
    expect(screen.queryByTestId("draft-row")).toBeNull();
    expect(mocks.refetch).not.toHaveBeenCalled();
  });
});

describe("create_ticket render and tool chips", () => {
  const OK = JSON.stringify({
    status: "ok",
    ticket_guid: "g-1",
    state: "approved",
    unit: "A/4",
    category_code: "plumbing",
    priority: "normal",
    contractor_slug: "flowfix-plumbing",
    was_corrected: true,
    has_photo: false,
  });

  it("renders the created ticket with the corrected badge", () => {
    renderIntl(<TicketCreatedCard status="complete" parameters={{}} result={OK} />);
    const card = screen.getByTestId("ticket-created");
    expect(card.textContent).toContain("Ticket created");
    expect(card.textContent).toContain("A/4");
    expect(card.textContent).toContain("Plumbing");
    expect(card.textContent).toContain("FlowFix Plumbing");
    expect(card.textContent).toContain("Approved");
    expect(screen.getByTestId("ticket-corrected").textContent).toContain("Corrected by admin");
  });

  it("renders progress and failure", () => {
    renderIntl(<TicketCreatedCard status="executing" parameters={{}} />);
    expect(screen.getByTestId("ticket-creating").textContent).toContain("Creating the ticket");
    cleanup();
    renderIntl(
      <TicketCreatedCard
        status="complete"
        parameters={{}}
        result={JSON.stringify({ status: "permission_denied", message: "Nope." })}
      />
    );
    expect(screen.getByTestId("ticket-failed").textContent).toContain("Ticket not created: Nope.");
  });

  it("summarises backend tool results for the default chip", () => {
    expect(
      summariseToolResult(JSON.stringify({ status: "ok", units: [{ label: "A/4" }] }))
    ).toEqual({
      kind: "ok",
      summary: "A/4",
    });
    expect(summariseToolResult({ status: "ok", categories: [1, 2, 3] })).toEqual({
      kind: "ok",
      count: 3,
    });
    expect(summariseToolResult({ status: "permission_denied" }).kind).toBe("denied");
    renderIntl(
      <ToolActivityChip
        name="list_categories"
        status="complete"
        result={JSON.stringify({ status: "ok", categories: [1, 2, 3, 4, 5, 6, 7] })}
      />
    );
    const chip = screen.getByTestId("tool-chip");
    expect(chip.textContent).toContain("Listing categories");
    expect(chip.textContent).toContain("7 results");
  });

  it("CopilotToolRenders registers the default render and the create_ticket render", () => {
    renderIntl(<CopilotToolRenders />);
    expect(mocks.defaultRenders).toHaveLength(1);
    expect(mocks.renderTools.map((r) => r.name)).toEqual([COPILOT_TOOL_CREATE_TICKET]);
    expect(COPILOT_TOOL_CREATE_TICKET).toBe("create_ticket");
  });
});

describe("navigation and sidebar", () => {
  it("puts Triage first in the app nav", () => {
    const items = getNavMain((key) => key);
    expect(items[0]).toMatchObject({ title: "triage", url: "/triage" });
    expect(plMessages.nav.triage).toBe("Zgłoszenia");
    expect(enMessages.nav.triage).toBe("Triage");
  });

  it("skips the global sidebar on /triage but keeps the drawer", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOT_ENABLED", "true");
    mocks.pathname = "/triage";
    renderIntl(
      <CopilotProvider authenticated threadsEnabled>
        <p>page</p>
      </CopilotProvider>
    );
    expect(screen.queryByTestId("copilot-sidebar")).toBeNull();
    expect(screen.getByTestId("threads-drawer")).toBeTruthy();
    cleanup();
    mocks.pathname = "/workflows";
    renderIntl(
      <CopilotProvider authenticated threadsEnabled>
        <p>page</p>
      </CopilotProvider>
    );
    expect(screen.getByTestId("copilot-sidebar")).toBeTruthy();
  });

  it("hides the threads drawer when Intelligence is not configured", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOT_ENABLED", "true");
    renderIntl(
      <CopilotProvider authenticated threadsEnabled={false}>
        <p>page</p>
      </CopilotProvider>
    );
    expect(screen.queryByTestId("threads-drawer")).toBeNull();
    expect(screen.getByTestId("copilot-sidebar")).toBeTruthy();
  });
});
