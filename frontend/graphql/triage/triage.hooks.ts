import { useQuery } from "@apollo/client/react";

import {
  GET_TRIAGE_CATEGORIES,
  GET_TRIAGE_CONTRACTORS,
  GET_TRIAGE_TICKETS,
} from "./triage.queries";
import type {
  TriageCategoriesData,
  TriageContractorsData,
  TriageContractorsVariables,
  TriageTicketsData,
  TriageTicketsVariables,
} from "./triage.types";

export const useTriageCategories = () => {
  const { data, loading, error } = useQuery<TriageCategoriesData>(GET_TRIAGE_CATEGORIES, {
    fetchPolicy: "cache-first",
  });
  return { categories: data?.triageCategories ?? [], loading, error };
};

/** All contractors (filter by `categoryCode` client-side — the list is tiny). */
export const useTriageContractors = () => {
  const { data, loading, error } = useQuery<TriageContractorsData, TriageContractorsVariables>(
    GET_TRIAGE_CONTRACTORS,
    { variables: {}, fetchPolicy: "cache-first" }
  );
  return { contractors: data?.triageContractors ?? [], loading, error };
};

/** Recent tickets for the /triage list (initial load before any agent run; see copilot/triageState.ts). */
export const useTriageTickets = (limit = 12) => {
  const { data, loading, error, refetch } = useQuery<TriageTicketsData, TriageTicketsVariables>(
    GET_TRIAGE_TICKETS,
    { variables: { limit }, fetchPolicy: "cache-and-network" }
  );
  return { tickets: data?.triageTickets ?? [], loading, error, refetch };
};
