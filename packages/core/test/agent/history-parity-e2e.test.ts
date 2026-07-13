import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { ProviderEvent } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { Compactor } from "../../src/agent/compactor";
import { setupEngine } from "./engine-steer.test";
import { setup } from "./engine-spawn.test";

// history-parity Task 4: end-to-end integration tests proving the spec's Testing section holds
// across the WHOLE stack (historyInput's shared eventToInput mapper — Task 1 — composed with
// reasoning-item capture/persist/replay — Task 3 — and the compactor clamp that protects both
// tool pairs and reasoning spans — Task 3 review), plus the security no-log-sink assertion.
// Harness patterns mirror engine-history.test.ts (exact-array toEqual on provider.requests[n].input),
// engine-resume.test.ts (bg-spawn + resume harness), and compactor.test.ts (tiny keepTail forcing).

const M = (role: "user" | "assistant", content: string) => ({ type: "message" as const, role, content });
const FC = (callId: string, name: string, argsJson: string) => ({ type: "function_call" as const, callId, name, argsJson });
const TR = (callId: string, output: string, isError: boolean) => ({ type: "tool_result" as const, callId, output, isError });
const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const recJson = (ec: string) => JSON.stringify({ type: "reasoning", summary: [], encrypted_content: ec });
const RI = (ec: string): ProviderEvent => ({ type: "reasoning_item", itemJson: recJson(ec) });
const REAS = (ec: string) => ({ type: "reasoning" as const, itemJson: recJson(ec) });

