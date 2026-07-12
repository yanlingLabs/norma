/** Task 6 integration tests — <App> (the assembled Ink TUI) + mountTui's non-TTY guard.
 *
 *  <App> is driven exactly the way main.ts drives it in production: a real makeEventBridge() whose
 *  events the test pushes, and a FAKE client that only records the callback args (App calls no
 *  client method on its own — only in response to composer/card input, which these tests don't
 *  exercise). ink-testing-library renders in debug mode, so lastFrame() carries the FULL accumulated
 *  <Static> transcript plus the live dynamic region — a committed block added several renders ago
 *  still shows in the final frame (verified against ink's build: debug writes fullStaticOutput +
 *  output every render). */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../../src/tui/app";
import { mountTui } from "../../src/tui/mount";
import { makeEventBridge } from "../../src/tui/event-bridge";

// useInput / effects wire on the tick after render() returns (same caveat the other tui tests
// document) — a short wait after render and after each push keeps assertions deterministic.
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

afterEach(cleanup);

function fakeClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve({});
  };
  return {
    calls,
    send: rec("send"),
    steer: rec("steer"),
    interrupt: rec("interrupt"),
    setPolicy: rec("setPolicy"),
    askUserRespond: rec("askUserRespond"),
    planRespond: rec("planRespond"),
    request: rec("request"),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (o: Record<string, unknown>) => o as any;

describe("App (integration)", () => {
  test("(a) a full mini-turn (buffered before subscribe) commits the assistant text + returns to an idle composer", async () => {
    const bridge = makeEventBridge();
    // Push the whole turn BEFORE App renders/subscribes → exercises the bridge's pre-subscribe
    // buffer (the attach-replay path): none of these may be lost.
    bridge.push(ev({ type: "user_message", threadId: "main", text: "hello" }));
    bridge.push(ev({ type: "turn_started", threadId: "main" }));
    bridge.push(ev({ type: "assistant_delta", threadId: "main", delta: "hi " }));
    bridge.push(ev({ type: "assistant_delta", threadId: "main", delta: "there" }));
    bridge.push(ev({ type: "assistant_message", threadId: "main", text: "hi there friend" }));
    bridge.push(ev({ type: "turn_completed", threadId: "main", inputTokens: 10, outputTokens: 5 }));

    const client = fakeClient();
    const { lastFrame } = render(
      <App client={client} bridge={bridge} sessionId="s1" cwd="/tmp" initialPolicy="ask" />,
    );
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi there friend"); // committed assistant block flushed from the buffer
    expect(frame).toContain("❯ hello"); // committed user block (phase 3b Task 3 grammar: ❯, not ›)
    expect(frame).toContain("❯"); // idle composer prompt present
    // (phase 3b Task 5: the composer's old inline "ask mode" bar moved OUT to <Footer>, which a
    // later task wires into <App> — no mode text is asserted here anymore.)
    expect(client.calls).toEqual([]); // App issued no RPCs on its own
  });

  test("(b) parity bug e2e: a bg child's finish line keeps its real label/elapsed and the composer is never overwritten", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(
      <App client={client} bridge={bridge} sessionId="s1" cwd="/tmp" initialPolicy="ask" />,
    );
    await wait();

    // A run_in_background child that opens a timed span, finishes, THEN the main turn completes and
    // a further main message lands. The old CLI pruned the subagent list on the main turn_completed,
    // so a child finishing after it rendered `Agent "" · 0s`. The reducer never prunes on the main
    // turn, so the child's real label + banked elapsed survive.
    bridge.push(ev({ type: "thread_started", threadId: "th_1", agentType: "general-purpose", description: "scout", ts: 500 }));
    bridge.push(ev({ type: "turn_started", threadId: "th_1", ts: 1000 }));
    bridge.push(ev({ type: "thread_completed", threadId: "th_1", ts: 10000, stopReason: "end_turn" }));
    bridge.push(ev({ type: "turn_completed", threadId: "main", inputTokens: 20, outputTokens: 8 }));
    bridge.push(ev({ type: "assistant_message", threadId: "main", text: "all wrapped up" }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain('Agent "scout": Done'); // real label, not ""  (phase 3b Task 6 wording)
    expect(frame).toContain("9s"); // banked span (10000-1000), not 0s
    expect(frame).toContain("(scout)"); // roster tree row survived the main turn_completed (not pruned)
    expect(frame).toContain("all wrapped up"); // the following main message rendered
    expect(frame).toContain("❯"); // composer still present, never overwritten
  });

  test("(c) a bg_task_output chunk lands in the committed transcript and the composer stays present after it", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(
      <App client={client} bridge={bridge} sessionId="s1" cwd="/tmp" initialPolicy="ask" />,
    );
    await wait();

    bridge.push(ev({ type: "bg_task_output", taskId: "t1", chunk: "BUILD-LOG-XYZ" }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("BUILD-LOG-XYZ"); // committed to Static (scrollback), not the live region
    expect(frame).toContain("❯"); // composer still rendered below it (invisible-prompt invariant)
  });
});

describe("mountTui (non-TTY guard)", () => {
  test("(d) does NOT render Ink when stdout is not a TTY and returns a resolved no-op handle", async () => {
    const prev = process.stdout.isTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).isTTY = false;
    try {
      let renders = 0;
      const handle = mountTui(
        { client: fakeClient(), bridge: makeEventBridge(), sessionId: "s", cwd: "/tmp", initialPolicy: "ask" },
        // injected renderer — must never be called on a non-TTY
        () => {
          renders += 1;
          return { waitUntilExit: () => new Promise<void>(() => {}) };
        },
      );
      expect(renders).toBe(0);
      let resolved = false;
      await Promise.race([handle.waitUntilExit().then(() => { resolved = true; }), wait(30)]);
      expect(resolved).toBe(true); // resolved immediately → nothing is blocking on a live Ink instance
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).isTTY = prev;
    }
  });

  test("(d2) DOES render (once) when stdout IS a TTY", () => {
    const prev = process.stdout.isTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).isTTY = true;
    try {
      let renders = 0;
      mountTui(
        { client: fakeClient(), bridge: makeEventBridge(), sessionId: "s", cwd: "/tmp", initialPolicy: "ask" },
        () => {
          renders += 1;
          return { waitUntilExit: () => new Promise<void>(() => {}) };
        },
      );
      expect(renders).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).isTTY = prev;
    }
  });
});
