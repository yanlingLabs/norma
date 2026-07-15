import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { WorktreeManager } from "../../src/agent/worktree";
import { registerPlanTool } from "../../src/agent/tools/plan";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

// Mirrors engine-skills.test.ts's `done` helper.
const done = (reason: "end_turn" | "tool_calls") => ({ type: "done" as const, stopReason: reason });

// 4g fix-wave-1 tests below exercise the REAL worktree bridge (a git-backed WorktreeManager),
// mirroring engine-worktree.test.ts's isMac gate + repo() helper — the bridge shells out to real
// git, so these are skipped off-mac exactly like that file's own worktree bridge tests.
const isMac = process.platform === "darwin";

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** mkdtemp + git init + an initial commit so HEAD exists. Mirrors engine-worktree.test.ts's repo(). */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-ts-wt-")));
  git(["init"], dir);
  git(["config", "user.email", "test@norma.dev"], dir);
  git(["config", "user.name", "Norma Test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

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

  test("PIN (bg task): a live bg task pins bash_output/task_stop into specs; the pin releases once the task exits (sticky set untouched — they don't leak into the next turn)", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registry.register({ name: "bash_output", description: "read bg output", args: z.object({ taskId: z.string() }), deferred: true, run: () => "stub" });
    // task_stop is the one generic stop tool (CC parity: the standalone bash_kill tool was
    // removed) — its bash-unify path is what gets pinned here alongside bash_output.
    registry.register({ name: "task_stop", description: "stop a bg agent or bg task", args: z.object({ task_id: z.string() }), deferred: true, run: () => "stub" });

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
    expect(turn1Names).toContain("task_stop");

    status = "exited";
    await engine.runTurn(sessionId); // turn 2
    // If bash_output/task_stop had leaked into the STICKY loadedTools set (rather than being a
    // per-round pin), they'd still be present here even with no live task — this is the proof
    // that pinnedTools never touched the sticky set.
    const turn2Names = provider.requests[1]!.tools?.map((t) => t.name) ?? [];
    expect(turn2Names).not.toContain("bash_output");
    expect(turn2Names).not.toContain("task_stop");
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

  test("deferExternals:'always' end-to-end: a single external tool (well under a high deferThreshold) is still deferred", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registry.register({ name: "mcp__s__t1", description: "a lone external tool", args: z.object({}).passthrough(), run: () => "ok" });

    const provider = new FakeProvider([[{ type: "text_delta", delta: "ok" }, done("end_turn")]]);
    // deferThreshold 12 would normally leave a single external tool visible ("count" mode) —
    // deferExternals:"always" defers it anyway, ignoring the count comparison entirely.
    const { engine, sessionId } = setupEngine(provider, { registry, toolSearch: { deferThreshold: 12, deferExternals: "always" } });

    await engine.runTurn(sessionId);

    const names = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(names).not.toContain("mcp__s__t1");
    expect(names).toContain("ToolSearch");
    expect(provider.requests[0]!.instructions).toContain("mcp__s__t1"); // listed as a deferred tool
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4g fix-wave-1 (T1 review): the engine's dispatch loop intercepts enter_worktree/
// exit_worktree (and exit_plan_mode) BEFORE execute() ever runs, via a bridge that shells
// straight to the WorktreeManager. registry.execute()'s deferred-rejection check never gets a
// chance to fire for those tools — so before this fix, calling enter_worktree unloaded reached
// the bridge and silently succeeded instead of being told to load its schema first. These tests
// exercise the REAL worktree bridge (git-backed WorktreeManager), like engine-worktree.test.ts.
// -------------------------------------------------------------------------------------------
describe.if(isMac)("engine: deferred-tool guard runs before the worktree bridge (4g fix-wave-1)", () => {
  test("REJECT: enter_worktree called unloaded is rejected before the bridge runs — no worktree created", async () => {
    const cwd = repo();
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerWorktreeTools(registry, { deferred: true });
    const worktrees = new WorktreeManager({ baseRef: () => "head" });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, cwd, worktrees, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    if (!toolResult || toolResult.type !== "tool_result") throw new Error("expected a tool_result for e1");
    expect(toolResult.isError).toBe(true);
    expect(toolResult.output).toContain("deferred");
    expect(toolResult.output).toContain("ToolSearch");
    // The bridge did NOT run: no worktree_entered event, and the manager itself never registered
    // an active worktree for this session (the ground-truth "did the bridge actually fire" check).
    expect(events.some((e) => e.type === "worktree_entered")).toBe(false);
    expect(worktrees.active(sessionId)).toBeUndefined();
  });

  test("LOAD THEN CALL: ToolSearch-loading enter_worktree lets the SAME tool reach the bridge", async () => {
    const cwd = repo();
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerWorktreeTools(registry, { deferred: true });
    const worktrees = new WorktreeManager({ baseRef: () => "head" });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "s1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:enter_worktree" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, cwd, worktrees, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId);

    expect(events.some((e) => e.type === "worktree_entered")).toBe(true);
    expect(worktrees.active(sessionId)).toBeDefined();
    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(enterResult).toMatchObject({ isError: false });
  });

  test("PIN PASSES: exit_worktree called unloaded works while a worktree is active (pinned)", async () => {
    const cwd = repo();
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerWorktreeTools(registry, { deferred: true });
    const worktrees = new WorktreeManager({ baseRef: () => "head" });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "s1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:enter_worktree" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
      // exit_worktree is NEVER loaded via ToolSearch — only pinned, because a worktree is active.
      [{ type: "tool_call", callId: "x1", name: "exit_worktree", argsJson: JSON.stringify({ action: "keep" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, cwd, worktrees, toolSearch: { deferThreshold: 12 } });

    await engine.runTurn(sessionId);

    expect(events.some((e) => e.type === "worktree_exited")).toBe(true);
    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "x1");
    expect(exitResult).toMatchObject({ isError: false });
  });

  test("DISABLED: toolSearch disabled → enter_worktree unloaded works exactly as pre-4g (guard is a no-op)", async () => {
    const cwd = repo();
    const registry = new ToolRegistry();
    registerWorktreeTools(registry, { deferred: true }); // deferred:true, but inert without toolSearch enabled
    const worktrees = new WorktreeManager({ baseRef: () => "head" });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, cwd, worktrees }); // toolSearch undefined

    await engine.runTurn(sessionId);

    expect(events.some((e) => e.type === "worktree_entered")).toBe(true);
    expect(worktrees.active(sessionId)).toBeDefined();
    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(enterResult).toMatchObject({ isError: false });
  });
});

// enter_plan_mode (4g Task 4): the engine's dispatch loop intercepts it unconditionally (no
// broker/manager dependency to gate the bridge on, unlike worktree/exit_plan_mode) — but it's
// still registered `deferred: true` (daemon.ts), so the SAME guard that runs "BEFORE any of the
// bridge intercepts" (engine.ts's isDeferredBuiltin check, just above the dispatch loop's
// bridge branches) must reject an unloaded call before the bridge ever gets a chance to flip the
// session into plan mode. This is the ONE toolSearch-on test for the bridge (the policy-switch/
// already-in-plan bridge-behavior tests live in engine-plan.test.ts, run toolSearch-off).
describe("engine: deferred-tool guard runs before the enter_plan_mode bridge (4g Task 4)", () => {
  test("REJECT: enter_plan_mode called unloaded is rejected before the bridge runs — policy unchanged", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerPlanTool(registry, { deferred: true });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "p1", name: "enter_plan_mode", argsJson: "{}" }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, store, events } = setupEngine(provider, { registry, toolSearch: {} });

    await engine.runTurn(sessionId);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    if (!toolResult || toolResult.type !== "tool_result") throw new Error("expected a tool_result for p1");
    expect(toolResult.isError).toBe(true);
    expect(toolResult.output).toContain("deferred");
    expect(toolResult.output).toContain("ToolSearch");
    // The rejection message above IS the proof the bridge never ran (it fires BEFORE the
    // dispatch-loop bridge branches — see the isDeferredBuiltin guard's doc comment in engine.ts).
    // This policy check is NOT independent evidence of that on its own: setupEngine doesn't wire
    // `cfg.setPolicy`, so store.meta() would read "auto" here even if the bridge HAD run (its
    // `cfg.setPolicy?.(...)` call would just no-op) — kept only as a sanity check that nothing
    // else in the turn incidentally touched the persisted policy.
    expect(store.meta(sessionId).approvalPolicy).toBe("auto"); // setupEngine's default policy
  });

  test("LOAD THEN CALL: ToolSearch-loading enter_plan_mode lets the SAME tool reach the bridge", async () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerPlanTool(registry, { deferred: true });
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "s1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:enter_plan_mode" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "p1", name: "enter_plan_mode", argsJson: "{}" }, done("tool_calls")],
      [{ type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, sessionId, events } = setupEngine(provider, { registry, toolSearch: {} });

    await engine.runTurn(sessionId);

    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(enterResult).toMatchObject({ isError: false });
    expect((enterResult as any).output).toContain("Plan mode ON");
  });
});
