/** Phase 3c Task 1 — the fullscreen shell SPIKE (the phase's de-risking gate). Proves, under vanilla
 *  Ink + ink-testing-library, that a root `<Box height={rows-1}>` containing a `flexGrow` region
 *  (clipped via Yoga's `overflow="hidden"`) plus a pinned bottom `<Text>BOTTOM</Text>` sibling:
 *   (a) pins BOTTOM to the last row even when content is far shorter than the viewport (empty-space
 *       pin — nothing pushes BOTTOM down/up unpredictably);
 *   (b) still pins BOTTOM to the last row, and still produces a frame no taller than `rows - 1`
 *       lines, when content vastly overflows the flexGrow region (100 lines against an ~18-row
 *       region) — the overflow must be clipped, not pushed past the root's fixed height;
 *   (c) re-renders at a new (smaller) `rows` prop and the whole frame shrinks to match.
 *
 *  ink-testing-library always renders in Ink's "debug" mode (see node_modules/ink-testing-library
 *  build/index.js: `debug: true` — full frame string every time, no throttling/log-update repaint
 *  path). That means these tests exercise the SAME `renderer.js`/`render-node-to-output.js` code that
 *  computes `outputHeight` for the real (non-debug) `outputHeight >= stdout.rows` clearTerminal gate
 *  in ink.js — so a frame line-count of exactly `rows - 1` here is real evidence about that gate's
 *  precondition, even though the gate itself (and its write-time behavior) isn't reached in debug
 *  mode. See the task report for the full source-level verdict on the real-terminal path. */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { ShellSpike } from "../../src/tui/shell-spike";

afterEach(cleanup);

function frameLines(frame: string | undefined): string[] {
  if (frame === undefined) throw new Error("lastFrame() returned undefined");
  return frame.split("\n");
}

describe("ShellSpike", () => {
  test("(a) 3 content lines + rows=20: BOTTOM pins to the last row of a (rows-1)-line frame", () => {
    const { lastFrame } = render(<ShellSpike rows={20} lines={["line-0", "line-1", "line-2"]} />);
    const lines = frameLines(lastFrame());
    expect(lines).toHaveLength(19); // rows - 1
    expect(lines.at(-1)).toBe("BOTTOM");
    expect(lines[0]).toBe("line-0");
    expect(lines[1]).toBe("line-1");
    expect(lines[2]).toBe("line-2");
  });

  test("(b) 100 content lines + rows=20: overflow is windowed to the tail — frame still rows-1 lines, still ends with BOTTOM", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<ShellSpike rows={20} lines={content} />);
    const lines = frameLines(lastFrame());
    expect(lines).toHaveLength(19); // rows - 1 EXACTLY — outputHeight is a hard invariant (review: <= would mask a frame-shrink regression)
    expect(lines.at(-1)).toBe("BOTTOM");
    // The visible region shows the TAIL of an overflowing list (last-in-view, like a live
    // transcript) — the head is truncated, not shrunk/distorted (see shell-spike.tsx's doc comment
    // for the two ways naive overflow clipping broke this before windowing was added).
    expect(lastFrame()).toContain("line-99");
    expect(lines).not.toContain("line-0");
  });

  test("(c) re-render with a smaller rows prop shrinks the frame accordingly", () => {
    const { lastFrame, rerender } = render(<ShellSpike rows={20} lines={["a", "b"]} />);
    expect(frameLines(lastFrame())).toHaveLength(19);

    rerender(<ShellSpike rows={10} lines={["a", "b"]} />);
    const shrunk = frameLines(lastFrame());
    expect(shrunk).toHaveLength(9); // rows - 1
    expect(shrunk.at(-1)).toBe("BOTTOM");
  });
});
