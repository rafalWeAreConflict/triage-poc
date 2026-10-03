import { gql } from "@apollo/client";

export const GET_FORM_DEFINITIONS = gql`
  query GetFormDefinitions($status: String) {
    formDefinitions(status: $status) {
      name
      slug
      description
      status
      version
      formType
      isPublic
      publishedAt
      createdAt
      updatedAt
      submissionCount
    }
  }
`;
