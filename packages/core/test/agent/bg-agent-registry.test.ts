import { describe, expect, test } from "bun:test";
import { BackgroundAgentRegistry } from "../../src/agent/bg-agent-registry";

function entry(overrides: Partial<{ agentId: string; sessionId: string; threadId: string; name?: string }> = {}) {
  return {
    agentId: overrides.agentId ?? "a1",
    sessionId: overrides.sessionId ?? "s1",
    threadId: overrides.threadId ?? "t1",
    name: overrides.name,
    abort: new AbortController(),
  };
}

describe("BackgroundAgentRegistry", () => {
  test("register → list shows the running entry", () => {
    const reg = new BackgroundAgentRegistry();
    const res = reg.register(entry());
    expect(res).toEqual({ ok: true });
    const list = reg.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ agentId: "a1", sessionId: "s1", threadId: "t1", status: "running", notified: false });
    expect(typeof list[0]!.startedAt).toBe("number");
  });

  test("complete(ok:true) → completed + result stored", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("a1", { ok: true, result: "done" });
    const e = reg.get("a1");
    expect(e?.status).toBe("completed");
    expect(e?.result).toBe("done");
  });

  test("complete(ok:false) → failed + result stored", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("a1", { ok: false, result: "boom" });
    const e = reg.get("a1");
    expect(e?.status).toBe("failed");
    expect(e?.result).toBe("boom");
  });

  test("complete on unknown or already-terminal agent is a no-op", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("nope", { ok: true, result: "x" }); // unknown — no throw
    reg.complete("a1", { ok: true, result: "first" });
    reg.complete("a1", { ok: false, result: "second" }); // already terminal — ignored
    const e = reg.get("a1");
    expect(e?.status).toBe("completed");
    expect(e?.result).toBe("first");
  });

  test("get by agentId", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    expect(reg.get("a1")?.agentId).toBe("a1");
  });

  test("get by name", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ name: "builder" }));
    const e = reg.get("builder");
    expect(e?.agentId).toBe("a1");
  });

  test("get by name scoped to the wrong session returns undefined", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ name: "builder", sessionId: "s1" }));
    expect(reg.get("builder", "s2")).toBeUndefined();
    expect(reg.get("builder", "s1")?.agentId).toBe("a1");
  });

  test("get by agentId scoped to the wrong session returns undefined", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ sessionId: "s1" }));
    expect(reg.get("a1", "s2")).toBeUndefined();
    expect(reg.get("a1", "s1")?.agentId).toBe("a1");
  });

  test("register: name already used by a different agentId is rejected; original entry untouched", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1", name: "builder" }));
    const res = reg.register(entry({ agentId: "a2", name: "builder" }));
    expect(res).toEqual({ ok: false, error: "name 'builder' already in use by agent a1" });
    expect(reg.get("a2")).toBeUndefined();
    expect(reg.get("builder")?.agentId).toBe("a1");
  });

  test("register: re-registering the same agentId (even with the same name) is rejected as duplicate", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1", name: "builder" }));
    const res = reg.register(entry({ agentId: "a1", name: "builder" }));
    expect(res).toEqual({ ok: false, error: "agent 'a1' is already registered" });
    // original entry's fields (e.g. status) are untouched by the rejected re-register:
    expect(reg.get("a1")?.status).toBe("running");
  });

  test("names may repeat across different sessions", () => {
    const reg = new BackgroundAgentRegistry();
    const r1 = reg.register(entry({ agentId: "a1", sessionId: "s1", name: "builder" }));
    const r2 = reg.register(entry({ agentId: "a2", sessionId: "s2", name: "builder" }));
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
  });

  test("stop(running) → true, fires abort, status → stopped", () => {
    const reg = new BackgroundAgentRegistry();
    const e = entry();
    reg.register(e);
    expect(e.abort.signal.aborted).toBe(false);
    const stopped = reg.stop("a1");
    expect(stopped).toBe(true);
    expect(e.abort.signal.aborted).toBe(true);
    expect(reg.get("a1")?.status).toBe("stopped");
  });

  test("stop on a terminal agent returns false and does not re-fire abort semantics", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("a1", { ok: true, result: "done" });
    const stopped = reg.stop("a1");
    expect(stopped).toBe(false);
    expect(reg.get("a1")?.status).toBe("completed");
  });

  test("stop on an unknown agent returns false", () => {
    const reg = new BackgroundAgentRegistry();
    expect(reg.stop("nope")).toBe(false);
  });

  // T2 review (folded Minor): stop() then complete() must not resurrect a stopped entry back to
  // running/completed — complete()'s own "no-op unless status === running" guard (see its doc
  // comment) already covers this, but it was never pinned end-to-end for the stop→complete
  // ordering specifically (only the reverse, complete→stop, was tested above).
  test("stop() then complete(): the agent stays 'stopped' — complete() does not resurrect a stopped entry, and its result is never overwritten", () => {
    const reg = new BackgroundAgentRegistry();
    const e = entry();
    reg.register(e);
    expect(reg.stop("a1")).toBe(true);
    expect(reg.get("a1")?.status).toBe("stopped");

    // the detached child's own eventual resolution races in AFTER the stop — must be ignored
    reg.complete("a1", { ok: true, result: "raced-in-after-stop" });

    const after = reg.get("a1");
    expect(after?.status).toBe("stopped");
    expect(after?.result).toBeUndefined();
  });

  test("takeCompletedForSession returns terminal-unnotified entries once; empty on second call", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1" }));
    reg.register(entry({ agentId: "a2" }));
    reg.complete("a1", { ok: true, result: "r1" });
    reg.complete("a2", { ok: false, result: "r2" });

    const first = reg.takeCompletedForSession("s1");
    expect(first.map((e) => e.agentId).sort()).toEqual(["a1", "a2"]);
    expect(first.every((e) => e.notified)).toBe(true);

    const second = reg.takeCompletedForSession("s1");
    expect(second).toEqual([]);
  });

  test("a still-running agent is not returned by takeCompletedForSession", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1" }));
    reg.register(entry({ agentId: "a2" }));
    reg.complete("a1", { ok: true, result: "r1" });
    // a2 stays running

    const taken = reg.takeCompletedForSession("s1");
    expect(taken.map((e) => e.agentId)).toEqual(["a1"]);
    expect(reg.get("a2")?.status).toBe("running");
    expect(reg.get("a2")?.notified).toBe(false);
  });

  test("list returns entries in registration order, running and terminal alike", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1" }));
    reg.register(entry({ agentId: "a2" }));
    reg.register(entry({ agentId: "a3" }));
    reg.complete("a2", { ok: true, result: "x" });
    expect(reg.list("s1").map((e) => e.agentId)).toEqual(["a1", "a2", "a3"]);
  });

  test("list scopes to the given session only", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1", sessionId: "s1" }));
    reg.register(entry({ agentId: "a2", sessionId: "s2" }));
    expect(reg.list("s1").map((e) => e.agentId)).toEqual(["a1"]);
    expect(reg.list("s2").map((e) => e.agentId)).toEqual(["a2"]);
  });
});
