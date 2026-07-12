/** Phase 3b Task 7 — the ctrl+o alt-screen transcript pager.
 *
 *  Two layers under test:
 *   1. Pure helpers (`pagerLines`, `pagerViewport`, `pagerWindowRows`) — the VERBOSE flatten of the
 *      committed transcript (full tool outputs, NO groupBlocks collapsing) and the bounded-window
 *      slice/clamp math (HARD CONSTRAINT 1: total rendered lines stay strictly under stdout.rows so
 *      Ink never emits clearTerminal / the scrollback-erasing \x1b[3J).
 *   2. The `<App>`-level ctrl+o wiring — enter/leave escape ordering to the injected `write` sink,
 *      the open/close round trip, and the composer going inert while the pager owns input.
 *
 *  Same effect-timing caveat as the other tui tests: `useInput` wires its stdin listener inside a
 *  React effect that runs on the tick after render(), and state-driven re-renders need a tick to
 *  flush — a short wait after render() and after each stdin.write keeps every assertion deterministic. */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../../src/tui/app";
import { Pager, pagerLines, pagerViewport, pagerWindowRows, PAGER_FOOTER } from "../../src/tui/pager";
import { CommittedTranscript, settledCount } from "../../src/tui/transcript";
import { makeEventBridge } from "../../src/tui/event-bridge";
import type { Block } from "../../src/tui/state";

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

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT = "\x1b[?1049l";

describe("pagerLines (verbose flatten — full outputs, NO grouping)", () => {
  test("expands every block individually with the FULL tool output and no +N / group-summary hints", () => {
    const bigOutput = Array.from({ length: 25 }, (_, i) => `out-${String(i).padStart(2, "0")}`).join("\n");
    const blocks: Block[] = [
      { kind: "user", text: "do the thing" },
      { kind: "assistant", text: "on it" },
      { kind: "tool", name: "read", argsJson: '{"path":"a"}', output: "AAA" }, // collapsible…
      { kind: "tool", name: "read", argsJson: '{"path":"b"}', output: "BBB" }, // …but pager expands both
      { kind: "tool", name: "bash", argsJson: '{"cmd":"x"}', output: bigOutput },
    ];
    const joined = pagerLines(blocks).join("\n");

    expect(joined).toContain("❯ do the thing");
    expect(joined).toContain("on it");
    expect(joined).toContain("out-00");
    expect(joined).toContain("out-24"); // FULL 25-line output — NOT capped at 10 like the transcript
    expect(joined).not.toContain("lines (ctrl+o to expand)"); // no truncation hint in the pager
    expect(joined).not.toContain("Read 2 files"); // groupBlocks NOT applied — reads shown individually
    // both read blocks are present as their own head lines
    expect(pagerLines(blocks).filter((l) => l.includes("read")).length).toBe(2);
  });
});

describe("pagerViewport (window slice + clamps; reserves footer + sibling headroom)", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `L${i}`);

  test("windowRows = rows - 3 (footer + open-tail sibling + strict-< headroom); slices from offset", () => {
    expect(pagerWindowRows(13)).toBe(10);
    const { window, offset } = pagerViewport(lines, 13, 5);
    expect(offset).toBe(5);
    expect(window).toEqual(lines.slice(5, 15));
    expect(window.length).toBe(10);
  });

  test("offset clamps to 0 (never negative)", () => {
    const { window, offset } = pagerViewport(lines, 13, -100);
    expect(offset).toBe(0);
    expect(window[0]).toBe("L0");
  });

  test("offset clamps to max (never scrolls past the end)", () => {
    const win = pagerWindowRows(13); // 10
    const { window, offset } = pagerViewport(lines, 13, 9999);
    expect(offset).toBe(50 - win); // 40
    expect(window[window.length - 1]).toBe("L49");
  });

  test("short content: window is all lines, offset pinned to 0", () => {
    const { window, offset } = pagerViewport(["a", "b"], 24, 3);
    expect(offset).toBe(0);
    expect(window).toEqual(["a", "b"]);
  });
});

