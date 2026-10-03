// Tool results reach the renders either as the serialised JSON string AG-UI carries (backend tools,
// replayed threads) or as the object a frontend tool responded with.

/** The tool result as a plain object, or `null` when it is absent, not JSON or not an object. */
export function parseToolResult(result: unknown): Record<string, unknown> | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
