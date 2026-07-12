/** Phase 3b Task 7 — HARD CONSTRAINT 4: `cli-highlight`'s highlight.js writes to `console.error`
 *  on unknown languages; a stray stderr write in a raw-mode Ink screen corrupts the display. The
 *  App loads the highlighter through `loadSafeHighlighter`, which routes every highlight call
 *  through `suppressConsoleError` — console.error is a no-op FOR THE DURATION of the call and is
 *  always restored (finally), even if the call throws. */

import { describe, expect, test } from "bun:test";
import { suppressConsoleError, loadSafeHighlighter } from "../../src/tui/highlight-guard";

describe("suppressConsoleError", () => {
  test("console.error is a no-op DURING fn, restored to the original AFTER", () => {
    const original = console.error;
    let during: typeof console.error | undefined;
    const result = suppressConsoleError(() => {
      during = console.error;
      console.error("this must not reach the terminal"); // swallowed
      return 42;
    });
    expect(result).toBe(42);
    expect(during).not.toBe(original); // swapped while running
    expect(console.error).toBe(original); // restored after
  });

  test("restores console.error even when fn throws", () => {
    const original = console.error;
    expect(() => suppressConsoleError(() => { throw new Error("boom"); })).toThrow("boom");
    expect(console.error).toBe(original);
  });
});

describe("loadSafeHighlighter", () => {
  test("returns a highlighter that never throws and suppresses console.error during highlighting", async () => {
    const original = console.error;
    const hl = await loadSafeHighlighter();
    // An unknown language is exactly the case cli-highlight logs to console.error for — it must not
    // throw and must not leave console.error swapped out.
    const out = hl("const x = 1;", "this-is-not-a-real-language");
    expect(typeof out).toBe("string");
    expect(console.error).toBe(original);
  });
});
