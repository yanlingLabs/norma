import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Composer } from "../../src/tui/composer";
import { appendHistory } from "../../src/tui/history-store";

// useInput wires its stdin listener inside a React effect, which runs on the next tick after
// render() returns (not synchronously) — same caveat spike.test.tsx documents. A short wait after
// render() (before the first write) and after each write (to let the resulting state update flush
// into a new frame) keeps every assertion below deterministic.
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// T3 introduced an inverse-video cursor (`<Text inverse>`), which wraps its character in SGI escape
// codes (`\x1b[7m` ... `\x1b[27m`) even though the rest of the frame carries no color codes in this
// non-TTY test harness — same convention as flatten-blocks.test.ts's local stripAnsi helper.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const historyPath = (): string => join(mkdtempSync(join(tmpdir(), "norma-composer-")), "history.jsonl");

describe("Composer", () => {
  test("(a) type text + Enter while idle calls onSubmit once and clears the buffer", async () => {
    const submitted: string[] = [];
    const steered: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={(text) => steered.push(text)}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["hi"]);
    expect(steered).toEqual([]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("❯  "); // buffer cleared: prompt + inverse-space cursor
  });

  test("(b) type text + Enter while running calls onSteer, not onSubmit", async () => {
    const submitted: string[] = [];
    const steered: string[] = [];
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={(text) => steered.push(text)}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("go on");
    await wait();
    stdin.write("\r");
    await wait();

    expect(steered).toEqual(["go on"]);
    expect(submitted).toEqual([]);
  });

  test("(c) Esc while running calls onInterrupt", async () => {
    let interrupts = 0;
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("\x1b"); // esc
    await wait();

    expect(interrupts).toBe(1);
  });

  test("(c2) Esc while running still interrupts even with text in the buffer (precedence #1 wins)", async () => {
    let interrupts = 0;
    const { stdin } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => { interrupts += 1; }}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("some text");
    await wait();
    stdin.write("\x1b"); // esc — must interrupt, not enter double-esc-clear bookkeeping
    await wait();

    expect(interrupts).toBe(1);
  });

  test("(d) Shift+Tab calls onCyclePolicy", async () => {
    let cycles = 0;
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => { cycles += 1; }}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("\x1b[Z"); // shift+tab
    await wait();

    expect(cycles).toBe(1);
  });

  test("(e) disabled ignores typing and Enter", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        disabled
      />,
    );
    const before = lastFrame() ?? "";
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual([]);
    expect(lastFrame() ?? "").toBe(before);
  });

  test("(f) backspace edits the buffer", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x7f"); // backspace
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("❯ ab ");
  });

  test("(g) cursor position is reflected in the frame via the inverse-video character", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[D"); // left
    await wait();
    stdin.write("\x1b[D"); // left again — cursor now sits on "b" (index 1)
    await wait();

    // The character UNDER the cursor ("b") is wrapped in SGI inverse-video codes; "a" and "c" (on
    // either side) are not — this is the only way to observe cursor position in a rendered frame,
    // since before+at+after always reassembles to the same "abc" once ANSI codes are stripped.
    expect(lastFrame() ?? "").toContain("[7mb[27m");
  });

  test("(h) left/right/insert: typing mid-text inserts at the cursor, not at the end", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("ac");
    await wait();
    stdin.write("\x1b[D"); // left — cursor between "a" and "c"
    await wait();
    stdin.write("b");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["abc"]);
  });

  test("(h2) real Forward-Delete (ESC [3~) deletes the char AT the cursor", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[H"); // Home — cursor to 0, sitting on "a"
    await wait();
    stdin.write("\x1b[3~"); // Forward-Delete — removes "a", cursor stays put
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["bc"]);
  });

  test("(h3) ctrl+arrow word-jumps: edits land at both word boundaries end-to-end", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("foo bar");
    await wait();
    stdin.write("\x1b[1;5D"); // ctrl+left — word-left, cursor to the start of "bar" (index 4)
    await wait();
    stdin.write("X");
    await wait();
    stdin.write("\x1b[1;5C"); // ctrl+right — word-right, cursor past "Xbar" (end of text)
    await wait();
    stdin.write("!");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["foo Xbar!"]);
  });

  test("(i) Home/End/ctrl+a/ctrl+e move the cursor to the edges", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("bc");
    await wait();
    stdin.write("\x1b[H"); // Home (xterm) — cursor to 0
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("\x05"); // ctrl+e — End
    await wait();
    stdin.write("d");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["abcd"]);
  });

  test("(i2) raw End sequences (ESC [F xterm, ESC [4~ vt220) move the cursor to the end", async () => {
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("ab");
    await wait();
    stdin.write("\x1b[H"); // Home — cursor to 0
    await wait();
    stdin.write("\x1b[F"); // End (xterm) — cursor to end
    await wait();
    stdin.write("c");
    await wait();
    stdin.write("\x01"); // ctrl+a — Home again
    await wait();
    stdin.write("\x1b[4~"); // End (vt220) — cursor to end again
    await wait();
    stdin.write("d");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["abcd"]);
  });

  test("(j) history: ↑ recalls the newest entry, ↓ restores the in-progress draft", async () => {
    const path = historyPath();
    appendHistory(path, { display: "older prompt", ts: 1, sessionId: "s1" });
    appendHistory(path, { display: "newest prompt", ts: 2, sessionId: "s1" });

    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("my draft");
    await wait();
    stdin.write("\x1b[A"); // up — recalls "newest prompt", saving the draft
    await wait();
    stdin.write("\x1b[A"); // up again — walks to "older prompt"
    await wait();
    stdin.write("\x1b[B"); // down — back to "newest prompt"
    await wait();
    stdin.write("\x1b[B"); // down again — past the newest, restores the draft
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["my draft"]);
  });

  test("(k) history: ↑ alone recalls and submits the newest entry verbatim", async () => {
    const path = historyPath();
    appendHistory(path, { display: "recall me", ts: 1, sessionId: "s1" });

    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={path}
        sessionId="s1"
      />,
    );
    await wait();
    stdin.write("\x1b[A"); // up
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["recall me"]);
  });

  test("(l) double-esc clears the buffer within the window; a single esc only hints", async () => {
    const hints: string[] = [];
    const path = historyPath();
    const { stdin, lastFrame, rerender } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("clear me");
    await wait();
    stdin.write("\x1b"); // first esc — hints, does NOT clear
    await wait();

    expect(hints).toEqual(["Esc again to clear"]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("clear me");

    rerender(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1700} // 700ms later — within the 800ms window
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("\x1b"); // second esc within the window — clears
    await wait();

    expect(stripAnsi(lastFrame() ?? "")).toContain("❯  ");
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("clear me");
  });

  test("(m) esc outside the double-esc window does not clear (treated as a fresh first press)", async () => {
    const hints: string[] = [];
    const path = historyPath();
    const { stdin, lastFrame, rerender } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={1000}
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("still here");
    await wait();
    stdin.write("\x1b"); // first esc at t=1000
    await wait();

    rerender(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={2000} // 1000ms later — OUTSIDE the 800ms window
        historyPath={path}
        onHint={(h) => hints.push(h)}
      />,
    );
    await wait();
    stdin.write("\x1b"); // second esc, but too late — treated as a new first press
    await wait();

    expect(hints).toEqual(["Esc again to clear", "Esc again to clear"]);
    expect(stripAnsi(lastFrame() ?? "")).toContain("still here");
  });

  test("(n) running: only the prompt glyph dims — buffer text carries no dim code, and the FIRST content frame after empty is well-formed", async () => {
    const { stdin, lastFrame } = render(
      <Composer
        running
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
      />,
    );
    await wait();
    stdin.write("a"); // ONE char, asserted immediately — the Ink layout bug's trigger case is the
    await wait(); //     first content-growing render after empty (see composer.tsx render comment)

    const frame = lastFrame() ?? "";
    // Glyph dimmed, dim CLOSED before the buffer text, then the un-dimmed "a" and the inverse
    // cursor — the exact byte layout, so a whole-line dim (or a dim leak into the buffer) fails.
    expect(frame).toContain("\x1b[2m❯ \x1b[22ma\x1b[7m");
    // Well-formed frame: the prompt line is intact between the two border rules (the bug's failure
    // mode garbles the text across the border rows).
    const lines = (frame ?? "").split("\n").map(stripAnsi);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("❯ a ");
  });

  test("(o) onStateChange mirrors state on mount and on every edit (T5 — App's layout/exit-eligibility seam)", async () => {
    const seen: { text: string; cursor: number }[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onStateChange={(s) => seen.push({ ...s })}
      />,
    );
    await wait();
    expect(seen.at(0)).toEqual({ text: "", cursor: 0 }); // fired on mount

    stdin.write("hi");
    await wait();
    expect(seen.at(-1)).toEqual({ text: "hi", cursor: 2 });

    stdin.write("\r");
    await wait();
    expect(seen.at(-1)).toEqual({ text: "", cursor: 0 }); // cleared after submit
  });

  test("(p) Home/End on EMPTY text route to onScrollTop/onScrollBottom instead of the cursor ops (3c review item 2)", async () => {
    let tops = 0;
    let bottoms = 0;
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={() => {}}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onScrollTop={() => { tops += 1; }}
        onScrollBottom={() => { bottoms += 1; }}
      />,
    );
    await wait();
    stdin.write("\x1b[H"); // Home on empty -> scroll callback, not the (no-op) cursor op
    await wait();
    stdin.write("\x1b[4~"); // End (vt220 variant) on empty -> scroll callback too
    await wait();

    expect(tops).toBe(1);
    expect(bottoms).toBe(1);
  });

  test("(p2) Home/End with TEXT keep cursor semantics and NEVER fire the scroll callbacks", async () => {
    let scrolls = 0;
    const submitted: string[] = [];
    const { stdin } = render(
      <Composer
        running={false}
        policy="ask"
        onSubmit={(text) => submitted.push(text)}
        onSteer={() => {}}
        onInterrupt={() => {}}
        onCyclePolicy={() => {}}
        nowMs={0}
        historyPath={historyPath()}
        onScrollTop={() => { scrolls += 1; }}
        onScrollBottom={() => { scrolls += 1; }}
      />,
    );
    await wait();
    stdin.write("bc");
    await wait();
    stdin.write("\x1b[H"); // Home with text -> cursor to 0 (NOT a scroll)
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("\x1b[F"); // End with text -> cursor to end (NOT a scroll)
    await wait();
    stdin.write("d");
    await wait();
    stdin.write("\r");
    await wait();

    expect(scrolls).toBe(0);
    expect(submitted).toEqual(["abcd"]); // both edits landed at the cursor edges — ops still work
  });
});
