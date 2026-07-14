import { expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";

// Hot-settings Task 1: unregister(name) must be idempotent (never throw) and the deferred
// index/specs must be derived LIVE from defs — no snapshot-at-boot caching to invalidate.

test("unregister removes a tool from specs and execute", async () => {
  const r = new ToolRegistry();
  r.register({ name: "temp_tool", description: "x", args: z.object({}), run: () => "ok" });
  expect(r.specs().some(s => s.name === "temp_tool")).toBe(true);
  expect(r.unregister("temp_tool")).toBe(true);
  expect(r.specs().some(s => s.name === "temp_tool")).toBe(false);
  const res = await r.execute("temp_tool", {}, { sessionId: "s" } as any);
  expect(res.isError).toBe(true); // unknown tool
});
test("unregister of an absent name is false, not a throw", () => {
  expect(new ToolRegistry().unregister("nope")).toBe(false);
});
test("register after boot makes a tool immediately visible", () => {
  const r = new ToolRegistry();
  r.register({ name: "late", description: "x", args: z.object({}), run: () => "ok" });
  expect(r.specs().some(s => s.name === "late")).toBe(true);
});
