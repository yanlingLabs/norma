import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";

describe("ToolDefinition.rawParameters", () => {
  test("specs() emits rawParameters verbatim when present; z.toJSONSchema otherwise", () => {
    const r = new ToolRegistry();
    const raw = { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] };
    r.register({ name: "mcp__x__echo", description: "d", args: z.object({}).passthrough(), rawParameters: raw, run: () => "ok" });
    r.register({ name: "plain", description: "d", args: z.object({ a: z.string() }), run: () => "ok" });
    const specs = r.specs();
    expect(specs.find((s) => s.name === "mcp__x__echo")!.parameters).toEqual(raw);
    expect(specs.find((s) => s.name === "plain")!.parameters).toMatchObject({ type: "object" }); // z.toJSONSchema
  });
});
