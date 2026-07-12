/** Phase 3c Task 4 — <App>, the fullscreen alt-screen shell.
 *
 *  <App> is driven the way main.ts drives it in production: a real makeEventBridge() whose events
 *  the test pushes, and a FAKE client that only records callback args (App issues no RPC on its own,
 *  only in response to composer/card/key input). ink-testing-library renders in debug mode, so
 *  lastFrame() is the WHOLE frame — a root pinned to `height = rows - 1` (24-1 = 23 lines in the
 *  non-TTY test env, where process.stdout.rows is undefined → the App's 24 fallback).
 *
 *  The transcript is a JS-windowed line log now (no Ink <Static>): the flattened committed lines are
 *  sliced to the viewport height and rendered one <Text> per visible line, above a PINNED bottom bar
 *  (active-turn tail · tasks · spinner · composer|card · agents · footer). Scroll keys / wheel move
 *  the window; "stick" auto-follows the tail until the user scrolls away. */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App, bottomBarRows } from "../../src/tui/app";
import { makeEventBridge } from "../../src/tui/event-bridge";
import type { AgentRow } from "../../src/tui/state";
import type { TaskRow } from "../../src/task-display";

// useInput / effects wire on the tick after render() returns — a short wait after render and after
// each push/keystroke keeps assertions deterministic.
const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));

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

// The composer's real inverse-video cursor (`<Text inverse>`) — a unique fingerprint of "the
// composer is rendered" (nothing else in the TUI uses `inverse`).
const COMPOSER_CURSOR = "\x1b[7m";
const FOOTER_HINT = "shift+tab to cycle modes";

// SGR mouse wheel-up report (mode 1006). Ink strips the leading ESC before useInput, but the App's
// emitter patch sees the raw chunk (ESC intact) — so mouse input is swallowed before the composer.
const WHEEL_UP = "\x1b[<64;10;5M";

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("App (fullscreen shell)", () => {
  test("(a) a full mini-turn (buffered before subscribe) commits the assistant text + returns to an idle composer", async () => {
    const bridge = makeEventBridge();
    // Push the whole turn BEFORE App renders/subscribes → exercises the bridge's pre-subscribe buffer.
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
    expect(frame).toContain("hi there friend"); // committed assistant block, windowed into view
    expect(frame).toContain("❯ hello"); // committed user block (⏺/❯ grammar)
    expect(frame).toContain(COMPOSER_CURSOR); // idle composer prompt present
    expect(client.calls).toEqual([]); // App issued no RPCs on its own
  });

  test("(b) parity bug e2e: a bg child's finish line keeps its real label/elapsed and the composer is never overwritten", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

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

  test("(c) a bg_task_output chunk lands in the transcript and the composer stays present after it", async () => {
    const bridge = makeEventBridge();
    const client = fakeClient();
    const { lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    bridge.push(ev({ type: "bg_task_output", taskId: "t1", chunk: "BUILD-LOG-XYZ" }));
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("BUILD-LOG-XYZ"); // committed to the transcript line log
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

  test("(e) empty session: frame is exactly rows-1 lines, welcome at the top, composer + footer pinned at the bottom", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    const lines = (lastFrame() ?? "").split("\n");

    expect(lines).toHaveLength(23); // rows-1 (HARD CONSTRAINT 1: outputHeight < stdout.rows)
    expect(lines[0]).toContain("Norma"); // welcome header rides the top of the log
    expect(lines.at(-1)).toContain(FOOTER_HINT); // footer is the very last row

    // The composer sits at the frame BOTTOM (pushed down by the flexGrow transcript region), not
    // directly under the welcome.
    const cursorLine = lines.findIndex((l) => l.includes(COMPOSER_CURSOR));
    expect(cursorLine).toBeGreaterThanOrEqual(lines.length - 4);
  });

  test("(f) tasks auto-appear on task_updated (default visible) and ctrl+t toggles them", async () => {
    const bridge = makeEventBridge();
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    bridge.push(ev({ type: "task_updated", task: { id: "t1", subject: "ship the feature", status: "pending" } }));
    await wait();
    expect(lastFrame() ?? "").toContain("ship the feature"); // visible by DEFAULT (CC default)

    stdin.write("\x14"); // ctrl+t -> hide
    await wait();
    expect(lastFrame() ?? "").not.toContain("ship the feature");

    stdin.write("\x14"); // ctrl+t -> show again
    await wait();
    expect(lastFrame() ?? "").toContain("ship the feature");
  });

  test("(g) Footer shows the plan-mode indicator when initialPolicy is plan", async () => {
    const bridge = makeEventBridge();
    const { lastFrame } = render(
      <App client={fakeClient()} bridge={bridge} sessionId="s" cwd="/tmp" initialPolicy="plan" version="0.0.1" model="m" />,
    );
    await wait();
    expect(lastFrame() ?? "").toContain("⏸ plan mode on");
  });

  test("(h) long transcript sticks to the tail: newest lines visible, oldest scrolled off, bottom bar intact", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `NOTE-${i}` }));
    const { lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NOTE-39"); // tail follows growth (stick)
    expect(frame).not.toContain("NOTE-0"); // oldest scrolled off the top
    expect((frame).split("\n")).toHaveLength(23); // still exactly rows-1
    expect(frame).toContain(COMPOSER_CURSOR); // bottom bar still pinned
  });

  test("(i) scroll keys: PgUp unsticks (a new block does NOT move the view); PgDn back to the end re-sticks (follows)", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `NOTE-${i}` }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write("\x1b[5~"); // PgUp -> unstick
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "UNSTUCK-MARKER" }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("UNSTUCK-MARKER"); // unstuck: view held, new block not followed

    for (let k = 0; k < 6; k++) { stdin.write("\x1b[6~"); await wait(8); } // PgDn to the end -> re-stick
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "RESTICK-MARKER" }));
    await wait();
    expect(lastFrame() ?? "").toContain("RESTICK-MARKER"); // re-stuck: tail follows again
  });

  test("(j) ctrl+o toggles verbose: a capped tool output expands in place (full lines, no '+N lines' hint)", async () => {
    const bridge = makeEventBridge();
    const out = Array.from({ length: 14 }, (_, i) => `oline${i}`).join("\n");
    bridge.push(ev({ type: "tool_call", threadId: "main", name: "bash", argsJson: "{}" }));
    bridge.push(ev({ type: "tool_result", threadId: "main", output: out }));
    const { stdin, lastFrame } = render(<App client={fakeClient()} bridge={bridge} {...baseProps} />);
    await wait();

    let frame = lastFrame() ?? "";
    expect(frame).toContain("… +4 lines (ctrl+o to expand)"); // non-verbose: capped at 10
    expect(frame).not.toContain("oline13");

    stdin.write("\x0f"); // ctrl+o -> verbose
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("oline13"); // full output now shown in place
    expect(frame).not.toContain("+4 lines"); // no truncation hint in verbose
  });

  test("(k) wheel scroll: the SGR report scrolls the transcript (unsticks) and never reaches the composer buffer", async () => {
    const bridge = makeEventBridge();
    for (let i = 0; i < 40; i++) bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: `W-${i}` }));
    const client = fakeClient();
    const { stdin, lastFrame } = render(<App client={client} bridge={bridge} {...baseProps} />);
    await wait();

    stdin.write(WHEEL_UP); // wheel up -> scroll up + unstick
    await wait();
    const frame = lastFrame() ?? "";
    expect(count(frame, "64;10;5")).toBe(0); // the raw mouse bytes never landed anywhere (not the composer)

    // The composer buffer is empty (mouse was swallowed): Enter submits nothing.
    stdin.write("\r");
    await wait();
    expect(client.calls).toEqual([]);

    // The wheel actually scrolled: it unstuck the view, so a new block is no longer auto-followed.
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "WHEEL-UNSTUCK" }));
    await wait();
    expect(lastFrame() ?? "").not.toContain("WHEEL-UNSTUCK");
  });

  test("(l) resize: the frame re-renders to the new terminal height", async () => {
    const prev = (process.stdout as unknown as { rows?: number }).rows;
    const { lastFrame } = render(<App client={fakeClient()} bridge={makeEventBridge()} {...baseProps} />);
    try {
      await wait();
      expect((lastFrame() ?? "").split("\n")).toHaveLength(23); // rows=24 fallback -> 23

      (process.stdout as unknown as { rows?: number }).rows = 30;
      process.stdout.emit("resize");
      await wait();
      expect((lastFrame() ?? "").split("\n")).toHaveLength(29); // rows=30 -> 29
    } finally {
      (process.stdout as unknown as { rows?: number }).rows = prev;
    }
  });
});

