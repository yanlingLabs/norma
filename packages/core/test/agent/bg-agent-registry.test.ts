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

  // bg-retrigger Task 1: takeCompletedForSession retired (its only caller,
  // buildBgCompletionReminder, is gone — see engine.ts) in favor of takeForNotification, a
  // single-agentId, single-consumer claim used by notifyBgCompletion to persist a task_notification
  // event exactly once per completion.
  test("takeForNotification returns a terminal-unnotified entry once; undefined on the second call", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1" }));
    reg.complete("a1", { ok: true, result: "r1" });

    const first = reg.takeForNotification("a1");
    expect(first?.agentId).toBe("a1");
    expect(first?.notified).toBe(true);

    expect(reg.takeForNotification("a1")).toBeUndefined();
  });

  test("a still-running agent is not returned by takeForNotification (undefined)", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry({ agentId: "a1" }));
    expect(reg.takeForNotification("a1")).toBeUndefined();
    expect(reg.get("a1")?.status).toBe("running");
    expect(reg.get("a1")?.notified).toBe(false);
  });

  test("takeForNotification returns undefined for an unknown agentId", () => {
    const reg = new BackgroundAgentRegistry();
    expect(reg.takeForNotification("ghost")).toBeUndefined();
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

  // 4h-ii-b Task 1: `resume` is additive/optional on both RegisterInput and AgentEntry — 4h-ii-a's
  // register() calls (which never pass one) must still compile and behave exactly as before.
  test("register: `resume` is optional — an entry registered without one carries resume:undefined", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    expect(reg.get("a1")?.resume).toBeUndefined();
  });

  test("register: `resume` (when passed) round-trips through get()/list() untouched", () => {
    const reg = new BackgroundAgentRegistry();
    const resume = {
      agentType: "reviewer",
      cwd: "/repo/child",
      roots: ["/repo/child"],
      approvalPolicy: "auto" as const,
      model: "fake-1",
      instructions: "you are a subagent",
      maxTurns: 10,
      // 4h-ii-b Task 3 (D5): the fields resume (T3) captures at spawn so it re-runs the child
      // with the exact same depth/tools/opening-prompt, never a re-derived guess.
      openingPrompt: "review the auth module",
      description: "review auth",
      depth: 1,
      loaded: ["ToolSearch"],
      excludeTools: ["ask_user", "exit_plan_mode", "enter_plan_mode"],
      allowTools: ["read", "grep"],
    };
    reg.register({ ...entry(), resume });
    expect(reg.get("a1")?.resume).toEqual(resume);
    expect(reg.list("s1")[0]?.resume).toEqual(resume);
  });

  // 4h-ii-b Task 3 (D3): reopen() re-admits an already-registered TERMINAL entry (register()
  // rejects a known agentId, so resume can't use it to flip status). This is what lets a finished
  // agent be resumed: flip status running, clear the stale result, reset notified so the resumed
  // completion's reminder re-fires, and swap in the resume attempt's fresh AbortController.
  test("reopen(terminal) → true: status running, result cleared, notified reset, abort replaced", () => {
    const reg = new BackgroundAgentRegistry();
    const firstAbort = new AbortController();
    reg.register({ ...entry(), abort: firstAbort });
    reg.complete("a1", { ok: true, result: "first run output" }, { notified: true });
    expect(reg.get("a1")).toMatchObject({ status: "completed", result: "first run output", notified: true });

    const resumeAbort = new AbortController();
    const ok = reg.reopen("a1", resumeAbort);
    expect(ok).toBe(true);
    const e = reg.get("a1")!;
    expect(e.status).toBe("running");
    expect(e.result).toBeUndefined();
    expect(e.notified).toBe(false);
    expect(e.abort).toBe(resumeAbort);
  });

  test("reopen(unknown id) → false, no throw", () => {
    const reg = new BackgroundAgentRegistry();
    expect(reg.reopen("nope", new AbortController())).toBe(false);
  });

  test("reopen(already running) → false — a running agent is not resumable (the bridge guards this too)", () => {
    const reg = new BackgroundAgentRegistry();
    const firstAbort = new AbortController();
    reg.register({ ...entry(), abort: firstAbort });
    const ok = reg.reopen("a1", new AbortController());
    expect(ok).toBe(false);
    // untouched: still running, still holds its ORIGINAL abort controller
    expect(reg.get("a1")?.status).toBe("running");
    expect(reg.get("a1")?.abort).toBe(firstAbort);
  });

  test("reopen a stopped entry → true (stopped is terminal too)", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.stop("a1");
    expect(reg.get("a1")?.status).toBe("stopped");
    expect(reg.reopen("a1", new AbortController())).toBe(true);
    expect(reg.get("a1")?.status).toBe("running");
  });

  test("a reopened (now-running) entry is NOT surfaced by takeForNotification (undefined)", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("a1", { ok: true, result: "done" }); // unnotified terminal
    reg.reopen("a1", new AbortController()); // flip back to running BEFORE the claim
    expect(reg.takeForNotification("a1")).toBeUndefined();
  });

  // 4h-ii-b Task 1: a SYNC spawn's completion is registered `notified` immediately (the caller
  // already got this result directly as its own tool_result, same turn) — complete()'s
  // `opts.notified` param must actually suppress it from takeForNotification's claim, not
  // just set the field cosmetically.
  test("complete({notified:true}) → the entry is immediately notified, so takeForNotification returns undefined", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("a1", { ok: true, result: "done" }, { notified: true });
    expect(reg.get("a1")).toMatchObject({ status: "completed", result: "done", notified: true });
    expect(reg.takeForNotification("a1")).toBeUndefined();
  });

  test("complete without opts (default) is unchanged — entry starts unnotified, takeForNotification still picks it up once", () => {
    const reg = new BackgroundAgentRegistry();
    reg.register(entry());
    reg.complete("a1", { ok: true, result: "done" });
    expect(reg.get("a1")?.notified).toBe(false);
    expect(reg.takeForNotification("a1")?.agentId).toBe("a1");
  });

  // 4h-ii-c: AgentStatus gains "timeout" — a bg spawn whose SubagentManager.run() rejected via
  // its own clock (SubagentResult.timedOut:true) reports distinctly from a generic "failed", so
  // a future client can render/handle "timed out" separately from "errored". "timeout" is
  // TERMINAL like completed/failed/stopped: surfaced once by takeForNotification, reopen()
  // accepts it (a timed-out child may still be resumable — the 4h-ii-b shape guard decides that
  // from its history), and stop() rejects it (not running).
  describe("complete({timedOut:true}) → 'timeout' status (4h-ii-c)", () => {
    test("complete(..., {timedOut:true}) → status 'timeout' (not 'failed'), result stored", () => {
      const reg = new BackgroundAgentRegistry();
      reg.register(entry());
      reg.complete("a1", { ok: false, result: "timed out after 50s" }, { timedOut: true });
      const e = reg.get("a1");
      expect(e?.status).toBe("timeout");
      expect(e?.result).toBe("timed out after 50s");
    });

    test("complete({timedOut:true, ok:true}) still becomes 'timeout' — timedOut wins over outcome.ok", () => {
      const reg = new BackgroundAgentRegistry();
      reg.register(entry());
      reg.complete("a1", { ok: true, result: "irrelevant" }, { timedOut: true });
      expect(reg.get("a1")?.status).toBe("timeout");
    });

    test("a 'timeout' entry is terminal: surfaced once by takeForNotification, undefined on the next call", () => {
      const reg = new BackgroundAgentRegistry();
      reg.register(entry());
      reg.complete("a1", { ok: false, result: "timed out" }, { timedOut: true });
      const first = reg.takeForNotification("a1");
      expect(first?.agentId).toBe("a1");
      expect(first?.status).toBe("timeout");
      expect(reg.takeForNotification("a1")).toBeUndefined();
    });

    test("reopen() accepts a 'timeout' entry — resumable, exactly like any other terminal status", () => {
      const reg = new BackgroundAgentRegistry();
      reg.register(entry());
      reg.complete("a1", { ok: false, result: "timed out" }, { timedOut: true });
      expect(reg.get("a1")?.status).toBe("timeout");
      const ok = reg.reopen("a1", new AbortController());
      expect(ok).toBe(true);
      expect(reg.get("a1")?.status).toBe("running");
    });

    test("stop() rejects a 'timeout' entry — not running, returns false, status untouched", () => {
      const reg = new BackgroundAgentRegistry();
      reg.register(entry());
      reg.complete("a1", { ok: false, result: "timed out" }, { timedOut: true });
      expect(reg.stop("a1")).toBe(false);
      expect(reg.get("a1")?.status).toBe("timeout");
    });

    test("complete({timedOut:true, notified:true}) — both opts apply together: status 'timeout' AND immediately notified", () => {
      const reg = new BackgroundAgentRegistry();
      reg.register(entry());
      reg.complete("a1", { ok: false, result: "timed out" }, { timedOut: true, notified: true });
      expect(reg.get("a1")).toMatchObject({ status: "timeout", notified: true });
      expect(reg.takeForNotification("a1")).toBeUndefined();
    });
  });
});
