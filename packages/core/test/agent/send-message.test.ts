import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@norma/protocol";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSendMessageTool } from "../../src/agent/tools/send-message";
import { setup } from "./engine-spawn.test";

// 4h-ii-b Task 4: send_message (CC's SendMessage) — message a RUNNING subagent (delivered at its
// next step, thread-scoped steer) or reach a FINISHED one (resumes it in the background). This is
// an ENGINE BRIDGE, mirroring the spawn_agent bridge; send-message.ts holds only the tool DEF.

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
// A fresh spawn with a stable `name` so a later turn can address it (the model can't know the
// generated agentId; `name` is the stable handle).
const spawnNamed = (callId: string, prompt: string, name: string, extra?: Record<string, unknown>): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "task", name, ...extra }) });
const sendMessage = (callId: string, to: string, message: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "send_message", argsJson: JSON.stringify({ to, message }) });

const M = (role: "user" | "assistant", content: string): { type: "message"; role: "user" | "assistant"; content: string } =>
  ({ type: "message", role, content });
const lastUserOf = (input: readonly unknown[]): string | undefined => {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i] as { type?: string; role?: string; content?: unknown };
    if (it?.type === "message" && it.role === "user") return typeof it.content === "string" ? it.content : undefined;
  }
  return undefined;
};
const isChildRun = (input: readonly unknown[], opening: string): boolean => {
  const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
  return first?.type === "message" && first.role === "user" && first.content === opening;
};
const hasUserMsg = (input: readonly unknown[], content: string): boolean =>
  input.some((it) => {
    const m = it as { type?: string; role?: string; content?: unknown };
    return m.type === "message" && m.role === "user" && m.content === content;
  });
