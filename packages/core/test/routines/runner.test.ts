import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { makeDaemonRoutineRunner, type MinimalEngine } from "../../src/routines/runner";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "norma-routine-runner-"));
}

describe("makeDaemonRoutineRunner — runHeadless", () => {
  test("no engine configured (agent disabled): fails cleanly, no session left dangling on the happy path", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const runner = makeDaemonRoutineRunner({ store, hub, engine: null });

    const result = await runner.runHeadless({ prompt: "check inbox", policy: "auto", cwd: "/tmp", origin: "routine/r1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent disabled|no provider/i);
  });

  test("success: creates a session titled with `origin`, posts the prompt, runs one turn, returns the final assistant text", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    let sawSessionId: string | undefined;
    let sawPrompt: string | undefined;
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        sawSessionId = sessionId;
        const events = store.read(sessionId);
        const userMsg = events.find((e) => e.type === "user_message");
        sawPrompt = userMsg && "text" in userMsg ? userMsg.text : undefined;
        hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "3 unread emails" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "check inbox", policy: "auto", cwd: "/tmp/proj", origin: "routine/r1" });

    expect(result.ok).toBe(true);
    expect(result.resultText).toBe("3 unread emails");
    expect(sawPrompt).toBe("check inbox");
    expect(sawSessionId).toBeDefined();

    // origin is visible in the session list (title-stamp fallback — no session-meta protocol change).
    const listed = store.list().find((s) => s.sessionId === sawSessionId);
    expect(listed?.title).toBe("routine/r1");
    expect(listed?.cwd).toBe("/tmp/proj");
  });

  test("quota error: an agent_error whose message starts with HTTP 429 maps to quotaLimited", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "HTTP 429 — rate limited" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r2" });
    expect(result.ok).toBe(false);
    expect(result.quotaLimited).toBe(true);
    expect(result.error).toBe("HTTP 429 — rate limited");
  });

  test("non-quota error: an agent_error NOT starting with HTTP 429 is a plain error (not quotaLimited)", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = {
      async runTurn(sessionId) {
        hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "tool crashed" });
        hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
      },
    };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r3" });
    expect(result.ok).toBe(false);
    expect(result.quotaLimited).toBeUndefined();
    expect(result.error).toBe("tool crashed");
  });

  test("engine.runTurn throwing surfaces as a plain error result, never rejects", async () => {
    const store = new SessionStore(makeHome());
    const hub = new SessionHub(store);
    const engine: MinimalEngine = { async runTurn() { throw new Error("engine exploded"); } };
    const runner = makeDaemonRoutineRunner({ store, hub, engine });

    const result = await runner.runHeadless({ prompt: "x", policy: "auto", cwd: "/tmp", origin: "routine/r4" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("engine exploded");
  });
});
