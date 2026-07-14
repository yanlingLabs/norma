import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { SessionEvent } from "@norma/protocol";
import type { ProviderEvent } from "../../src/providers/types";
import { setup } from "./engine-spawn.test";
import { registerAgentQueryTools } from "../../src/agent/tools/agent-query";
import { ToolRegistry } from "../../src/agent/tools/registry";

// CC-parity subagent transcript surfacing, END TO END: emit-hook wiring (child events land in the
// per-agent file, main-thread events never do), the path surfaced on every CC-analogous channel
// (bg spawn tool_result, task_notification, the sync trailer, agent_output), and the
// reasoning_item exclusion holding even when a REAL engine turn produces one. Unit-level coverage
// for the writer module itself lives in subagent-transcript.test.ts; this file is engine wiring.

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const spawnCall = (callId: string, prompt: string, extra?: Record<string, unknown>): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "test task", run_in_background: false, ...extra }) });

function linesOf(path: string): unknown[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("subagent transcript surfacing — engine wiring (e2e)", () => {
  test("no transcript file at all when tmpDirOf is unwired (default setup())", async () => {
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child final report"),
      text("parent wrap-up"),
    ]);
    await engine.runTurn(sessionId);
    const childId = (store.read(sessionId).find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(engine.transcriptPathFor(sessionId, childId)).toBeUndefined();
  });

  test("a child thread's events land in its own transcript file; the file opens with a synthetic spawn_prompt line", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "investigate the bug", { agentType: "code-reviewer" }), done("tool_calls")],
        [{ type: "tool_call", callId: "c1", name: "read", argsJson: JSON.stringify({ path: "x.txt" }) }, done("tool_calls")],
        text("child final report"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true },
    );
    await engine.runTurn(sessionId);
    const childId = (store.read(sessionId).find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;

    const path = engine.transcriptPathFor(sessionId, childId)!;
    expect(path).toBeDefined();
    expect(existsSync(path)).toBe(true);

    const lines = linesOf(path) as Array<{ type: string; threadId?: string; [k: string]: unknown }>;
    expect(lines[0]).toMatchObject({ type: "spawn_prompt", agentType: "code-reviewer", prompt: "investigate the bug" });
    expect(lines[1]).toMatchObject({ type: "thread_started", threadId: childId });
    // the child's own tool_call/tool_result/assistant_message/thread_completed all land, all
    // scoped to the CHILD's threadId (never main's)
    const types = lines.slice(1).map((l) => l.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("assistant_message");
    expect(types).toContain("thread_completed");
    expect(lines.every((l) => l.type === "spawn_prompt" || l.threadId === childId)).toBe(true);
  });

  test("MAIN-thread events never land in any subagent transcript file", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        text("child final report"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const path = engine.transcriptPathFor(sessionId, childId)!;
    const raw = readFileSync(path, "utf8");

    // the PARENT's own spawn_agent tool_call/tool_result (main-thread events, callId "s1") must
    // never appear in the CHILD's transcript file
    expect(raw).not.toContain(`"callId":"s1"`);
    expect(raw).not.toContain("parent wrap-up");
    // sanity: a second, sibling thread never gets a file at all (nothing was ever spawned under it)
    expect(engine.transcriptPathFor(sessionId, "main")).toBeDefined(); // pathFor is pure — always computable
    expect(existsSync(engine.transcriptPathFor(sessionId, "main")!)).toBe(false); // but no file was ever WRITTEN for main
  });

  test("a reasoning_item the child emits mid-run is excluded from its transcript file end-to-end", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        [{ type: "reasoning_item", itemJson: "TOP-SECRET-encrypted-content" }, { type: "text_delta", delta: "child final report" }, done("end_turn")],
        text("parent wrap-up"),
      ],
      { withTranscripts: true },
    );
    await engine.runTurn(sessionId);
    const childId = (store.read(sessionId).find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const raw = readFileSync(engine.transcriptPathFor(sessionId, childId)!, "utf8");
    expect(raw).not.toContain("TOP-SECRET-encrypted-content");
    expect(raw).not.toContain("reasoning_item");
    // the reasoning_item WAS persisted to the session store itself (untouched by this feature) —
    // only the transcript FILE excludes it
    expect(store.read(sessionId).some((e) => e.type === "reasoning_item" && e.threadId === childId)).toBe(true);
  });

  test("bg spawn tool_result carries outputFile pointing at the real, already-written transcript file", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "bg task", { run_in_background: true }), done("tool_calls")],
        text("bg child done"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const bgResult = events.find((e) => e.type === "tool_result" && e.callId === "s1") as Extract<SessionEvent, { type: "tool_result" }>;
    const parsed = JSON.parse(bgResult.output) as { agentId: string; status: string; outputFile?: string };
    expect(parsed.status).toBe("running");
    expect(parsed.outputFile).toBeDefined();
    expect(existsSync(parsed.outputFile!)).toBe(true);
    expect(parsed.outputFile).toBe(engine.transcriptPathFor(sessionId, parsed.agentId));
  });

  test("task_notification content carries an <output-file> element pointing at the transcript", async () => {
    const { engine, store, sessionId, bgAgents } = setup(
      [
        [spawnCall("s1", "bg task", { run_in_background: true, name: "worker" }), done("tool_calls")],
        text("bg child done"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true },
    );
    await engine.runTurn(sessionId);
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const notes = store.read(sessionId).filter((e) => e.type === "task_notification") as Extract<SessionEvent, { type: "task_notification" }>[];
    expect(notes).toHaveLength(1);
    const worker = bgAgents.get("worker", sessionId)!;
    const path = engine.transcriptPathFor(sessionId, worker.threadId)!;
    expect(notes[0]!.content).toContain(`<output-file>${path}</output-file>`);
  });

  test("a successful SYNC spawn result ends with the agentId trailer including the transcript path", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        text("child final report"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1") as Extract<SessionEvent, { type: "tool_result" }>;
    const path = engine.transcriptPathFor(sessionId, childId)!;
    expect(result.output).toBe(
      `child final report\n\nagentId: ${childId} (transcript: ${path} — read/glob/grep it surgically for details; send_message with to: '${childId}' to continue this agent)`,
    );
  });

  test("agent_output shows the transcript path for both a RUNNING and a FINISHED agent", async () => {
    const registry = new ToolRegistry();
    const { engine, sessionId, bgAgents, store } = setup(
      [
        [spawnCall("s1", "bg task", { run_in_background: true, name: "worker" }), done("tool_calls")],
        text("bg child done"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true, registry },
    );
    registerAgentQueryTools(registry, {
      bgAgents,
      store,
      transcriptPathFor: (sid, tid) => engine.transcriptPathFor(sid, tid),
    });
    await engine.runTurn(sessionId);

    const worker = bgAgents.get("worker", sessionId)!;
    const path = engine.transcriptPathFor(sessionId, worker.threadId)!;

    // still running (or racing to finish) — either way, agent_output must show the transcript line
    const runningOut = await registry.execute("agent_output", { agent: "worker" }, { cwd: "/tmp", roots: ["/tmp"], sessionId });
    expect(runningOut.output).toContain(`transcript: ${path}`);

    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const finishedOut = await registry.execute("agent_output", { agent: "worker" }, { cwd: "/tmp", roots: ["/tmp"], sessionId });
    expect(finishedOut.output).toContain(`transcript: ${path}`);
  });

  // task-9 review, Minor 2: a SYNC-completed agent's stored result already carries the engine's
  // syncTrailer (whose own `transcript: <path>` clause names the file) — agent_output must not
  // append a SECOND mention of the same path on top of it.
  test("agent_output on a SYNC-completed agent shows exactly ONE transcript mention (trailer already carries it)", async () => {
    const registry = new ToolRegistry();
    const { engine, sessionId, bgAgents, store } = setup(
      [
        [spawnCall("s1", "sync task", { run_in_background: false, name: "worker" }), done("tool_calls")],
        text("sync child done"),
        text("parent wrap-up"),
      ],
      { withTranscripts: true, registry },
    );
    registerAgentQueryTools(registry, {
      bgAgents,
      store,
      transcriptPathFor: (sid, tid) => engine.transcriptPathFor(sid, tid),
    });
    await engine.runTurn(sessionId); // sync spawn — completes in-turn, result stored WITH the trailer

    const worker = bgAgents.get("worker", sessionId)!;
    expect(worker.status).toBe("completed");
    expect(worker.result).toContain("transcript:"); // precondition: the stored result carries the trailer

    const out = await registry.execute("agent_output", { agent: "worker" }, { cwd: "/tmp", roots: ["/tmp"], sessionId });
    expect(out.isError).toBe(false);
    const mentions = out.output.split("transcript:").length - 1;
    expect(mentions).toBe(1); // the trailer's own mention — no duplicate appended line
  });
});
