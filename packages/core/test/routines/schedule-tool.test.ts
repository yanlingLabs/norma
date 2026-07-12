import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerScheduleTool } from "../../src/agent/tools/schedule";
import { RoutineStore } from "../../src/routines/store";
import { PermissionGate } from "../../src/agent/gate";

function makeStore(): RoutineStore {
  return new RoutineStore(join(mkdtempSync(join(tmpdir(), "norma-schedule-tool-")), "routines.db"));
}

function ctx(cwd = "/tmp/proj") {
  return { cwd, roots: [cwd], sessionId: "s_1" };
}

describe("schedule tool (phase 5 routines T3)", () => {
  test("is registered and gate-carded as MUTATING (ask under ask-policy, allow under auto, deny under plan)", () => {
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines: makeStore() });
    expect(r.has("schedule")).toBe(true);
    const gate = new PermissionGate();
    expect(gate.evaluate("schedule", "ask")).toBe("ask");
    expect(gate.evaluate("schedule", "auto")).toBe("allow");
    expect(gate.evaluate("schedule", "plan")).toBe("deny");
  });

  test("description documents the spec formats and the auto|plan policy restriction", () => {
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines: makeStore() });
    const spec = r.specFor("schedule");
    expect(spec).toBeDefined();
    expect(spec!.description).toMatch(/every <N>/);
    expect(spec!.description).toMatch(/cron/i);
    expect(spec!.description).toMatch(/auto/);
    expect(spec!.description).toMatch(/plan/);
  });

  test("op=create makes a routine and returns human-readable text naming id/spec/next-run", async () => {
    const routines = makeStore();
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines });
    const out = await r.execute("schedule", { op: "create", spec: "every 30m", prompt: "check inbox" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toMatch(/created routine/);
    expect(out.output).toMatch(/every 30m/);
    const all = routines.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.prompt).toBe("check inbox");
    expect(all[0]!.policy).toBe("auto"); // default
    expect(out.output).toContain(all[0]!.id);
  });

  test("op=create defaults cwd to the tool's ctx.cwd when omitted", async () => {
    const routines = makeStore();
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines });
    await r.execute("schedule", { op: "create", spec: "every 1h", prompt: "p" }, ctx("/tmp/from-ctx"));
    expect(routines.list()[0]!.cwd).toBe("/tmp/from-ctx");
  });

  test("op=create with an explicit cwd overrides ctx.cwd", async () => {
    const routines = makeStore();
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines });
    await r.execute("schedule", { op: "create", spec: "every 1h", prompt: "p", cwd: "/tmp/explicit" }, ctx("/tmp/from-ctx"));
    expect(routines.list()[0]!.cwd).toBe("/tmp/explicit");
  });

  test("op=create rejects policy \"ask\" as an isError outcome (never throws out of execute)", async () => {
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines: makeStore() });
    const out = await r.execute("schedule", { op: "create", spec: "every 1h", prompt: "p", policy: "ask" }, ctx());
    expect(out.isError).toBe(true);
  });

  test("op=create rejects an invalid spec as an isError outcome", async () => {
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines: makeStore() });
    const out = await r.execute("schedule", { op: "create", spec: "not a spec", prompt: "p" }, ctx());
    expect(out.isError).toBe(true);
  });

  test("op=list returns one line per routine: id, spec, enabled, next run ISO, prompt head; empty store says so", async () => {
    const routines = makeStore();
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines });

    const empty = await r.execute("schedule", { op: "list" }, ctx());
    expect(empty.isError).toBe(false);
    expect(empty.output.toLowerCase()).toMatch(/no routines/);

    const created = routines.create({ spec: "every 30m", prompt: "check inbox for unread messages and summarize them" });
    const out = await r.execute("schedule", { op: "list" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain(created.id);
    expect(out.output).toContain("every 30m");
    expect(out.output).toMatch(/enabled/);
    expect(out.output).toContain(new Date(created.nextRunAt).toISOString());
    expect(out.output).toMatch(/check inbox/);
  });

  test("op=delete removes a routine; unknown id reports not-found without erroring", async () => {
    const routines = makeStore();
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines });
    const created = routines.create({ spec: "every 1h", prompt: "p" });

    const out = await r.execute("schedule", { op: "delete", id: created.id }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toMatch(/deleted/);
    expect(routines.get(created.id)).toBeUndefined();

    const missing = await r.execute("schedule", { op: "delete", id: "nope" }, ctx());
    expect(missing.isError).toBe(false);
    expect(missing.output.toLowerCase()).toMatch(/no routine/);
  });

  test("op=enable / op=disable toggle a routine's enabled flag", async () => {
    const routines = makeStore();
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines });
    const created = routines.create({ spec: "every 1h", prompt: "p", enabled: true });

    const disabled = await r.execute("schedule", { op: "disable", id: created.id }, ctx());
    expect(disabled.isError).toBe(false);
    expect(disabled.output).toMatch(/disabled/);
    expect(routines.get(created.id)!.enabled).toBe(false);

    const enabled = await r.execute("schedule", { op: "enable", id: created.id }, ctx());
    expect(enabled.isError).toBe(false);
    expect(enabled.output).toMatch(/enabled/);
    expect(routines.get(created.id)!.enabled).toBe(true);
  });

  test("op=enable on an unknown id reports not-found without erroring", async () => {
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines: makeStore() });
    const out = await r.execute("schedule", { op: "enable", id: "nope" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output.toLowerCase()).toMatch(/no routine/);
  });

  test("invalid args (unknown op) is an isError outcome, not a throw", async () => {
    const r = new ToolRegistry();
    registerScheduleTool(r, { routines: makeStore() });
    const out = await r.execute("schedule", { op: "bogus" }, ctx());
    expect(out.isError).toBe(true);
  });
});
