import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/agent/tools/registry";
import type { ToolContext } from "../../src/agent/tools/registry";
import { registerPlanTool } from "../../src/agent/tools/plan";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/", roots: ["/"], sessionId: "s", ...overrides };
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerPlanTool(r);
  return r;
}

describe("exit_plan_mode tool", () => {
  test("plan arg is required and must be non-empty", async () => {
    const r = buildRegistry();
    expect((await r.execute("exit_plan_mode", {}, ctx())).isError).toBe(true);
    expect((await r.execute("exit_plan_mode", { plan: "" }, ctx())).isError).toBe(true);
  });

  test("run returns the placeholder string (no bridge wired yet)", async () => {
    const r = buildRegistry();
    const out = await r.execute("exit_plan_mode", { plan: "# Plan\n1. Do the thing" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("exit_plan_mode is only meaningful in plan mode (no plan approval flow is wired).");
  });
});