describe("<Pager> (window + footer, total <= rows - 1)", () => {
  test("shows the full output and the footer hint", () => {
    const bigOutput = Array.from({ length: 25 }, (_, i) => `row-${i}`).join("\n");
    const blocks: Block[] = [{ kind: "tool", name: "bash", argsJson: "{}", output: bigOutput }];
    const { lastFrame } = render(<Pager blocks={blocks} rows={40} offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("row-0");
    expect(frame).toContain("row-24");
    expect(frame).toContain(PAGER_FOOTER);
  });

  test("clamps its own rendered height to <= rows - 1 (window + footer)", () => {
    const blocks: Block[] = Array.from({ length: 60 }, (_, i) => ({ kind: "note" as const, text: `n${i}` }));
    const rows = 12;
    const { lastFrame } = render(<Pager blocks={blocks} rows={rows} offset={0} />);
    const frame = lastFrame() ?? "";
    // window(rows-3=9) + footer(1) = 10 <= rows-1 = 11
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows - 1);
  });
});

describe("<App> ctrl+o pager (alt-screen enter/leave via injected sink)", () => {
  function renderApp() {
    const sink: string[] = [];
    const bridge = makeEventBridge();
    const client = fakeClient();
    const r = render(
      <App
        client={client}
        bridge={bridge}
        sessionId="s"
        cwd="/tmp"
        initialPolicy="ask"
        version="0.0.1"
        model="m"
        write={(s) => sink.push(s)}
      />,
    );
    return { ...r, sink, client, bridge };
  }

  test("ctrl+o opens (enter escape written, footer shown, composer gone), ctrl+o closes (leave escape, composer back)", async () => {
    const { stdin, lastFrame, sink, bridge } = renderApp();
    await wait();
    bridge.push(ev({ type: "assistant_message", threadId: "main", text: "hello there" }));
    await wait();

    stdin.write("\x0f"); // ctrl+o -> open
    await wait();
    expect(sink).toEqual([ENTER_ALT]); // enter escape written BEFORE the pager frame commits
    expect(lastFrame() ?? "").toContain(PAGER_FOOTER);
    expect(lastFrame() ?? "").not.toContain("▌"); // composer (its block cursor) is gone

    stdin.write("\x0f"); // ctrl+o -> close
    await wait();
    expect(sink).toEqual([ENTER_ALT, LEAVE_ALT]); // leave escape follows, in order
    expect(lastFrame() ?? "").not.toContain(PAGER_FOOTER);
    expect(lastFrame() ?? "").toContain("▌"); // composer restored
  });

  test("esc closes the pager (leave escape written)", async () => {
    const { stdin, lastFrame, sink } = renderApp();
    await wait();
    stdin.write("\x0f"); // open
    await wait();
    expect(lastFrame() ?? "").toContain(PAGER_FOOTER);

    stdin.write("\x1b"); // esc -> close
    await wait();
    expect(sink).toEqual([ENTER_ALT, LEAVE_ALT]);
    expect(lastFrame() ?? "").not.toContain(PAGER_FOOTER);
  });

  test("composer is inert while the pager is open (Enter does not submit)", async () => {
    const { stdin, client } = renderApp();
    await wait();
    stdin.write("\x0f"); // open pager -> composer disabled
    await wait();
    stdin.write("hello");
    await wait();
    stdin.write("\r"); // would submit if the composer were live
    await wait();
    expect(client.calls).toEqual([]); // no send/steer — composer input suppressed
  });

  test("control: composer IS live when the pager is closed (Enter submits)", async () => {
    const { stdin, client } = renderApp();
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();
    expect(client.calls.map((c) => c.method)).toContain("send");
  });

  test("fix A: a pending card arriving while the pager is open AUTO-CLOSES it (leave escape written, card mounted)", async () => {
    const { stdin, lastFrame, sink, bridge } = renderApp();
    await wait();
    stdin.write("\x0f"); // ctrl+o -> open
    await wait();
    expect(lastFrame() ?? "").toContain(PAGER_FOOTER);

    // An approval card lands mid-pager. Without the auto-close this soft-locks: the App useInput is
    // inactive (isActive: !pending) and <PendingCards> only mounts on the non-pager branch.
    bridge.push(ev({ type: "approval_requested", callId: "c1", toolName: "bash", summary: "rm -rf /tmp/x" }));
    await wait();

    expect(sink).toEqual([ENTER_ALT, LEAVE_ALT]); // auto-closed: escapes in order, terminal restored
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain(PAGER_FOOTER); // pager gone
    expect(frame).toContain("approve bash?"); // card mounted, visible, owning input
  });
});

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("Static freeze-cap across the alt-screen excursion (fix B)", () => {
  function renderApp() {
    const sink: string[] = [];
    const bridge = makeEventBridge();
    const client = fakeClient();
    const r = render(
      <App
        client={client}
        bridge={bridge}
        sessionId="s"
        cwd="/tmp"
        initialPolicy="ask"
        version="0.0.1"
        model="m"
        write={(s) => sink.push(s)}
      />,
    );
    return { ...r, sink, client, bridge };
  }

  test("a block committed while the pager is open is held out of Static (appears ONCE, in the pager), then flushes exactly once after close", async () => {
    const { stdin, lastFrame, bridge } = renderApp();
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "BEFORE-OPEN-LINE" }));
    await wait();

    stdin.write("\x0f"); // open pager
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "WHILE-OPEN-MARKER" }));
    await wait();

    // Debug-mode lastFrame = fullStaticOutput + dynamic output. Frozen Static must NOT have flushed
    // the new block (it would land in the alt buffer and be discarded on close) — so the marker
    // appears exactly ONCE: in the pager view. Twice would mean Static leaked it.
    let frame = lastFrame() ?? "";
    expect(frame).toContain(PAGER_FOOTER);
    expect(count(frame, "WHILE-OPEN-MARKER")).toBe(1);

    stdin.write("\x0f"); // close -> cap lifts in the same update, held items flush to Static
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).not.toContain(PAGER_FOOTER);
    expect(count(frame, "WHILE-OPEN-MARKER")).toBe(1); // flushed exactly once — no loss, no duplication
    expect(count(frame, "BEFORE-OPEN-LINE")).toBe(1); // pre-open content untouched
  });

  test("fix A auto-close also lifts the cap: a block committed mid-pager flushes once after the card takeover", async () => {
    const { stdin, lastFrame, bridge } = renderApp();
    await wait();
    stdin.write("\x0f"); // open
    await wait();
    bridge.push(ev({ type: "bg_task_output", taskId: "t", chunk: "MID-PAGER-NOTE" }));
    await wait();
    bridge.push(ev({ type: "approval_requested", callId: "c9", toolName: "bash", summary: "x" })); // auto-close
    await wait();

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain(PAGER_FOOTER);
    expect(frame).toContain("approve bash?");
    expect(count(frame, "MID-PAGER-NOTE")).toBe(1); // held block flushed exactly once on the auto-close
  });
});

