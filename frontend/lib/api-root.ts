// Server-only: the Django origin for server-to-server calls.

/**
 * Prefer the in-network backend URL (the docker-compose ui container can't
 * reach the backend via localhost), then the public one. No trailing slash;
 * empty string when neither env var is set.
 */
export function serverApiRoot(): string {
  return (process.env.API_ROOT_INTERNAL ?? process.env.NEXT_PUBLIC_API_ROOT ?? "")
    .trim()
    .replace(/\/+$/, "");
}
