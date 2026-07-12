/** Task 7 integration tests — <App> (the CC-layout Ink TUI) + mountTui's non-TTY guard.
 *
 *  <App> is driven exactly the way main.ts drives it in production: a real makeEventBridge() whose
 *  events the test pushes, and a FAKE client that only records the callback args (App calls no
 *  client method on its own — only in response to composer/card/key input). ink-testing-library
 *  renders in debug mode, so lastFrame() carries the FULL accumulated <Static> transcript plus the
 *  live dynamic region — a committed block added several renders ago still shows in the final frame.
 *
 *  Phase 3b Task 7 re-skins the layout: the welcome banner is the first Static line; StatusLine is
 *  gone (Spinner + Footer own the turn chrome); ctrl+t toggles the task view; ctrl+o opens the
 *  alt-screen pager (its own coverage lives in pager.test.tsx). */

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

const baseProps = { sessionId: "s1", cwd: "/tmp", initialPolicy: "ask" as const, version: "0.0.1", model: "gpt-5-codex" };

// Phase 3c T3's composer replaced its trailing "▌" block-cursor glyph with a real inverse-video
// cursor (`<Text inverse>`) — this SGI "start inverse" code is a unique fingerprint of "the
// composer is rendered" (nothing else in the TUI uses `inverse`).
const COMPOSER_CURSOR = "\x1b[7m";

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
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi there friend"); // committed assistant block flushed from the buffer
    expect(frame).toContain("❯ hello"); // committed user block (⏺/❯ grammar)
    expect(frame).toContain(COMPOSER_CURSOR); // idle composer prompt (its cursor) present
    expect(client.calls).toEqual([]); // App issued no RPCs on its own
  });

  test("(b) parity bug e2e: a bg child's finish line keeps its real label/elapsed and the composer is never overwritten", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
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
    expect(frame).toContain('Agent "scout": Done'); // real label, not "" (Task 6 wording)
    expect(frame).toContain("9s"); // banked span (10000-1000), not 0s
    expect(frame).toContain("(scout)"); // roster tree row survived the main turn_completed (not pruned)
    expect(frame).toContain("all wrapped up"); // the following main message rendered
    expect(frame).toContain(COMPOSER_CURSOR); // composer still present, never overwritten
  });

  test("(c) a bg_task_output chunk lands in the committed transcript and the composer stays present after it", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    bridge.push(ev({ type: "bg_task_output", taskId: "t1", chunk: "BUILD-LOG-XYZ" }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("BUILD-LOG-XYZ"); // committed to Static (scrollback), not the live region
    expect(frame).toContain(COMPOSER_CURSOR); // composer still rendered below it (invisible-prompt invariant)
  });

  test("(d) welcome banner is the first line: bold Norma + version, then model · cwd", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(
      <App client={fakeClient()} bridge={bridge} sessionId="s" cwd="/work/proj" initialPolicy="ask" version="0.0.1" model="gpt-5-codex" />,
    );
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Norma");
    expect(frame).toContain("v0.0.1");
    expect(frame).toContain("gpt-5-codex · /work/proj");
  });

  test("(e) ctrl+t toggles the task view (hidden by default, visible after the toggle)", async () => {
    const bridge = makeEventBridge();
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "task_updated", task: { id: "t1", subject: "ship the feature", status: "pending" } }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("ship the feature"); // tasks hidden by default

    stdin.write("\x14"); // ctrl+t
    await wait();
    expect(lastFrame() ?? "").toContain("ship the feature"); // now visible

    stdin.write("\x14"); // ctrl+t again -> hidden
    await wait();
    expect(lastFrame() ?? "").not.toContain("ship the feature");
  });

  test("(f) Footer shows the plan-mode indicator when initialPolicy is plan", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(
      <App client={fakeClient()} bridge={bridge} sessionId="s" cwd="/tmp" initialPolicy="plan" version="0.0.1" model="m" />,
    );
    await wait();
    expect(lastFrame() ?? "").toContain("⏸ plan mode on");
  });
});

describe("mountTui (non-TTY guard)", () => {
  const mountOpts = () => ({
    client: fakeClient(),
    bridge: makeEventBridge(),
    sessionId: "s",
    cwd: "/tmp",
    initialPolicy: "ask" as const,
    version: "0.0.1",
    model: "m",
  });

  test("(g) does NOT render Ink when stdout is not a TTY and returns a resolved no-op handle", async () => {
    const prev = process.stdout.isTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).isTTY = false;
    try {
      let renders = 0;
      const handle = mountTui(mountOpts(), () => {
        renders += 1;
        return { waitUntilExit: () => new Promise<void>(() => {}) };
      });
      expect(renders).toBe(0);
      let resolved = false;
      await Promise.race([handle.waitUntilExit().then(() => { resolved = true; }), wait(30)]);
      expect(resolved).toBe(true); // resolved immediately → nothing is blocking on a live Ink instance
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).isTTY = prev;
    }
  });

  test("(g2) DOES render (once) when stdout IS a TTY", () => {
    const prev = process.stdout.isTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).isTTY = true;
    try {
      let renders = 0;
      mountTui(mountOpts(), () => {
        renders += 1;
        return { waitUntilExit: () => new Promise<void>(() => {}) };
      });
      expect(renders).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).isTTY = prev;
    }
  });
});
