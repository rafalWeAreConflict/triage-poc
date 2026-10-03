import { ApolloLink, HttpLink } from "@apollo/client";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { onError } from "@apollo/client/link/error";

// No auth link: the browser client talks to the same-origin /api/graphql proxy,
// which attaches the httpOnly session cookie as Authorization server-side.
const errorLink = onError(({ error }) => {
  if (CombinedGraphQLErrors.is(error)) {
    for (const { extensions } of error.errors) {
      if (extensions?.code === "UNAUTHENTICATED") {
        window.location.href = "/auth/login";
        return;
      }
    }
  } else if (error) {
    console.error("[Apollo] Network error:", error);
  }
});

export function buildClientLinks(httpLink: HttpLink): ApolloLink {
  return ApolloLink.from([errorLink, httpLink]);
}