describe("settledCount + CommittedTranscript staticCap (freeze-cap units, fix B)", () => {
  const note = (text: string): Block => ({ kind: "note", text });
  const read: Block = { kind: "tool", name: "read", argsJson: "{}", output: "x" };

  test("settledCount excludes a trailing open collapsible run and only ever grows as blocks append", () => {
    expect(settledCount([])).toBe(0);
    expect(settledCount([note("a")])).toBe(1);
    expect(settledCount([note("a"), read])).toBe(1); // trailing open run held back from Static
    expect(settledCount([note("a"), read, note("b")])).toBe(3); // note closes the run: collapsed + note
    // monotonic: appending blocks never lowers the settled count (the never-shrink invariant's source)
    const seq: Block[] = [note("a"), read, read, note("b"), read];
    let prev = 0;
    for (let i = 0; i <= seq.length; i++) {
      const n = settledCount(seq.slice(0, i));
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  test("staticCap holds later-settled items out of Static; lifting the cap flushes them (never re-emits the capped prefix)", async () => {
    const items: Block[] = [note("CAP-KEEP"), note("CAP-HELD")];
    const { lastFrame, rerender } = render(<CommittedTranscript items={items} staticCap={1} />);
    await wait();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("CAP-KEEP");
    expect(frame).not.toContain("CAP-HELD"); // beyond the cap — held back

    rerender(<CommittedTranscript items={items} staticCap={null} />);
    await wait();
    frame = lastFrame() ?? "";
    expect(count(frame, "CAP-KEEP")).toBe(1); // prefix not re-emitted
    expect(count(frame, "CAP-HELD")).toBe(1); // held item flushed exactly once
  });
});
