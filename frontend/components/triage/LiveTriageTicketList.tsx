"use client";

import { useEffect, useMemo } from "react";
import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { COPILOT_AGENT_NAME } from "@/copilot/config";
import { parseTriageAgentState, ticketFromGql } from "@/copilot/triageState";
import { useTriageTickets } from "@/graphql/triage/triage.hooks";
import { TriageTicketList } from "./TriageTicketList";

const AGENT_UPDATES = [UseAgentUpdate.OnStateChanged, UseAgentUpdate.OnRunStatusChanged];

/**
 * The ticket list bound to live data: AG-UI shared state from v2 `useAgent` (the same agent and
 * thread as the embedded chat and the threads drawer) plus the GraphQL `triageTickets` list.
 * Every new agent state snapshot also refetches the GraphQL list, so tickets created in another
 * thread stay visible after the drawer switches threads (a thread switch resets `agent.state`).
 */
export function LiveTriageTicketList() {
  const { agent } = useAgent({ agentId: COPILOT_AGENT_NAME, updates: AGENT_UPDATES });
  const agentState = useMemo(() => parseTriageAgentState(agent.state), [agent.state]);
  return <GqlMergedList agentState={agentState} isRunning={agent.isRunning} />;
}

/** Ticket list without the copilot (feature flag off): GraphQL only. */
export function StaticTriageTicketList() {
  const agentState = useMemo(() => parseTriageAgentState({}), []);
  return <GqlMergedList agentState={agentState} />;
}

function GqlMergedList({
  agentState,
  isRunning,
}: {
  agentState: ReturnType<typeof parseTriageAgentState>;
  isRunning?: boolean;
}) {
  const { tickets, loading, error, refetch } = useTriageTickets();
  const gqlTickets = useMemo(() => tickets.map(ticketFromGql), [tickets]);

  useEffect(() => {
    if (agentState.last_updated) void refetch();
  }, [agentState.last_updated, refetch]);

  return (
    <TriageTicketList
      agentState={agentState}
      gqlTickets={gqlTickets}
      loading={loading}
      error={Boolean(error)}
      isRunning={isRunning}
    />
  );
}
