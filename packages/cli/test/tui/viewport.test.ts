/** Phase 3c Task 2 — pure scroll-state math for the windowed transcript line log (no Ink, no
 *  React: `ViewportState` is plain data, every transition here is a pure function over it).
 *
 *  Four functions under test:
 *   - `viewportSlice(lines, vp, viewH)` — the render-time slice: when `vp.stick` is true the
 *     window ALWAYS shows the last `viewH` lines (recomputed fresh from the CURRENT `lines.length`
 *     every call — this is what makes "stick" follow transcript growth without a separate scroll
 *     action); when not stuck, `vp.scrollTop` is clamped into `[0, max(0, len - viewH)]`.
 *   - `scrollBy(vp, delta, len, viewH)` — a manual scroll step. Clamps both ends. Per the brief:
 *     ANY upward delta (negative) unconditionally unsticks (even if the clamped result happens to
 *     land back on the max — e.g. when there's nothing to scroll); a non-negative delta re-sticks
 *     exactly when the clamped target reaches the max.
 *   - `scrollToTop` / `scrollToBottom` — jump helpers; `scrollToBottom` re-sticks unconditionally
 *     (`viewportSlice` then derives the real `scrollTop` from `stick`, so the `0` here is a inert
 *     placeholder, never read while `stick` is true).
 */
import { describe, expect, test } from "bun:test";
import { scrollBy, scrollToBottom, scrollToTop, viewportSlice, type ViewportState } from "../../src/tui/viewport";

const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `L${i}`);

describe("viewportSlice — stick follows growth", () => {
  test("stick=true shows the last viewH lines and recomputes scrollTop to match", () => {
    const vp: ViewportState = { scrollTop: 0, stick: true };
    const r1 = viewportSlice(lines(5), vp, 3);
    expect(r1.visible).toEqual(["L2", "L3", "L4"]);
    expect(r1.vp).toEqual({ scrollTop: 2, stick: true });

    // Content grows between renders (append-only transcript) — still stuck, so the window follows.
    const r2 = viewportSlice(lines(10), r1.vp, 3);
    expect(r2.visible).toEqual(["L7", "L8", "L9"]);
    expect(r2.vp).toEqual({ scrollTop: 7, stick: true });
  });

  test("stick=true with short content (len <= viewH) shows everything, scrollTop 0", () => {
    const r = viewportSlice(["a", "b"], { scrollTop: 0, stick: true }, 10);
    expect(r.visible).toEqual(["a", "b"]);
    expect(r.vp.scrollTop).toBe(0);
  });
});

describe("viewportSlice — non-stick clamps into [0, max(0, len - viewH)]", () => {
  test("negative scrollTop clamps to 0", () => {
    const r = viewportSlice(lines(10), { scrollTop: -100, stick: false }, 4);
    expect(r.vp.scrollTop).toBe(0);
    expect(r.visible).toEqual(["L0", "L1", "L2", "L3"]);
  });

  test("scrollTop past the end clamps to len - viewH", () => {
    const r = viewportSlice(lines(10), { scrollTop: 9999, stick: false }, 4);
    expect(r.vp.scrollTop).toBe(6); // 10 - 4
    expect(r.visible).toEqual(["L6", "L7", "L8", "L9"]);
  });

  test("short content (len <= viewH) pins scrollTop to 0 regardless of the stored value", () => {
    const r = viewportSlice(["a", "b"], { scrollTop: 5, stick: false }, 10);
    expect(r.vp.scrollTop).toBe(0);
    expect(r.visible).toEqual(["a", "b"]);
  });

  test("exact boundary: scrollTop already at max is unchanged, window is the tail slice", () => {
    const r = viewportSlice(lines(20), { scrollTop: 15, stick: false }, 5); // max = 15
    expect(r.vp.scrollTop).toBe(15);
    expect(r.visible).toEqual(["L15", "L16", "L17", "L18", "L19"]);
  });
});

describe("scrollBy — clamps both ends", () => {
  test("clamps below 0", () => {
    const vp = scrollBy({ scrollTop: 3, stick: false }, -100, 20, 5); // max = 15
    expect(vp.scrollTop).toBe(0);
  });

  test("clamps above max", () => {
    const vp = scrollBy({ scrollTop: 3, stick: false }, 9999, 20, 5); // max = 15
    expect(vp.scrollTop).toBe(15);
  });

  test("ordinary in-bounds step", () => {
    const vp = scrollBy({ scrollTop: 5, stick: false }, 3, 20, 5);
    expect(vp.scrollTop).toBe(8);
  });
});

describe("scrollBy — sticking rules", () => {
  test("reaching max on a downward step re-sticks", () => {
    const vp = scrollBy({ scrollTop: 10, stick: false }, 5, 20, 5); // 10+5=15=max
    expect(vp.scrollTop).toBe(15);
    expect(vp.stick).toBe(true);
  });

  test("a downward step that does NOT reach max stays unstuck", () => {
    const vp = scrollBy({ scrollTop: 0, stick: false }, 5, 20, 5); // 5 < max(15)
    expect(vp.scrollTop).toBe(5);
    expect(vp.stick).toBe(false);
  });

  test("any upward delta unsticks, even starting from stick=true", () => {
    const vp = scrollBy({ scrollTop: 15, stick: true }, -1, 20, 5);
    expect(vp.scrollTop).toBe(14);
    expect(vp.stick).toBe(false);
  });

  test("upward delta unsticks even when clamped result lands back on max (max=0 edge case)", () => {
    // len <= viewH => max is 0; an upward nudge from 0 stays at 0 but must still read as unstuck —
    // "any upward" is unconditional, not merely "moved away from max".
    const vp = scrollBy({ scrollTop: 0, stick: true }, -1, 3, 10);
    expect(vp.scrollTop).toBe(0);
    expect(vp.stick).toBe(false);
  });

  test("a zero delta re-clamps and re-sticks based on current position (no-op scroll)", () => {
    const atMax = scrollBy({ scrollTop: 15, stick: false }, 0, 20, 5);
    expect(atMax).toEqual({ scrollTop: 15, stick: true });
    const notAtMax = scrollBy({ scrollTop: 5, stick: false }, 0, 20, 5);
    expect(notAtMax).toEqual({ scrollTop: 5, stick: false });
  });
});

describe("scrollToTop / scrollToBottom", () => {
  test("scrollToTop always yields {scrollTop: 0, stick: false} regardless of input", () => {
    expect(scrollToTop({ scrollTop: 40, stick: true })).toEqual({ scrollTop: 0, stick: false });
    expect(scrollToTop({ scrollTop: 0, stick: false })).toEqual({ scrollTop: 0, stick: false });
  });

  test("scrollToBottom always yields stick:true (viewportSlice derives the real scrollTop)", () => {
    expect(scrollToBottom()).toEqual({ scrollTop: 0, stick: true });
  });

  test("integration: scrollToBottom() then viewportSlice recomputes the true bottom offset", () => {
    const vp = scrollToBottom();
    const r = viewportSlice(lines(30), vp, 6);
    expect(r.visible).toEqual(["L24", "L25", "L26", "L27", "L28", "L29"]);
    expect(r.vp.scrollTop).toBe(24);
  });
});
