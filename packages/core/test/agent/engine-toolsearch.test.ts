import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// Mirrors engine-skills.test.ts's `done` helper.
const done = (reason: "end_turn" | "tool_calls") => ({ type: "done" as const, stopReason: reason });

// 13 trivial stub mcp__ tools (one over the {deferThreshold: 12} used throughout) + the real
// registerToolSearchTool — NO real MCP spawn. `ran` tracks which stubs actually executed, so
// the DEFENSE test can assert a rejected call never reached `run`.
function buildRegistry(): { registry: ToolRegistry; ran: Set<string> } {
  const registry = new ToolRegistry();
  registerToolSearchTool(registry);
  const ran = new Set<string>();
  for (let i = 1; i <= 13; i++) {
    const name = `mcp__s__t${i}`;
    registry.register({
      name,
      description: `stub deferred tool number ${i}`,
      args: z.object({}).passthrough(),
      run: () => { ran.add(name); return `${name}-ok`; },
    });
  }
  return { registry, ran };
}

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("engine: ToolSearch deferral wiring", () => {
  test("DEFERRED: round-0 tools lack the 13 mcp schemas but contain ToolSearch + built-ins; instructions contain the deferred section", async () => {
    const { registry } = buildRegistry();
    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine, sessionId } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId);

    const req = provider.requests[0]!;
    const names = req.tools?.map((t) => t.name) ?? [];
    for (let i = 1; i <= 13; i++) expect(names).not.toContain(`mcp__s__t${i}`);
    expect(names).toContain("ToolSearch");
    for (const builtin of ["read", "glob", "grep", "write", "edit", "Skill"]) expect(names).toContain(builtin);

    expect(req.instructions).toContain("# Deferred tools");
    expect(req.instructions).toContain("mcp__s__t1");
  });

  test("LOAD FLOW: a ToolSearch call in round 0 makes the tool's schema present in round 1; its tool_result says it's now callable", async () => {
    const { registry } = buildRegistry();
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:mcp__s__t3" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId);

    expect(provider.requests.length).toBe(2);
    const round0Names = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(round0Names).not.toContain("mcp__s__t3");
    const round1Names = provider.requests[1]!.tools?.map((t) => t.name) ?? [];
    expect(round1Names).toContain("mcp__s__t3");

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    if (!toolResult || toolResult.type !== "tool_result") throw new Error("expected a tool_result for c1");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toContain("now callable");
  });

  test("STICKY: a load in turn 1 is still visible in turn 2's tools, with no re-load needed", async () => {
    const { registry } = buildRegistry();
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:mcp__s__t3" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")], // ends turn 1
      [{ type: "text_delta", delta: "ok2" }, done("end_turn")], // turn 2: a plain end_turn round
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId); // turn 1: loads mcp__s__t3 mid-turn, then ends (2 requests)
    await engine.runTurn(sessionId); // turn 2: plain end_turn (1 more request)

    expect(provider.requests.length).toBe(3);
    const turn2Names = provider.requests[2]!.tools?.map((t) => t.name) ?? [];
    expect(turn2Names).toContain("mcp__s__t3");

    // No NEW ToolSearch call was made (or needed) for turn 2 — only the one from turn 1 round 0.
    const toolSearchCalls = events.filter((e) => e.type === "tool_call" && e.name === "ToolSearch");
    expect(toolSearchCalls.length).toBe(1);
  });

  test("DEFENSE: a direct call to an unloaded deferred tool is rejected with a ToolSearch hint; run is NOT called", async () => {
    const { registry, ran } = buildRegistry();
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "mcp__s__t5", argsJson: "{}" }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    if (!toolResult || toolResult.type !== "tool_result") throw new Error("expected a tool_result for c1");
    expect(toolResult.isError).toBe(true);
    expect(toolResult.output).toContain("deferred — load its schema via ToolSearch first");
    expect(ran.has("mcp__s__t5")).toBe(false);
  });

  test("BELOW THRESHOLD: request is byte-identical to toolSearch being unset — all 13 mcp schemas present, no ToolSearch, no deferred section", async () => {
    const cwd = tmpCwd("norma-ts-below-cwd-");

    const { registry: regA } = buildRegistry();
    const providerA = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine: engineA, sessionId: sidA } = setupEngine(providerA, { registry: regA, cwd, toolSearch: { deferThreshold: 20 } });
    await engineA.runTurn(sidA);

    const { registry: regB } = buildRegistry();
    const providerB = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine: engineB, sessionId: sidB } = setupEngine(providerB, { registry: regB, cwd }); // toolSearch undefined
    await engineB.runTurn(sidB);

    const reqA = providerA.requests[0]!;
    const reqB = providerB.requests[0]!;
    expect(reqA.instructions).toBe(reqB.instructions);
    expect(reqA.instructions).not.toContain("# Deferred tools");
    const namesA = [...(reqA.tools?.map((t) => t.name) ?? [])].sort();
    const namesB = [...(reqB.tools?.map((t) => t.name) ?? [])].sort();
    expect(namesA).toEqual(namesB);
    expect(namesA).not.toContain("ToolSearch");
    for (let i = 1; i <= 13; i++) expect(namesA).toContain(`mcp__s__t${i}`);
  });

  test("DISABLED (enabled:false): unchanged from toolSearch being unset, even with a triggering deferThreshold", async () => {
    const cwd = tmpCwd("norma-ts-disabled-cwd-");

    const { registry: regA } = buildRegistry();
    const providerA = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine: engineA, sessionId: sidA } = setupEngine(providerA, { registry: regA, cwd, toolSearch: { enabled: false, deferThreshold: 12 } });
    await engineA.runTurn(sidA);

    const { registry: regB } = buildRegistry();
    const providerB = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine: engineB, sessionId: sidB } = setupEngine(providerB, { registry: regB, cwd }); // toolSearch undefined
    await engineB.runTurn(sidB);

    const reqA = providerA.requests[0]!;
    const reqB = providerB.requests[0]!;
    expect(reqA.instructions).toBe(reqB.instructions);
    expect(reqA.instructions).not.toContain("# Deferred tools");
    const namesA = [...(reqA.tools?.map((t) => t.name) ?? [])].sort();
    const namesB = [...(reqB.tools?.map((t) => t.name) ?? [])].sort();
    expect(namesA).toEqual(namesB);
    expect(namesA).not.toContain("ToolSearch");
    for (let i = 1; i <= 13; i++) expect(namesA).toContain(`mcp__s__t${i}`);
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4g Task 1: built-in tool deferral (registry.ts's `deferred: true`) + the engine's
// per-round state pins (pinnedTools) that force a state-required deferred built-in visible
// WITHOUT going through ToolSearch and WITHOUT touching the sticky loadedTools set.
// -------------------------------------------------------------------------------------------
describe("engine: built-in deferral + state pins (4g-i)", () => {
  test("PIN (plan): a plan-policy session shows exit_plan_mode in round-0 specs without any ToolSearch load", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registry.register({ name: "exit_plan_mode", description: "present a plan", args: z.object({ plan: z.string() }), deferred: true, run: () => "stub" });

    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine, sessionId } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12 }, policy: "plan" });

    await engine.runTurn(sessionId);

    expect(provider.requests.length).toBe(1); // no ToolSearch round needed
    const names = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("exit_plan_mode"); // pinned visible even though never loaded
  });

  test("PIN (bg task): a live bg task pins bash_output/bash_kill into specs; the pin releases once the task exits (sticky set untouched — they don't leak into the next turn)", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registry.register({ name: "bash_output", description: "read bg output", args: z.object({ taskId: z.string() }), deferred: true, run: () => "stub" });
    registry.register({ name: "bash_kill", description: "kill a bg task", args: z.object({ taskId: z.string() }), deferred: true, run: () => "stub" });

    let status: "running" | "exited" = "running";
    const bgRegistry = { list: () => [{ status }] };

    const provider = new FakeProvider([
      [{ type: "text_delta", delta: "ok" }, done("end_turn")], // turn 1: task running
      [{ type: "text_delta", delta: "ok2" }, done("end_turn")], // turn 2: task exited
    ]);
    const { engine, sessionId } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12 }, bgRegistry });

    await engine.runTurn(sessionId); // turn 1
    const turn1Names = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(turn1Names).toContain("bash_output");
    expect(turn1Names).toContain("bash_kill");

    status = "exited";
    await engine.runTurn(sessionId); // turn 2
    // If bash_output/bash_kill had leaked into the STICKY loadedTools set (rather than being a
    // per-round pin), they'd still be present here even with no live task — this is the proof
    // that pinnedTools never touched the sticky set.
    const turn2Names = provider.requests[1]!.tools?.map((t) => t.name) ?? [];
    expect(turn2Names).not.toContain("bash_output");
    expect(turn2Names).not.toContain("bash_kill");
  });

  test("BYTE-IDENTICAL: toolSearch unset → specs identical whether or not built-ins carry deferred:true", async () => {
    const cwd = tmpCwd("norma-ts-builtin-byteid-cwd-");

    const flagged = new ToolRegistry();
    flagged.register({ name: "notebook_edit", description: "edit a notebook", args: z.object({}), deferred: true, run: () => "ok" });
    const providerA = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine: engineA, sessionId: sidA } = setupEngine(providerA, { registry: flagged, cwd }); // toolSearch undefined

    const plain = new ToolRegistry();
    plain.register({ name: "notebook_edit", description: "edit a notebook", args: z.object({}), run: () => "ok" });
    const providerB = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    const { engine: engineB, sessionId: sidB } = setupEngine(providerB, { registry: plain, cwd });

    await engineA.runTurn(sidA);
    await engineB.runTurn(sidB);

    const reqA = providerA.requests[0]!;
    const reqB = providerB.requests[0]!;
    expect(reqA.instructions).toBe(reqB.instructions);
    const namesA = [...(reqA.tools?.map((t) => t.name) ?? [])].sort();
    const namesB = [...(reqB.tools?.map((t) => t.name) ?? [])].sort();
    expect(namesA).toEqual(namesB);
    expect(namesA).toContain("notebook_edit"); // present either way — deferred:true is inert without toolSearch enabled
  });
});
