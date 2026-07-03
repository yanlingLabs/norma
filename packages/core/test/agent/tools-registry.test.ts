import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithin } from "../../src/agent/paths";

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

describe("scope-aware registry", () => {
  const A = realpathSync(mkdtempSync(join(tmpdir(), "reg-a-")));
  const B = realpathSync(mkdtempSync(join(tmpdir(), "reg-b-")));

  test("isWithin: exact, descendant, non-descendant", () => {
    mkdirSync(join(A, "sub"), { recursive: true });
    expect(isWithin(A, A)).toBe(true);
    expect(isWithin(join(A, "sub"), A)).toBe(true);
    expect(isWithin(B, A)).toBe(false);
    expect(isWithin(A + "-sibling", A)).toBe(false); // prefix-string but not a path child
  });

  test("specs(cwd) surfaces a scoped tool only when cwd is within scope", () => {
    const r = new ToolRegistry();
    r.register({ name: "global", description: "g", args: z.object({}), run: () => "g" });
    r.register({ name: "mcp__p__t", description: "p", args: z.object({}).passthrough(), scope: A, run: () => "p" });
    expect(r.specs(A).map((s) => s.name).sort()).toEqual(["global", "mcp__p__t"]);
    expect(r.specs(join(A, "sub")).map((s) => s.name).sort()).toEqual(["global", "mcp__p__t"]); // descendant
    expect(r.specs(B).map((s) => s.name)).toEqual(["global"]);   // other cwd → scoped hidden
    expect(r.specs(null).map((s) => s.name)).toEqual(["global"]); // no cwd → scoped hidden
  });

  test("execute REJECTS a scoped tool from a non-scope cwd (defense-in-depth, run not called)", async () => {
    const r = new ToolRegistry();
    let ran = false;
    r.register({ name: "mcp__p__t", description: "p", args: z.object({}).passthrough(), scope: A, run: () => { ran = true; return "ran"; } });
    const denied = await r.execute("mcp__p__t", {}, { cwd: B, roots: [B], sessionId: "s" });
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("not available in this directory");
    expect(ran).toBe(false); // run must NOT execute
    const ok = await r.execute("mcp__p__t", {}, { cwd: A, roots: [A], sessionId: "s" });
    expect(ok.output).toBe("ran");
  });

  test("unregister removes a tool", () => {
    const r = new ToolRegistry();
    r.register({ name: "mcp__p__t", description: "p", args: z.object({}), scope: A, run: () => "x" });
    expect(r.has("mcp__p__t")).toBe(true);
    r.unregister("mcp__p__t");
    expect(r.has("mcp__p__t")).toBe(false);
  });
});
