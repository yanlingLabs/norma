import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { DispatchChildren } from "../../src/agent/dispatch-children";

// Task 5: DispatchChildren's registry surface — derived status, completion wake (with coalescing),
// the roster reminder, and stopChild. A REAL SessionStore+SessionHub (temp NORMA_HOME) drives
// events through the actual append/observer path; runTurn/isRunning/interrupt are FAKE recording
// stubs — this is a unit test of the registry, not an engine integration test (the engine seams
// themselves — cfg.onTurnEnd/cfg.dispatchRoster — are wired in engine.ts and exercised by whatever
// engine-level test covers dispatch mode end-to-end).
function setup() {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-children-home-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const runTurnCalls: string[] = [];
  const interruptCalls: string[] = [];
  const running = new Set<string>();
  const registry = new DispatchChildren({
    store,
    hub,
    runTurn: async (sid: string) => { runTurnCalls.push(sid); },
    isRunning: (sid: string) => running.has(sid),
    interrupt: (sid: string) => { interruptCalls.push(sid); },
  });
  const setRunning = (sid: string, v: boolean) => { if (v) running.add(sid); else running.delete(sid); };
  return { store, hub, registry, runTurnCalls, interruptCalls, setRunning };
}

function readDispatch(store: SessionStore, dispatchId: string): SessionEvent[] {
  return store.read(dispatchId, 0);
}

describe("DispatchChildren (Task 5): status derivation", () => {
  test("1) after spawnChild, statusOf(child) === 'running'", () => {
    const { store, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    expect(registry.statusOf(childId)).toBe("running");
  });

  test("2) approval_requested → awaiting_approval; approval_resolved → running", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start(); // subscribe the observer (daemon boot precedent — start() wires hub.addObserver)

    hub.append(childId, { type: "approval_requested", sessionId: childId, threadId: "main", callId: "c1", toolName: "bash", summary: "run rm" });
    expect(registry.statusOf(childId)).toBe("awaiting_approval");

    hub.append(childId, { type: "approval_resolved", sessionId: childId, threadId: "main", callId: "c1", approved: true, by: "user" });
    expect(registry.statusOf(childId)).toBe("running");
  });

  test("3) question_asked → awaiting_input; question_resolved → running", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    hub.append(childId, {
      type: "question_asked", sessionId: childId, threadId: "main", callId: "q1",
      questions: [{ question: "which?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
    });
    expect(registry.statusOf(childId)).toBe("awaiting_input");

    hub.append(childId, { type: "question_resolved", sessionId: childId, threadId: "main", callId: "q1", answers: { "which?": "A" }, by: "user" });
    expect(registry.statusOf(childId)).toBe("running");
  });
});

describe("DispatchChildren (Task 5): completion wake", () => {
  test("4) onTurnEnd(child) with dispatch idle: appends a completed child_update with resultSummary, and wakes the dispatch (runTurn called)", () => {
    const { store, hub, registry, runTurnCalls, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();
    setRunning(dispatchId, false); // dispatch idle

    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "all done here" });
    registry.onTurnEnd(childId);

    const events = readDispatch(store, dispatchId);
    const update = events.find((e) => e.type === "child_update" && e.childSessionId === childId && e.status === "completed");
    expect(update).toBeDefined();
    expect((update as { resultSummary?: string }).resultSummary).toBe("all done here");
    expect(registry.statusOf(childId)).toBe("completed");
    expect(runTurnCalls).toContain(dispatchId);
  });

  test("5) onTurnEnd(child) with dispatch busy: child_update appended but runTurn NOT called; onTurnEnd(dispatchId) later drains the coalesced wake exactly once", () => {
    const { store, hub, registry, runTurnCalls, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const child1 = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work 1", title: "Task 1" });
    const child2 = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/b", prompt: "do work 2", title: "Task 2" });
    registry.start();
    setRunning(dispatchId, true); // dispatch busy

    hub.append(child1, { type: "assistant_message", sessionId: child1, threadId: "main", text: "child1 done" });
    registry.onTurnEnd(child1);
    hub.append(child2, { type: "assistant_message", sessionId: child2, threadId: "main", text: "child2 done" });
    registry.onTurnEnd(child2); // a SECOND child finishing while still busy — coalesces into the SAME pending wake

    const events = readDispatch(store, dispatchId);
    expect(events.filter((e) => e.type === "child_update" && e.status === "completed").length).toBe(2);
    expect(runTurnCalls).not.toContain(dispatchId); // dispatch never woken while busy

    // Now the dispatch session's OWN turn ends — the coalesced wake drains, exactly once.
    registry.onTurnEnd(dispatchId);
    expect(runTurnCalls.filter((id) => id === dispatchId).length).toBe(1);

    // A further onTurnEnd(dispatchId) with nothing pending must NOT re-trigger a wake.
    registry.onTurnEnd(dispatchId);
    expect(runTurnCalls.filter((id) => id === dispatchId).length).toBe(1);
  });

  test("6) error path: last event agent_error (no assistant_message) → child_update status 'error'", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();
    setRunning(dispatchId, false);

    hub.append(childId, { type: "agent_error", sessionId: childId, threadId: "main", message: "boom" });
    registry.onTurnEnd(childId);

    const events = readDispatch(store, dispatchId);
    const update = events.findLast((e) => e.type === "child_update" && e.childSessionId === childId);
    expect(update).toMatchObject({ status: "error" });
    expect(registry.statusOf(childId)).toBe("error");
  });
});

describe("DispatchChildren (Task 5): roster", () => {
  test("7) rosterFor(dispatchId) lists child id/title/dir/status; rosterFor(codeSessionId) is undefined", () => {
    const { store, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const codeSessionId = store.createSession("global", { mode: "code" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    const roster = registry.rosterFor(dispatchId);
    expect(roster).toBeDefined();
    expect(roster).toContain(childId);
    expect(roster).toContain("Task A");
    expect(roster).toContain("/tmp/a");
    expect(roster).toContain("running");
    expect(roster).toContain("<system-reminder>");

    expect(registry.rosterFor(codeSessionId)).toBeUndefined();
  });
});

describe("DispatchChildren (Task 5): stopChild", () => {
  test("8) stopChild(dispatchId, childId) interrupts + returns a string; wrong caller or unknown id → undefined", () => {
    const { store, registry, interruptCalls } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const otherSessionId = store.createSession("global", { mode: "code" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    const result = registry.stopChild(dispatchId, childId);
    expect(typeof result).toBe("string");
    expect(interruptCalls).toContain(childId);

    expect(registry.stopChild(otherSessionId, childId)).toBeUndefined();
    expect(registry.stopChild(dispatchId, "s_nope")).toBeUndefined();
  });
});

describe("DispatchChildren (Task 5): start() restart semantics", () => {
  test("children rebuilt from the store on start() resume as 'completed' (live state is unrecoverable)", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-dispatch-children-restart-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = store.createSession("global", { mode: "code", parentSessionId: dispatchId, cwd: "/tmp/restart" });

    // Fresh registry (simulates a daemon restart — no in-memory state at all).
    const registry = new DispatchChildren({
      store, hub,
      runTurn: async () => {},
      isRunning: () => false,
      interrupt: () => {},
    });
    registry.start();

    expect(registry.statusOf(childId)).toBe("completed");
    const roster = registry.rosterFor(dispatchId);
    expect(roster).toContain(childId);
    expect(roster).toContain("/tmp/restart");
  });
});
