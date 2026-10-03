"use client";

import { HttpLink } from "@apollo/client";
import { ApolloNextAppProvider, ApolloClient } from "@apollo/client-integration-nextjs";
import { buildClientLinks } from "./links";
import { getClientCache } from "./cache";

// Same-origin proxy (app/api/graphql/route.ts): it adds the session from the
// httpOnly cookie, so no token is ever handled in the browser.
const API_URL = "/api/graphql";

function makeClient(): ApolloClient {
  // Earlier builds kept the session token in localStorage; drop that copy.
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem("jwt");
    } catch {
      // storage blocked: nothing stored either
    }
  }
  const httpLink = new HttpLink({ uri: API_URL, credentials: "same-origin" });
  return new ApolloClient({
    link: buildClientLinks(httpLink),
    cache: getClientCache(),
  });
}

export function ApolloWrapper({ children }: { children: React.ReactNode }) {
  return <ApolloNextAppProvider makeClient={makeClient}>{children}</ApolloNextAppProvider>;
}