describe("bottomBarRows (pinned-bar line-count model)", () => {
  const task = (subject: string, status: TaskRow["status"]): TaskRow => ({ id: subject, subject, status });
  const agent = (threadId: string): AgentRow => ({
    threadId, agentType: "general-purpose", label: "a", status: "working",
    outputTokens: 0, liveOutputChars: 0, activeMs: 0, toolCalls: 0,
  });

  test("empty: composer (3) + footer (1) = 4", () => {
    expect(bottomBarRows({ tasksVisible: true, tasks: [], agents: [], running: false, pending: null, activeTurnRows: 0 })).toBe(4);
  });

  test("spinner adds 1 while a turn runs", () => {
    expect(bottomBarRows({ tasksVisible: true, tasks: [], agents: [], running: true, pending: null, activeTurnRows: 0 })).toBe(5);
  });

  test("tasks add the count header + one row per task while visible; nothing when hidden", () => {
    const tasks = [task("a", "in_progress"), task("b", "pending")];
    expect(bottomBarRows({ tasksVisible: true, tasks, agents: [], running: false, pending: null, activeTurnRows: 0 })).toBe(4 + (1 + 2));
    expect(bottomBarRows({ tasksVisible: false, tasks, agents: [], running: false, pending: null, activeTurnRows: 0 })).toBe(4);
  });

  test("each live agent adds two rows (head + continuation)", () => {
    expect(bottomBarRows({ tasksVisible: true, tasks: [], agents: [agent("x"), agent("y")], running: false, pending: null, activeTurnRows: 0 })).toBe(4 + 4);
  });

  test("active-turn tail rows and a pending card both count; the card replaces the composer's 3", () => {
    expect(bottomBarRows({ tasksVisible: true, tasks: [], agents: [], running: false, pending: null, activeTurnRows: 5 })).toBe(9); // 5 + composer 3 + footer 1
    const withCard = bottomBarRows({
      tasksVisible: true, tasks: [], agents: [], running: false,
      pending: { kind: "approval", callId: "c", toolName: "bash", summary: "x" }, activeTurnRows: 0,
    });
    expect(withCard).toBe(1 + 1); // approval card (1) + footer (1), NOT the composer's 3
  });
});
