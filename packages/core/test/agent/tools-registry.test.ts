import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithin } from "../../src/agent/paths";

const A = realpathSync(mkdtempSync(join(tmpdir(), "reg-a-")));
const B = realpathSync(mkdtempSync(join(tmpdir(), "reg-b-")));

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

describe("deferral", () => {
  function registerMcp(r: ToolRegistry, count: number): void {
    for (let i = 1; i <= count; i++) {
      r.register({ name: `mcp__s__t${i}`, description: `d${i}`, args: z.object({}), run: () => "ok" });
    }
  }

  test("no opts → all tools (byte-identical to today)", () => {
    const r = new ToolRegistry();
    registerMcp(r, 15);
    r.register({ name: "read", description: "read a file", args: z.object({}), run: () => "ok" });
    const specs = r.specs(null);
    expect(specs.length).toBe(16);
    for (let i = 1; i <= 15; i++) expect(specs.some((s) => s.name === `mcp__s__t${i}`)).toBe(true);
  });

  test("above threshold → mcp absent unless loaded; built-ins present; ToolSearch present", () => {
    const r = new ToolRegistry();
    registerMcp(r, 13);
    r.register({ name: "read", description: "read a file", args: z.object({}), run: () => "ok" });
    r.register({ name: "ToolSearch", description: "search deferred tools", args: z.object({}), run: () => "ok" });
    const specs = r.specs(null, { deferThreshold: 12, loaded: new Set(["mcp__s__t3"]) });
    const names = specs.map((s) => s.name);
    expect(names).toContain("read");
    expect(names).toContain("ToolSearch");
    expect(names).toContain("mcp__s__t3");
    expect(names).not.toContain("mcp__s__t1");
  });

  test("at/below threshold → all mcp + NO ToolSearch in specs", () => {
    const r = new ToolRegistry();
    registerMcp(r, 12);
    r.register({ name: "ToolSearch", description: "search deferred tools", args: z.object({}), run: () => "ok" });
    const specs = r.specs(null, { deferThreshold: 12 });
    const names = specs.map((s) => s.name);
    for (let i = 1; i <= 12; i++) expect(names).toContain(`mcp__s__t${i}`);
    expect(names).not.toContain("ToolSearch");
  });

  test("deferredIndex lists not-loaded mcp with capped descriptions; [] when inactive", () => {
    const r = new ToolRegistry();
    registerMcp(r, 12);
    r.unregister("mcp__s__t12");
    const longDesc = "x".repeat(200);
    r.register({ name: "mcp__s__t12", description: longDesc, args: z.object({}), run: () => "ok" });
    // inactive: no threshold provided
    expect(r.deferredIndex(null)).toEqual([]);
    // active: 13 mcp > threshold 12
    r.register({ name: "mcp__s__t13", description: "d13", args: z.object({}), run: () => "ok" });
    const idx = r.deferredIndex(null, new Set(["mcp__s__t1"]), 12);
    expect(idx.some((e) => e.name === "mcp__s__t1")).toBe(false); // loaded, excluded
    const entry = idx.find((e) => e.name === "mcp__s__t12")!;
    expect(entry.description.length).toBe(150);
  });

  test("specFor returns the full spec; respects scope; undefined outside/unknown", () => {
    const r = new ToolRegistry();
    r.register({ name: "mcp__p__t", description: "p", args: z.object({}).passthrough(), scope: A, run: () => "p" });
    expect(r.specFor("mcp__p__t", A)?.name).toBe("mcp__p__t");
    expect(r.specFor("mcp__p__t", "/elsewhere")).toBeUndefined();
    expect(r.specFor("nope-not-registered", A)).toBeUndefined();
  });

  test("execute rejects a deferred-not-loaded mcp tool (run NOT called); loaded runs; non-mcp never deferred; no threshold in ctx → never deferred", async () => {
    const r = new ToolRegistry();
    registerMcp(r, 13);
    let ran = false;
    r.unregister("mcp__s__t1");
    r.register({ name: "mcp__s__t1", description: "d1", args: z.object({}), run: () => { ran = true; return "ran"; } });
    r.register({ name: "read", description: "read a file", args: z.object({}), run: () => "read-ok" });

    const ctx = { cwd: "/", roots: ["/"], sessionId: "s", deferThreshold: 12, loadedTools: new Set<string>() };
    const denied = await r.execute("mcp__s__t1", {}, ctx);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("deferred — load its schema via ToolSearch first");
    expect(ran).toBe(false);

    ctx.loadedTools.add("mcp__s__t1");
    const ok = await r.execute("mcp__s__t1", {}, ctx);
    expect(ok.isError).toBe(false);
    expect(ran).toBe(true);

    const readOk = await r.execute("read", {}, ctx);
    expect(readOk.isError).toBe(false);
    expect(readOk.output).toBe("read-ok");

    const noThreshold = { cwd: "/", roots: ["/"], sessionId: "s" };
    const runsWithoutThreshold = await r.execute("mcp__s__t2", {}, noThreshold);
    expect(runsWithoutThreshold.isError).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4b Task 4 (spec §3): `plugin__<pluginId>__<tool>` tools ride the SAME deferral machinery
// as `mcp__` tools (isExternalToolName, registry.ts) — every test below mirrors a "deferral"
// describe-block test above 1:1, substituting plugin__ names, plus a mixed-namespace test proving
// they share ONE combined count/threshold (not two independent pools).
// -------------------------------------------------------------------------------------------
describe("plugin__ tool deferral parity with mcp__", () => {
  function registerPlugin(r: ToolRegistry, pluginId: string, count: number): void {
    for (let i = 1; i <= count; i++) {
      r.register({ name: `plugin__${pluginId}__t${i}`, description: `d${i}`, args: z.object({}), run: () => "ok" });
    }
  }

  test("no opts → all tools (byte-identical to today)", () => {
    const r = new ToolRegistry();
    registerPlugin(r, "demo", 15);
    r.register({ name: "read", description: "read a file", args: z.object({}), run: () => "ok" });
    const specs = r.specs(null);
    expect(specs.length).toBe(16);
    for (let i = 1; i <= 15; i++) expect(specs.some((s) => s.name === `plugin__demo__t${i}`)).toBe(true);
  });

  test("above threshold → plugin__ absent unless loaded; built-ins present; ToolSearch present", () => {
    const r = new ToolRegistry();
    registerPlugin(r, "demo", 13);
    r.register({ name: "read", description: "read a file", args: z.object({}), run: () => "ok" });
    r.register({ name: "ToolSearch", description: "search deferred tools", args: z.object({}), run: () => "ok" });
    const specs = r.specs(null, { deferThreshold: 12, loaded: new Set(["plugin__demo__t3"]) });
    const names = specs.map((s) => s.name);
    expect(names).toContain("read");
    expect(names).toContain("ToolSearch");
    expect(names).toContain("plugin__demo__t3");
    expect(names).not.toContain("plugin__demo__t1");
  });

  test("at/below threshold → all plugin__ + NO ToolSearch in specs (byte-identical to no-opts)", () => {
    const r = new ToolRegistry();
    registerPlugin(r, "demo", 12);
    r.register({ name: "ToolSearch", description: "search deferred tools", args: z.object({}), run: () => "ok" });
    const withThreshold = r.specs(null, { deferThreshold: 12 }).map((s) => s.name).sort();
    for (let i = 1; i <= 12; i++) expect(withThreshold).toContain(`plugin__demo__t${i}`);
    expect(withThreshold).not.toContain("ToolSearch");
    const withoutThreshold = r.specs(null).map((s) => s.name).sort();
    expect(withThreshold).toEqual(withoutThreshold); // deferral inactive either way — byte-identical
  });

  test("deferredIndex lists not-loaded plugin__ with capped descriptions; [] when inactive", () => {
    const r = new ToolRegistry();
    registerPlugin(r, "demo", 12);
    r.unregister("plugin__demo__t12");
    const longDesc = "x".repeat(200);
    r.register({ name: "plugin__demo__t12", description: longDesc, args: z.object({}), run: () => "ok" });
    expect(r.deferredIndex(null)).toEqual([]); // inactive: no threshold provided
    r.register({ name: "plugin__demo__t13", description: "d13", args: z.object({}), run: () => "ok" });
    const idx = r.deferredIndex(null, new Set(["plugin__demo__t1"]), 12);
    expect(idx.some((e) => e.name === "plugin__demo__t1")).toBe(false); // loaded, excluded
    const entry = idx.find((e) => e.name === "plugin__demo__t12")!;
    expect(entry.description.length).toBe(150);
  });

  test("execute rejects a deferred-not-loaded plugin__ tool (run NOT called); loaded runs", async () => {
    const r = new ToolRegistry();
    registerPlugin(r, "demo", 13);
    let ran = false;
    r.unregister("plugin__demo__t1");
    r.register({ name: "plugin__demo__t1", description: "d1", args: z.object({}), run: () => { ran = true; return "ran"; } });

    const ctx = { cwd: "/", roots: ["/"], sessionId: "s", deferThreshold: 12, loadedTools: new Set<string>() };
    const denied = await r.execute("plugin__demo__t1", {}, ctx);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("deferred — load its schema via ToolSearch first");
    expect(ran).toBe(false);

    ctx.loadedTools.add("plugin__demo__t1");
    const ok = await r.execute("plugin__demo__t1", {}, ctx);
    expect(ok.isError).toBe(false);
    expect(ran).toBe(true);
  });

  test("mcp__ and plugin__ tools share ONE combined threshold count, not two independent pools", () => {
    const r = new ToolRegistry();
    registerPlugin(r, "demo", 6);
    for (let i = 1; i <= 6; i++) {
      r.register({ name: `mcp__s__t${i}`, description: `d${i}`, args: z.object({}), run: () => "ok" });
    }
    // Exactly 12 external tools total (6 mcp__ + 6 plugin__) — AT threshold 12, not above it.
    expect(r.specs(null, { deferThreshold: 12 }).length).toBe(12);
    r.register({ name: "plugin__demo__t7", description: "d7", args: z.object({}), run: () => "ok" });
    // 13 > 12 now → deferral active, and it defers BOTH namespaces identically.
    const specs = r.specs(null, { deferThreshold: 12, loaded: new Set(["plugin__demo__t1"]) });
    const names = specs.map((s) => s.name);
    expect(names).toContain("plugin__demo__t1"); // loaded, rides along
    expect(names).not.toContain("plugin__demo__t2"); // deferred plugin__ tool
    expect(names).not.toContain("mcp__s__t1"); // deferred mcp__ tool — same predicate, same pass
  });
});

describe("unregisterByPrefix", () => {
  test("removes every tool whose name starts with the given prefix; leaves other plugins/tools untouched", () => {
    const r = new ToolRegistry();
    r.register({ name: "plugin__demo__a", description: "a", args: z.object({}), run: () => "a" });
    r.register({ name: "plugin__demo__b", description: "b", args: z.object({}), run: () => "b" });
    r.register({ name: "plugin__other__c", description: "c", args: z.object({}), run: () => "c" });
    r.register({ name: "read", description: "r", args: z.object({}), run: () => "r" });
    r.unregisterByPrefix("plugin__demo__");
    expect(r.has("plugin__demo__a")).toBe(false);
    expect(r.has("plugin__demo__b")).toBe(false);
    expect(r.has("plugin__other__c")).toBe(true);
    expect(r.has("read")).toBe(true);
  });

  test("no-op when nothing matches (never throws)", () => {
    const r = new ToolRegistry();
    r.register({ name: "read", description: "r", args: z.object({}), run: () => "r" });
    expect(() => r.unregisterByPrefix("plugin__nope__")).not.toThrow();
    expect(r.has("read")).toBe(true);
  });
});
