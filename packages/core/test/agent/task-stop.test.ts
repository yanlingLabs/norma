import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerTaskStopTool } from "../../src/agent/tools/task-stop";
import { BackgroundAgentRegistry } from "../../src/agent/bg-agent-registry";
import { BackgroundTaskRegistry } from "../../src/agent/bg-registry";
import { sandboxAvailable } from "../../src/agent/sandbox";
import { sessionTmpDir } from "../../src/agent/session-tmp";
import { setup } from "./engine-spawn.test";

// 4h-ii-c Task 2: task_stop (CC's TaskStop) — stop a RUNNING background agent (by agentId or
// name) or a background bash task (by taskId). Unlike spawn_agent/send_message, task_stop is a
// PLAIN TOOL (registerBashTool's deps pattern), not an engine bridge — so most of its behavior is
// testable directly against the tool + registries, with the engine only needed for (a) the
// abort→thread_completed→settle lifecycle and (f) child-tool-set exclusion.

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isChildRun = (input: readonly unknown[], opening: string): boolean => {
  const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
  return first?.type === "message" && first.role === "user" && first.content === opening;
};
const toolResult = (events: readonly SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined =>
  events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;

const ctx = (sessionId: string) => ({ cwd: "/tmp", roots: ["/tmp"], sessionId });

// -------------------------------------------------------------------------------------------
// Tool-level tests (b)/(c)/(e): task_stop's resolution logic against a bare BackgroundAgentRegistry
// (+ optionally BackgroundTaskRegistry), no engine involved.
// -------------------------------------------------------------------------------------------
describe("task_stop tool (4h-ii-c Task 2)", () => {
  test("(b) stop by NAME resolves and stops the same agent; marks it notified", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    const abort = new AbortController();
    bgAgents.register({ agentId: "th_abc123", sessionId: "s1", threadId: "th_abc123", name: "worker", abort });
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents });

    const out = await r.execute("task_stop", { task_id: "worker" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "stopped agent 'worker'" });

    const entry = bgAgents.get("worker", "s1")!;
    expect(entry.agentId).toBe("th_abc123");
    expect(entry.status).toBe("stopped");
    expect(entry.notified).toBe(true);
    expect(abort.signal.aborted).toBe(true);
  });

  test("(b2) stop by agentId resolves + stops it directly", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    const abort = new AbortController();
    bgAgents.register({ agentId: "th_xyz789", sessionId: "s1", threadId: "th_xyz789", abort });
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents });

    const out = await r.execute("task_stop", { task_id: "th_xyz789" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "stopped agent 'th_xyz789'" });
    expect(bgAgents.get("th_xyz789", "s1")?.status).toBe("stopped");
    expect(abort.signal.aborted).toBe(true);
  });

  test("(c) already-completed agent → 'already completed', isError:false, no abort fired", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    const abort = new AbortController();
    bgAgents.register({ agentId: "th_done1", sessionId: "s1", threadId: "th_done1", abort });
    bgAgents.complete("th_done1", { ok: true, result: "all done" });
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents });

    const out = await r.execute("task_stop", { task_id: "th_done1" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "agent 'th_done1' already completed" });
    expect(abort.signal.aborted).toBe(false);
    // idempotent-friendly: entry stays completed, no re-notification churn
    expect(bgAgents.get("th_done1", "s1")?.status).toBe("completed");
  });

  test("(c2) already-stopped agent (a second task_stop call) → 'already stopped', isError:false", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    const abort = new AbortController();
    bgAgents.register({ agentId: "th_stop1", sessionId: "s1", threadId: "th_stop1", abort });
    bgAgents.stop("th_stop1");
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents });

    const out = await r.execute("task_stop", { task_id: "th_stop1" }, ctx("s1"));
    expect(out).toMatchObject({ isError: false, output: "agent 'th_stop1' already stopped" });
  });

  test("(e) unknown id, no bgAgents/bgRegistry match → typed isError", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents });

    const out = await r.execute("task_stop", { task_id: "ghost" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "no running agent or background task 'ghost'" });
  });

  test("(e2) unknown id with no deps at all (defaults) → typed isError, never throws unexpectedly", async () => {
    const r = new ToolRegistry();
    registerTaskStopTool(r);
    const out = await r.execute("task_stop", { task_id: "ghost" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "no running agent or background task 'ghost'" });
  });

  test("agent lookup is session-scoped: a running agent in a DIFFERENT session is not found by id, falls through to not-found", async () => {
    const bgAgents = new BackgroundAgentRegistry();
    const abort = new AbortController();
    bgAgents.register({ agentId: "th_foreign", sessionId: "s2", threadId: "th_foreign", abort });
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents });

    const out = await r.execute("task_stop", { task_id: "th_foreign" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "no running agent or background task 'th_foreign'" });
    expect(abort.signal.aborted).toBe(false);
  });

  test("missing task_id → invalid-args typed error (zod)", async () => {
    const r = new ToolRegistry();
    registerTaskStopTool(r);
    const out = await r.execute("task_stop", {}, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for task_stop");
  });
});

