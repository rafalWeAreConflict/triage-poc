// Covers the shared helpers the copilot renders use to read tool results and the
// triage vocabulary (priorities, workflow states).
import { describe, expect, it } from "vitest";
import { parseToolResult } from "@/copilot/toolResults";
import { isTicketStatus, isTriagePriority } from "@/copilot/triageState";

describe("parseToolResult", () => {
  it("reads a serialised JSON object or an object as-is", () => {
    expect(parseToolResult('{"status":"ok","count":2}')).toEqual({ status: "ok", count: 2 });
    const value = { approved: true };
    expect(parseToolResult(value)).toBe(value);
  });

  it("returns null for anything that is not an object", () => {
    for (const value of [undefined, null, "", "not json", "[1,2]", "42", [1], 42]) {
      expect(parseToolResult(value)).toBeNull();
    }
  });
});

describe("triage vocabulary", () => {
  it("knows the backend priorities and workflow states", () => {
    expect(isTriagePriority("urgent")).toBe(true);
    expect(isTriagePriority("critical")).toBe(false);
    expect(isTriagePriority(null)).toBe(false);
    expect(isTicketStatus("assigned")).toBe(true);
    expect(isTicketStatus("archived")).toBe(false);
  });
});