const toolResult = (events: readonly SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined =>
  events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;

// A registry pre-loaded with send_message; setup() adds the standard tool set (read/write/spawn/…)
// on top. send_message must be registered for test (d)'s child-exclusion assertion (the child's
// tool set = specs() minus excludeTools — send_message has to be IN specs() to prove it's filtered).
function setupSend(script: ProviderEvent[][], opts: Parameters<typeof setup>[1] = {}) {
  const registry = new ToolRegistry();
  registerSendMessageTool(registry);
  return setup(script, { ...opts, registry });
}

describe("AgentEngine: send_message (4h-ii-b Task 4 — CC SendMessage parity)", () => {
  // (a) SM2/SM3: a RUNNING child receives the message at its NEXT round. The child is spawned
  // run_in_background so the parent isn't blocked; between the child's rounds, the MAIN thread
  // calls send_message. Content-dispatched provider (timing between a detached child and the
  // parent is non-deterministic under index-scripting): the child parks after round 0 until the
  // test releases it, and the parent only sends AFTER the child's round-0 (empty) top-drain has
  // run — so the message deterministically lands in the child's round-1 drain.
  test("(a) a RUNNING child receives a send_message at its next round (thread-scoped steer)", async () => {
    class RunningChildProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound = 0;
      private resolveChildStarted!: () => void;
      readonly childStarted = new Promise<void>((r) => { this.resolveChildStarted = r; });
      private resolveMsgDelivered!: () => void;
      readonly msgDelivered = new Promise<void>((r) => { this.resolveMsgDelivered = r; });
      releaseChild() { this.resolveMsgDelivered(); }
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "child-task")) {
          if (hasUserMsg(input, "INJECT-MSG")) {
            // round 1: the injected message was drained in — finish so the child becomes terminal
            yield { type: "text_delta", delta: "child saw the message" };
            yield done("end_turn");
            return;
          }
          // round 0: its top-drain already ran (empty). Signal we've started, emit a loop-trigger
          // tool_call so there IS a round 1, then PARK until the test releases us.
          this.resolveChildStarted();
          yield { type: "tool_call", callId: "child-read", name: "read", argsJson: JSON.stringify({ path: "nope.txt" }) };
          yield done("tool_calls");
          await this.msgDelivered;
          return;
        }
        // MAIN thread
        const n = this.mainRound++;
        if (n === 0) {
          yield { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", name: "worker", run_in_background: true }) };
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          // wait until the child's round 0 has begun (its empty top-drain ran) so the message
          // deterministically lands in the child's NEXT round's drain, not round 0
          await this.childStarted;
          yield sendMessage("m1", "worker", "INJECT-MSG");
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent done" };
        yield done("end_turn");
      }
    }
    const provider = new RunningChildProvider();
    const { engine, store, sessionId, bgAgents } = setupSend([], { provider });
    await engine.runTurn(sessionId); // parent turn: spawn bg child → send_message → finish

    // the send_message tool_result is emitted synchronously in-turn: delivered, not an error
    const smResult = toolResult(store.read(sessionId), "m1");
    expect(smResult).toMatchObject({ isError: false });
    expect(smResult!.output).toBe("message delivered to 'worker'");

    // release the parked child; poll for its next round + terminal completion to settle
    provider.releaseChild();
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // the child's next-round provider request carried the injected user message
    const injected = provider.requests.find((r) => isChildRun(r.input, "child-task") && hasUserMsg(r.input, "INJECT-MSG"));
    expect(injected).toBeDefined();

    // SM3 cleanup: the child's steer queue entry is DELETED at its terminal exit — a drained queue
    // leaves an empty array under the key; cleanup removes the key entirely, so a later resume of
    // this SAME threadId can't drain a stale message. `has() === false` distinguishes the two.
    const worker = bgAgents.get("worker", sessionId)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).threadSteerQueue.has(worker.threadId)).toBe(false);
  });

  // (b) SM4: a FINISHED (terminal) child is RESUMED in the BACKGROUND when messaged — the resume
  // path (T3) reused verbatim. The tool_result is {agentId,status:"running"} immediately (never
  // blocks the parent) and the thread re-runs with [prior history + the message].
  test("(b) a FINISHED child is resumed in the background, re-running with history + the message", async () => {
    const { engine, store, sessionId, provider, bgAgents } = setupSend([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn → completes clean
      text("child-out-1"),                                             // child run 1 (ends on assistant → resumable)
      text("parent turn1"),
      [sendMessage("m1", "worker", "now do Y"), done("tool_calls")],    // turn 2: message the finished child
      text("child-out-2"),                                             // resumed (detached) child run
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn worker (sync) → completes + registers
    await engine.runTurn(sessionId); // turn 2: send_message → background resume

    const worker = bgAgents.get("worker", sessionId)!;
    // the tool_result is set SYNCHRONOUSLY in-turn (the bg resume returns immediately)
    const result = toolResult(store.read(sessionId), "m1");
    expect(result).toMatchObject({ isError: false });
    expect(result!.output).toBe(JSON.stringify({ agentId: worker.threadId, status: "running" }));

    // POLL for the detached resumed run to settle (no fixed sleep)
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // the detached resumed run re-completed the entry and (unlike a sync path) left it UN-notified
    // so the next turn's completion reminder can surface it (CC parity)
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed", notified: false });

    // the resume re-ran the SAME thread with [opening + prior reply + the message]
    const fp = provider as FakeProvider;
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "now do Y");
    expect(resumed).toBeDefined();
    expect(resumed!.input).toEqual([
      M("user", "do the task"),      // opening prompt, prepended
      M("assistant", "child-out-1"), // the child's OWN prior reply, reconstructed from the store
      M("user", "now do Y"),         // the message, persisted then picked up last
    ]);
  });

  // (c) SM4: an unknown `to` → typed isError, no side effect (no thread started, child never ran).
  test("(c) send_message to an unknown agent → typed isError, no side effect", async () => {
    const { engine, store, sessionId, provider } = setupSend([
      [sendMessage("m1", "ghost", "hello?"), done("tool_calls")],
      text("parent saw the error"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = toolResult(events, "m1");
    expect(result).toMatchObject({ isError: true });
    expect(result!.output).toBe("no agent 'ghost' to message");
    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect((provider as FakeProvider).requests.length).toBe(2); // only the parent's two rounds
  });

  // (d) SM6: send_message is DEPTH-0 only — excluded from every child thread's tool set (v1 has no
  // agent-to-agent messaging). A depth-1 child's specs()-derived tool set (after excludeTools
  // filtering) does NOT contain send_message, while the MAIN thread's DOES.
  test("(d) send_message is excluded from a child thread's tool set (depth-0 only)", async () => {
    const { engine, sessionId, provider } = setupSend([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task" }) }, done("tool_calls")],
      text("child done"),
      text("parent done"),
    ]);
    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    const childReq = fp.requests.find((r) => isChildRun(r.input, "child-task"));
    expect(childReq).toBeDefined();
    const childTools = (childReq!.tools ?? []).map((t) => t.name);
    expect(childTools).not.toContain("send_message");
    // sanity: the filter is real, not an empty tool set — read is present, spawn_agent too (depth < cap)
    expect(childTools).toContain("read");
    expect(childTools).toContain("spawn_agent");

    // and send_message IS available to the MAIN thread (registered + main-only)
    const mainReq = fp.requests.find((r) => !isChildRun(r.input, "child-task"));
    expect((mainReq!.tools ?? []).map((t) => t.name)).toContain("send_message");
  });

  // Invalid arguments (defensive hand-parse, same shape as the spawn bridge): a missing/non-string
  // `to` or `message` → typed isError, never a throw.
  test("(e) missing `to` / `message` → typed isError with the field name", async () => {
    const { engine, store, sessionId } = setupSend([
      [{ type: "tool_call", callId: "m1", name: "send_message", argsJson: JSON.stringify({ message: "hi" }) }, done("tool_calls")],
      text("parent turn1"),
    ]);
    await engine.runTurn(sessionId);
    const r1 = toolResult(store.read(sessionId), "m1");
    expect(r1).toMatchObject({ isError: true });
    expect(r1!.output).toBe("invalid arguments for send_message: to");

    const { engine: e2, store: s2, sessionId: sid2 } = setupSend([
      [{ type: "tool_call", callId: "m2", name: "send_message", argsJson: JSON.stringify({ to: "worker" }) }, done("tool_calls")],
      text("parent turn1"),
    ]);
    await e2.runTurn(sid2);
    const r2 = toolResult(s2.read(sid2), "m2");
    expect(r2).toMatchObject({ isError: true });
    expect(r2!.output).toBe("invalid arguments for send_message: message");
  });

  // (f) SM3 continue-on-pending: a message that lands as the child finishes its FINAL round must
  // NOT be silently dropped. Distinct from (a): the child's round 0 ends on `end_turn` with NO
  // tool_call, so it takes the round-END branch (not the SM2 round-top drain (a) exercises). The
  // generalized continue-on-pending then sees the pending message → continues → round 1 drains it.
  test("(f) a message landing as the child finishes its final round → it continues and drains it (not dropped)", async () => {
    class FinalRoundProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound = 0;
      private resolveChildStarted!: () => void;
      readonly childStarted = new Promise<void>((r) => { this.resolveChildStarted = r; });
      private resolveMsgDelivered!: () => void;
      readonly msgDelivered = new Promise<void>((r) => { this.resolveMsgDelivered = r; });
      releaseChild() { this.resolveMsgDelivered(); }
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "child-task")) {
          if (hasUserMsg(input, "INJECT-MSG")) {
            // round 1: the pending message was drained after the continue — finish
            yield { type: "text_delta", delta: "child drained the final-round message" };
            yield done("end_turn");
            return;
          }
          // round 0: end on end_turn with NO tool_call → takes the round-END branch. Park until the
          // message is delivered so the end-of-round pending check sees it and CONTINUES (rather
          // than terminating and dropping it).
          this.resolveChildStarted();
          yield done("end_turn");
          await this.msgDelivered;
          return;
        }
        const n = this.mainRound++;
        if (n === 0) {
          yield { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", name: "worker", run_in_background: true }) };
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          await this.childStarted;
          yield sendMessage("m1", "worker", "INJECT-MSG");
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent done" };
        yield done("end_turn");
      }
    }
    const provider = new FinalRoundProvider();
    const { engine, store, sessionId, bgAgents } = setupSend([], { provider });
    await engine.runTurn(sessionId);

    expect(toolResult(store.read(sessionId), "m1")!.output).toBe("message delivered to 'worker'");

    provider.releaseChild();
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // the child ran a SECOND round that drained the final-round message (continue-on-pending fired)
    const drained = provider.requests.find((r) => isChildRun(r.input, "child-task") && hasUserMsg(r.input, "INJECT-MSG"));
    expect(drained).toBeDefined();
    // and it settled cleanly (the message wasn't left orphaned in the queue)
    const worker = bgAgents.get("worker", sessionId)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).threadSteerQueue.has(worker.threadId)).toBe(false);
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed" });
  });
});
