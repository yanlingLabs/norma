import { describe, expect, test } from "bun:test";
import { mapSpawnMode, restrictPolicy } from "../../src/agent/engine";

// 4h-i (CC parity: spawn_agent `mode`) — restrictPolicy is the security-critical piece of the
// feature: a child's effective approval policy may only be NARROWED relative to its parent's,
// never WIDENED. Permissiveness order, least to most permissive: "plan" < "ask" < "auto".
describe("restrictPolicy (spawn_agent mode — RESTRICT-ONLY, never escalates)", () => {
  test("narrowing requests take effect", () => {
    expect(restrictPolicy("auto", "plan")).toBe("plan");
    expect(restrictPolicy("auto", "ask")).toBe("ask");
    expect(restrictPolicy("ask", "plan")).toBe("plan");
  });

  test("same-policy requests are a no-op", () => {
    expect(restrictPolicy("auto", "auto")).toBe("auto");
    expect(restrictPolicy("ask", "ask")).toBe("ask");
    expect(restrictPolicy("plan", "plan")).toBe("plan");
  });

  test("escalation (widening) requests are DENIED — the parent's policy always wins", () => {
    // parent "ask" + requested "auto" → widening denied, stays "ask"
    expect(restrictPolicy("ask", "auto")).toBe("ask");
    // parent "plan" + requested "auto" → widening denied, stays "plan"
    expect(restrictPolicy("plan", "auto")).toBe("plan");
    // parent "plan" + requested "ask" → widening denied, stays "plan"
    expect(restrictPolicy("plan", "ask")).toBe("plan");
  });
});

describe("mapSpawnMode (CC mode string → Norma approvalPolicy)", () => {
  test("plan maps to Norma's plan policy", () => {
    expect(mapSpawnMode("plan")).toBe("plan");
  });

  test("acceptEdits, dontAsk, bypassPermissions all collapse to auto", () => {
    expect(mapSpawnMode("acceptEdits")).toBe("auto");
    expect(mapSpawnMode("dontAsk")).toBe("auto");
    expect(mapSpawnMode("bypassPermissions")).toBe("auto");
  });

  test("default, absent, or an unrecognized string → undefined (no override, inherit parent)", () => {
    expect(mapSpawnMode("default")).toBeUndefined();
    expect(mapSpawnMode(undefined)).toBeUndefined();
    expect(mapSpawnMode("something-unrecognized")).toBeUndefined();
  });
});