describe("history-parity e2e (Task 4)", () => {
  // (a) FULL LOOP: turn 1 as two rounds — round 0: reasoning then a tool call; round 1: reasoning
  // then final text. turn 2: a plain question. Asserts turn 2's REQUEST input as one exact array,
  // proving tool replay (Task 1) and reasoning replay (Task 3) compose in the same historyInput
  // pass without reordering/dropping either.
  test("(a) full loop: reasoning+tool_call, reasoning+final, then a plain turn — turn 2 replays everything in emission order", async () => {
    const writeArgs = JSON.stringify({ path: "out.txt", content: "hi" });
    const provider = new FakeProvider([
      // turn 1, round 0: reasoning THEN a tool call
      [RI("EC1"), { type: "tool_call", callId: "c1", name: "write", argsJson: writeArgs }, done("tool_calls")],
      // turn 1, round 1: reasoning THEN the final assistant text
      [RI("EC2"), { type: "text_delta", delta: "a1" }, done("end_turn")],
      // turn 2, round 0: a plain question, answered immediately
      [{ type: "text_delta", delta: "a2" }, done("end_turn")],
    ]);
    const { engine, store, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    await engine.runTurn(sessionId); // turn 1
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });
    await engine.runTurn(sessionId); // turn 2

    // tool_result text isn't load-bearing here — pull it verbatim from the store, same as
    // engine-history.test.ts's own reasoning test does.
    const events = store.read(sessionId);
    const trEvent = events.find((e) => e.type === "tool_result" && e.callId === "c1") as Extract<SessionEvent, { type: "tool_result" }>;
    const TRc1 = TR("c1", trEvent.output, trEvent.isError);

    expect(provider.requests[2]!.input).toEqual([
      M("user", "u1"),
      REAS("EC1"),
      FC("c1", "write", writeArgs),
      TRc1,
      REAS("EC2"),
      M("assistant", "a1"),
      M("user", "u2"),
    ]);
  });

  // (b) COMPACTION: a checkpoint forced (tiny keepTail) over exactly turn 1 folds it entirely
  // away — no reasoning/function_call items from that turn survive — while turn 2 (post-checkpoint)
  // survives as tail with its function_call/tool_result pair intact and adjacent.
  test("(b) compaction folds turn 1 away; turn 3's input is [summary, post-checkpoint tail] with tool pairs still adjacent", async () => {
    const writeArgs1 = JSON.stringify({ path: "out1.txt", content: "hi" });
    const writeArgs2 = JSON.stringify({ path: "out2.txt", content: "yo" });
    const provider = new FakeProvider([
      // turn 1 (to be folded): reasoning+tool_call, reasoning+final
      [RI("EC1"), { type: "tool_call", callId: "c1", name: "write", argsJson: writeArgs1 }, done("tool_calls")],
      [RI("EC2"), { type: "text_delta", delta: "a1" }, done("end_turn")],
      // turn 2 (post-checkpoint, must survive): tool_call, final
      [{ type: "tool_call", callId: "c2", name: "write", argsJson: writeArgs2 }, done("tool_calls")],
      [{ type: "text_delta", delta: "a2" }, done("end_turn")],
      // turn 3: plain question, the one we inspect
      [{ type: "text_delta", delta: "a3" }, done("end_turn")],
    ]);
    const { engine, store, hub, sessionId } = setupEngine(provider);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
    await engine.runTurn(sessionId); // turn 1
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });
    await engine.runTurn(sessionId); // turn 2

    // Force a checkpoint over exactly turn 1: after turn 1+2 there are 4 main-thread messages
    // (u1,a1,u2,a2) — keepTail:2 keeps [u2,a2] as tail and folds [u1,a1], the compactor.test.ts
    // "tiny keepTail" pattern. A SEPARATE FakeProvider drives the summarizer (never consumes the
    // main provider's script slots).
    const summarizer = new FakeProvider([[{ type: "text_delta", delta: "SUMMARY_TOKEN" }, done("end_turn")]]);
    const compactor = new Compactor({ provider: { provider: summarizer, model: "fake" }, store, hub, keepTail: 2 });
    const res = await compactor.compact(sessionId);
    expect(res.compacted).toBe(true);

    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u3", clientName: "test" });
    await engine.runTurn(sessionId); // turn 3

    const events = store.read(sessionId);
    const tr2 = events.find((e) => e.type === "tool_result" && e.callId === "c2") as Extract<SessionEvent, { type: "tool_result" }>;
    const TRc2 = TR("c2", tr2.output, tr2.isError);

    const input = provider.requests[4]!.input;
    expect(input).toEqual([
      { type: "message", role: "user", content: "[Summary of earlier conversation]\nSUMMARY_TOKEN" },
      M("user", "u2"),
      FC("c2", "write", writeArgs2),
      TRc2,
      M("assistant", "a2"),
      M("user", "u3"),
    ]);

    // zero reasoning/function_call items survive from the folded turn 1
    expect(input.some((it) => (it as { type: string }).type === "reasoning")).toBe(false);
    expect(input.some((it) => (it as { type: string; callId?: string }).callId === "c1")).toBe(false);

    // every remaining function_call is still immediately followed by its matching tool_result
    for (let i = 0; i < input.length; i++) {
      const it = input[i] as { type: string; callId?: string };
      if (it.type === "function_call") {
        const next = input[i + 1] as { type: string; callId?: string } | undefined;
        expect(next?.type).toBe("tool_result");
        expect(next?.callId).toBe(it.callId);
      }
    }
  });

  // (c) RESUME: a bg-spawned child whose first run emits reasoning -> tool_call -> result -> final;
  // resuming it must replay the child's reasoning item BEFORE its function_call, in emission order,
  // via childHistoryInput — extending engine-resume.test.ts's 4h-ii-b resume harness to a child that
  // also used a tool (the (d) test there only covered reasoning+text, no tool call).
  test("(c) resume: a bg-spawned child's reasoning->tool_call->result->final replays in order on resume, reasoning before its function_call", async () => {
    // 5a: run_in_background:false — depth 0 now backgrounds by default; this test needs the child
    // to finish synchronously in turn 1 so it's a FINISHED, resumable agent by turn 2 (its own
    // reasoning/tool-call replay ordering on resume is the actual subject, not the bg default).
    const spawnNamed = (callId: string, prompt: string, name: string): ProviderEvent =>
      ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "task", name, run_in_background: false }) });
    // 5a: run_in_background:false — a resume is itself a spawn and follows the same depth-0
    // default; this test inspects the resumed run's own provider request synchronously (no poll
    // loop), so it needs the resume pinned to the synchronous path.
    const resumeCall = (callId: string, resume: string, prompt: string): ProviderEvent =>
      ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ resume, prompt, run_in_background: false }) });
    const isChildRun = (input: readonly unknown[], opening: string): boolean => {
      const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
      return first?.type === "message" && first.role === "user" && first.content === opening;
    };
    const lastUserOf = (input: readonly unknown[]): string | undefined => {
      for (let i = input.length - 1; i >= 0; i--) {
        const it = input[i] as { type?: string; role?: string; content?: unknown };
        if (it?.type === "message" && it.role === "user") return typeof it.content === "string" ? it.content : undefined;
      }
      return undefined;
    };

    const { engine, store, sessionId, provider } = setup([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1 round 0: spawn
      // child run 1, round 0: reasoning THEN a tool call
      [RI("ECchild"), { type: "tool_call", callId: "ct1", name: "read", argsJson: '{"path":"a.txt"}' }, done("tool_calls")],
      // child run 1, round 1: final reply (after its own tool_result)
      text("child-out-1"),
      text("parent turn1"), // main turn 1 continuation
      [resumeCall("r1", "worker", "now do Y"), done("tool_calls")], // turn 2 round 0: resume
      text("child-out-2"), // resumed child run
      text("parent turn2"), // main turn 2 continuation
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn "worker" (child reasons, calls a tool, replies)
    await engine.runTurn(sessionId); // turn 2: resume "worker" with "now do Y"

    const fp = provider as FakeProvider;
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "now do Y");
    expect(resumed).toBeDefined();

    const events = store.read(sessionId);
    const trEvent = events.find((e) => e.type === "tool_result" && e.callId === "ct1") as Extract<SessionEvent, { type: "tool_result" }>;
    const TRct1 = TR("ct1", trEvent.output, trEvent.isError);

    expect(resumed!.input).toEqual([
      M("user", "do the task"),               // opening prompt, prepended
      REAS("ECchild"),                        // the child's reasoning item, replayed from the store
      FC("ct1", "read", '{"path":"a.txt"}'),  // the child's own tool call
      TRct1,                                  // its tool_result, verbatim
      M("assistant", "child-out-1"),          // the child's OWN prior reply
      M("user", "now do Y"),                  // the new instruction
    ]);

    // explicit ordering invariant per the brief: the reasoning item precedes its function_call.
    const reasIdx = resumed!.input.findIndex((it) => (it as { type: string }).type === "reasoning");
    const fcIdx = resumed!.input.findIndex((it) => (it as { type: string }).type === "function_call");
    expect(reasIdx).toBeGreaterThanOrEqual(0);
    expect(fcIdx).toBeGreaterThan(reasIdx);
  });

  // (d) SECURITY: itemJson is sensitive opaque state (spec: "never log it"). A reasoning item
  // carrying a sentinel must never surface through any console sink during a turn that persists
  // it — the session JSONL append is its ONLY sink.
  test("(d) security: a reasoning item's itemJson is never printed by console.log/error/warn; the session JSONL is its only sink", async () => {
    const sentinel = "REDACT-ME-9f3";
    const ecJson = JSON.stringify({ type: "reasoning", summary: [], encrypted_content: sentinel });
    const provider = new FakeProvider([
      [{ type: "reasoning_item", itemJson: ecJson }, { type: "text_delta", delta: "ok" }, done("end_turn")],
    ]);
    const { engine, store, sessionId } = setupEngine(provider);
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await engine.runTurn(sessionId);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }

    const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls];
    for (const call of allCalls) {
      const serialized = call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      expect(serialized).not.toContain(sentinel);
    }

    // the reasoning item DID persist (this append is its only sink) — the sentinel is on disk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const home = (store as any).homeDir as string;
    const jsonlPath = join(home, "sessions", "global", `${sessionId}.jsonl`);
    const raw = readFileSync(jsonlPath, "utf8");
    expect(raw).toContain(sentinel);
  });
});
