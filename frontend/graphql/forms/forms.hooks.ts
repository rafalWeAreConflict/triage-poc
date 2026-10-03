import { useQuery } from "@apollo/client/react";

import { GET_FORM_DEFINITIONS } from "./forms.queries";
import type { FormDefinitionsData } from "./forms.types";

/** Form definitions for the workflow builder's "Attached Form" picker (the Form Engine UI was removed). */
export const useFormDefinitions = (status?: string) => {
  const { data, loading, error, refetch } = useQuery<FormDefinitionsData>(GET_FORM_DEFINITIONS, {
    variables: { status },
    fetchPolicy: "cache-and-network",
  });
  return { forms: data?.formDefinitions ?? [], loading, error, refetch };
};
