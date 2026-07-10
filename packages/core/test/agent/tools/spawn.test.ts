import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import { registerSpawnAgentTool } from "../../../src/agent/tools/spawn";

/** 4e gate fix loop 2 — design upgrade: when the calling provider enumerates a known model set,
 *  spawn_agent's `model` arg must be a CLOSED zod enum (not just a free string named in prose),
 *  so the JSON schema actually sent to the model in the tools array constrains the choice at the
 *  source (ToolRegistry.specs() → z.toJSONSchema). Confirmed via a scratch check that
 *  z.toJSONSchema serializes z.enum([...]) as {"type":"string","enum":[...]} — these tests pin
 *  that the spawn_agent ToolSpec actually carries it through end-to-end. */
describe("spawn_agent tool spec: model enum", () => {
  test("with a 3-model provider list → the spec's model property carries the closed enum with exactly those ids", () => {
    const r = new ToolRegistry();
    registerSpawnAgentTool(r, { models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] });
    const spec = r.specs(null).find((s) => s.name === "spawn_agent")!;
    expect(spec).toBeDefined();
    const params = spec.parameters as { properties: { model: { type: string; enum?: string[] } } };
    expect(params.properties.model.enum).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(params.properties.model.type).toBe("string");
    // the description names the ids too — belt-and-braces for clients that render enums poorly
    expect(spec.description).toContain("gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna");
  });

  test("with no models list (or an empty one) → plain string, no enum", () => {
    const r = new ToolRegistry();
    registerSpawnAgentTool(r); // opts omitted entirely
    const spec = r.specs(null).find((s) => s.name === "spawn_agent")!;
    const params = spec.parameters as { properties: { model: { type: string; enum?: string[] } } };
    expect(params.properties.model.type).toBe("string");
    expect(params.properties.model.enum).toBeUndefined();
    expect(spec.description).toContain("model: optional model override");

    const r2 = new ToolRegistry();
    registerSpawnAgentTool(r2, { models: [] });
    const spec2 = r2.specs(null).find((s) => s.name === "spawn_agent")!;
    const params2 = spec2.parameters as { properties: { model: { type: string; enum?: string[] } } };
    expect(params2.properties.model.enum).toBeUndefined();
  });
});

// 4g-ii (CC parity): `description` is now a REQUIRED spawn_agent arg (registry-level zod
// validation, distinct from the engine's own concurrent-bridge check in engine-spawn.test.ts,
// which hand-parses argsJson and bypasses this registry.execute() path entirely).
describe("spawn_agent tool: description is required", () => {
  test("missing description → invalid arguments (registry-level zod validation)", async () => {
    const r = new ToolRegistry();
    registerSpawnAgentTool(r);
    const out = await r.execute("spawn_agent", { prompt: "do X" }, { cwd: "/", roots: ["/"], sessionId: "s" });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("description");
  });

  test("present → placeholder run() still fires (cfg.subagents/agents absent path — registry.execute is unaffected)", async () => {
    const r = new ToolRegistry();
    registerSpawnAgentTool(r);
    const out = await r.execute("spawn_agent", { prompt: "do X", description: "explore X" }, { cwd: "/", roots: ["/"], sessionId: "s" });
    expect(out.isError).toBe(false);
    expect(out.output).toContain("subagents are not available in this session");
  });
});