// -------------------------------------------------------------------------------------------
// (d) bash-task path: task_stop falls through to BackgroundTaskRegistry.kill() when no bgAgents
// entry matches. Mirrors tools-background.test.ts's own bash_kill test — gated on sandboxAvailable
// since it spawns a real sandbox-exec process, same precedent as every other bg-registry test here.
// -------------------------------------------------------------------------------------------
const d = sandboxAvailable() ? describe : describe.skip;
d("task_stop tool: bash-task path (4h-ii-c Task 2)", () => {
  function bgTaskSetup() {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-taskstop-bgtool-")));
    const bgRegistry = new BackgroundTaskRegistry({ emit: () => {}, spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_tstop") }), killGraceMs: 300 });
    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgRegistry });
    return { r, cwd, bgRegistry };
  }

  test("(d) task_stop kills a running background bash task — 'killed <taskId>' wording, mirrors bash_kill", async () => {
    const { r, cwd, bgRegistry } = bgTaskSetup();
    const taskId = bgRegistry.start("s1", "sleep 30");
    await sleep(200);

    const out = await r.execute("task_stop", { task_id: taskId }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(out).toMatchObject({ isError: false, output: `killed ${taskId}` });

    await sleep(600);
    const status = bgRegistry.read("s1", taskId).status;
    expect(status).toBe("killed");
  });

  test("resolution order: bgAgents wins over bgRegistry when BOTH match the same id — the bash task is left untouched", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-taskstop-bgtool2-")));
    const bgRegistry = new BackgroundTaskRegistry({ emit: () => {}, spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_tstop2") }), killGraceMs: 300 });
    const taskId = bgRegistry.start("s1", "sleep 30");
    await sleep(200);

    // A bg AGENT registered under the EXACT SAME id as the bash task above — an adversarial
    // collision that should never happen in practice (agentIds are th_+uuid, taskIds are
    // bg_+hex), but proves resolution order is bgAgents-first, not "whichever matches".
    const bgAgents = new BackgroundAgentRegistry();
    const abort = new AbortController();
    bgAgents.register({ agentId: taskId, sessionId: "s1", threadId: taskId, abort });

    const r = new ToolRegistry();
    registerTaskStopTool(r, { bgAgents, bgRegistry });
    const out = await r.execute("task_stop", { task_id: taskId }, { cwd, roots: [cwd], sessionId: "s1" });

    // the AGENT path fired (stop wording, abort fired, entry stopped) — not the bash-kill path
    expect(out).toMatchObject({ isError: false, output: `stopped agent '${taskId}'` });
    expect(abort.signal.aborted).toBe(true);
    expect(bgAgents.get(taskId, "s1")?.status).toBe("stopped");

    // the bash task itself was NEVER touched — still running
    expect(bgRegistry.read("s1", taskId).status).toBe("running");
    await bgRegistry.kill("s1", taskId); // cleanup
  });
});

// -------------------------------------------------------------------------------------------
// Engine E2E tests: (a) the full stop→abort→thread_completed→settle lifecycle for a DETACHED
// bg agent, and (f) task_stop's exclusion from a depth-1 child's tool set.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: task_stop E2E (4h-ii-c Task 2)", () => {
  // (a) The load-bearing test: bg-spawn a child PARKED in its provider (never finishes on its
  // own — it only ends when its combined AbortSignal fires), task_stop it from the main thread,
  // and verify the full lifecycle: tool_result, registry status, thread_completed(aborted), the
  // status STAYING "stopped" after the detached chain's late complete() (already-guaranteed
  // no-op), and NO task_notification ever persisted for it (bg-retrigger Task 1: task_stop set
  // notified in-turn, so the settle-time takeForNotification claim returns undefined).
  test("(a) task_stop aborts a parked bg child; status stays 'stopped' after settling; no task_notification is persisted", async () => {
    class ParkedChildProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound = 0;
      private resolveChildStarted!: () => void;
      readonly childStarted = new Promise<void>((r) => { this.resolveChildStarted = r; });
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "child-task")) {
          // The child's ONLY round: signal we've started (so the main thread's round 1 can wait
          // for us to be parked before calling task_stop), then park until our combined
          // AbortSignal (childSignal + entryAbort.signal) fires — task_stop's stop() is the only
          // thing that can ever end this. No fixed sleep — the abort listener is registered
          // synchronously before this generator yields control at the `await`.
          this.resolveChildStarted();
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) { resolve(); return; }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield done("aborted");
          return;
        }
        const n = this.mainRound++;
        if (n === 0) {
          yield { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", name: "worker", run_in_background: true }) };
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          await this.childStarted; // deterministic: the child is definitely parked by now
          yield { type: "tool_call", callId: "t1", name: "task_stop", argsJson: JSON.stringify({ task_id: "worker" }) };
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent done" };
        yield done("end_turn");
      }
    }

    const provider = new ParkedChildProvider();
    const { engine, store, sessionId, bgAgents, registry } = setup([], { provider });
    registerTaskStopTool(registry, { bgAgents });

    await engine.runTurn(sessionId); // turn 1: spawn bg child (parks) → task_stop it → wrap up

    // task_stop's tool_result, set synchronously in-turn
    const events1 = store.read(sessionId);
    const stopResult = toolResult(events1, "t1");
    expect(stopResult).toMatchObject({ isError: false, output: "stopped agent 'worker'" });

    const worker = bgAgents.get("worker", sessionId)!;
    expect(worker.status).toBe("stopped");
    expect(worker.notified).toBe(true);
    const childId = worker.agentId;

    // The detached chain settles asynchronously — poll for thread_completed(aborted) rather than
    // a fixed sleep (mirrors every other detached-completion test in this codebase).
    let completedEvt: Extract<SessionEvent, { type: "thread_completed" }> | undefined;
    for (let i = 0; i < 400; i++) {
      completedEvt = store.read(sessionId).find(
        (e): e is Extract<SessionEvent, { type: "thread_completed" }> => e.type === "thread_completed" && e.threadId === childId,
      );
      if (completedEvt) break;
      await sleep(5);
    }
    expect(completedEvt).toMatchObject({ stopReason: "aborted" });

    // No further child events after thread_completed (no extra rounds/tool_calls/assistant_message
    // for the child thread — it ended in exactly one round).
    const afterSettle = store.read(sessionId);
    const childAssistantMsgs = afterSettle.filter((e) => e.type === "assistant_message" && e.threadId === childId);
    expect(childAssistantMsgs.length).toBe(0);
    const childCompletions = afterSettle.filter((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(childCompletions.length).toBe(1); // exactly once — the detached chain's own .then fired once

    // THE race-guard assertion: the detached chain's OWN complete() call (fired in the .then
    // handler above, right alongside thread_completed) must NOT have clobbered "stopped" — it's
    // already-guaranteed to no-op on a non-running entry (bg-agent-registry.ts's complete()).
    expect(bgAgents.get("worker", sessionId)?.status).toBe("stopped");
    expect(bgAgents.get("worker", sessionId)?.result).toBeUndefined(); // stop() never sets a result; complete() no-op left it unset

    // bg-retrigger Task 1: the detached chain's settle-time notifyBgCompletion must NOT have
    // persisted a task_notification for this agent — task_stop set notified in-turn (the caller
    // got the stop's tool_result directly), so takeForNotification's claim returned undefined.
    expect(afterSettle.some((e) => e.type === "task_notification")).toBe(false);

    // Next turn: nothing about this agent rides the input either (no persisted event to replay).
    const baseline = provider.requests.length;
    await engine.runTurn(sessionId); // turn 2
    const turn2Requests = provider.requests.slice(baseline);
    const notified = turn2Requests.find((r) =>
      r.input.some((it) => "content" in it && typeof it.content === "string" && it.content.includes("<task-notification>")));
    expect(notified).toBeUndefined();
  });

  // PIN coverage: daemon.ts registers task_stop `deferred: true` (mirrors bash_kill) — in
  // production, the engine's per-round pin (engine.ts:~347/352) is the ONLY thing that makes it
  // visible while a bg agent is running, short of an explicit ToolSearch load. Exercises the
  // `this.cfg.bgAgents?.list(sessionId).some(e => e.status === "running")` pin directly — distinct
  // from (a)/(f), which both run with toolSearch off (deferred:true is inert there).
  test("(pin) task_stop is pinned into specs while a bg agent is running; the pin releases once it's no longer running", async () => {
    const provider = new FakeProvider([text("turn1 ok"), text("turn2 ok")]);
    const { engine, sessionId, bgAgents, registry } = setup([], { provider, toolSearch: { deferThreshold: 12 } });
    registerTaskStopTool(registry, { bgAgents, deferred: true });

    const abort = new AbortController();
    bgAgents.register({ agentId: "th_pin1", sessionId, threadId: "th_pin1", abort });
    expect(bgAgents.get("th_pin1", sessionId)?.status).toBe("running");

    await engine.runTurn(sessionId); // turn 1: the agent is still running
    const fp = provider as FakeProvider;
    const turn1Names = fp.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(turn1Names).toContain("task_stop"); // pinned visible even though never loaded via ToolSearch

    bgAgents.stop("th_pin1"); // now terminal — the pin's condition no longer holds
    await engine.runTurn(sessionId); // turn 2
    const turn2Names = fp.requests[1]!.tools?.map((t) => t.name) ?? [];
    // If this had leaked into the STICKY loadedTools set (rather than being a per-round pin), it
    // would still be present here — this is the proof pinnedTools never touched the sticky set.
    expect(turn2Names).not.toContain("task_stop");
  });

  // (f) v1 depth-0 only: task_stop is excluded from a depth-1 child's tool set (a child must not
  // be able to kill its siblings/parent's agents) — same unconditional exclusion as send_message.
  test("(f) task_stop is excluded from a depth-1 child's tool set (v1 depth-0 only)", async () => {
    // 5a: run_in_background:false — this test's subject is tool-set filtering, not the bg
    // default; the child must run synchronously so its own provider request is deterministically
    // recorded before the assertions below run.
    const provider = new FakeProvider([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", run_in_background: false }) }, done("tool_calls")],
      text("child done"),
      text("parent done"),
    ]);
    const { engine, sessionId, bgAgents, registry } = setup([], { provider });
    registerTaskStopTool(registry, { bgAgents });

    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    const childReq = fp.requests.find((r) => isChildRun(r.input, "child-task"));
    expect(childReq).toBeDefined();
    const childTools = (childReq!.tools ?? []).map((t) => t.name);
    expect(childTools).not.toContain("task_stop");
    expect(childTools).toContain("read"); // sanity: filter is real, not an empty tool set

    const mainReq = fp.requests.find((r) => !isChildRun(r.input, "child-task"));
    expect((mainReq!.tools ?? []).map((t) => t.name)).toContain("task_stop");
  });
});
