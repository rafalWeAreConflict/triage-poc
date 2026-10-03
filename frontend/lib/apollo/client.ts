import { ApolloLink, HttpLink } from "@apollo/client";
import { registerApolloClient, ApolloClient } from "@apollo/client-integration-nextjs";
import { cookies } from "next/headers";
import { serverApiRoot } from "@/lib/api-root";
import { fetchToken } from "@/lib/auth/fetch-token";
import { makeCache } from "./cache";

// Server-side (RSC) client: prefer the in-network backend URL when set.
// Inside the docker-compose ui container, `localhost:8000` is the container
// itself — API_ROOT_INTERNAL (e.g. http://boilerworks-local:8000) reaches the
// backend over the compose network.
const API_URL = `${serverApiRoot()}/app/gql/config/`;

export const { getClient, query, PreloadQuery } = registerApolloClient(async () => {
  const cookieStore = await cookies();
  const cachedToken = cookieStore.get("backend_jwt")?.value;
  const token = cachedToken ?? (await fetchToken());

  const authLink = new ApolloLink((operation, forward) => {
    operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
      headers: {
        ...headers,
        ...(token ? { Authorization: token } : {}),
        "x-platform": "web",
      },
    }));
    return forward(operation);
  });

  const httpLink = new HttpLink({ uri: API_URL });

  return new ApolloClient({
    cache: makeCache(),
    link: ApolloLink.from([authLink, httpLink]),
  });
});
