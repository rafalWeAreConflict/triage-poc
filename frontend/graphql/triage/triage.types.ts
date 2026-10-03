import type { TriageTicketGql } from "@/copilot/triageState";

export type TriageCategory = {
  code: string;
  name: string;
  description: string;
};

export type TriageContractor = {
  slug: string;
  name: string;
  categoryCode: string;
  phone: string;
  email: string;
};

export type TriageCategoriesData = { triageCategories: TriageCategory[] };

export type TriageContractorsData = { triageContractors: TriageContractor[] };
export type TriageContractorsVariables = { categoryCode?: string | null };

export type { TriageTicketGql };
export type TriageTicketsData = { triageTickets: TriageTicketGql[] };
export type TriageTicketsVariables = { limit?: number };
