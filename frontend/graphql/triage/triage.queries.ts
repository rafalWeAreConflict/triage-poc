import { gql } from "@apollo/client";

export const GET_TRIAGE_CATEGORIES = gql`
  query GetTriageCategories {
    triageCategories {
      code
      name
      description
    }
  }
`;

export const GET_TRIAGE_CONTRACTORS = gql`
  query GetTriageContractors($categoryCode: String) {
    triageContractors(categoryCode: $categoryCode) {
      slug
      name
      categoryCode
      phone
      email
    }
  }
`;

export const GET_TRIAGE_TICKETS = gql`
  query GetTriageTickets($limit: Int) {
    triageTickets(limit: $limit) {
      guid
      unit
      reporterName
      description
      categoryCode
      categoryName
      priority
      contractorSlug
      contractorName
      status
      createdAt
      wasCorrected
      hasPhoto
    }
  }
`;
