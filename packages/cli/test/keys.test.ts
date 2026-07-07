import { describe, expect, test } from "bun:test";
import type { FooterSelection } from "../src/task-block";
import { decodeKey, footerKeyAction } from "../src/keys";

function sel(selectedThreadId: string, focusIndex: number | null): FooterSelection {
  return { selectedThreadId, focusIndex };
}

describe("decodeKey", () => {
  test("recognizes all five control sequences", () => {
    expect(decodeKey("\x1b")).toBe("esc");
    expect(decodeKey("\x1b[A")).toBe("up");
    expect(decodeKey("\x1b[B")).toBe("down");
    expect(decodeKey("\r")).toBe("enter");
    expect(decodeKey("\n")).toBe("enter");
    expect(decodeKey("\x1b[Z")).toBe("shiftTab");
  });

  test("a plain printable char (or anything else) is other", () => {
    expect(decodeKey("a")).toBe("other");
    expect(decodeKey("")).toBe("other");
    expect(decodeKey("\x1b[C")).toBe("other"); // right arrow — not a recognized sequence
    expect(decodeKey("\x1b[")).toBe("other"); // truncated/garbled escape
  });

  test("Buffer input normalizes the same as the equivalent string", () => {
    expect(decodeKey(Buffer.from("\x1b"))).toBe("esc");
    expect(decodeKey(Buffer.from("\x1b[A"))).toBe("up");
    expect(decodeKey(Buffer.from("\x1b[B"))).toBe("down");
    expect(decodeKey(Buffer.from("\r"))).toBe("enter");
    expect(decodeKey(Buffer.from("\n"))).toBe("enter");
    expect(decodeKey(Buffer.from("\x1b[Z"))).toBe("shiftTab");
    expect(decodeKey(Buffer.from("a"))).toBe("other");
  });
});

describe("footerKeyAction — focus null (footer not focused)", () => {
  const rowThreadIds = ["main", "th_1", "th_2"];

  test("down enters focus", () => {
    expect(footerKeyAction("down", sel("main", null), rowThreadIds)).toEqual({ kind: "focusFooter" });
  });

  test("down enters focus regardless of rowThreadIds contents (caller seeds the starting index — see keys.ts doc comment)", () => {
    expect(footerKeyAction("down", sel("th_1", null), [])).toEqual({ kind: "focusFooter" });
    expect(footerKeyAction("down", sel("nonexistent", null), rowThreadIds)).toEqual({ kind: "focusFooter" });
  });

  test("esc interrupts (the ONLY place esc means interrupt)", () => {
    expect(footerKeyAction("esc", sel("main", null), rowThreadIds)).toEqual({ kind: "interrupt" });
  });

  test("shiftTab cycles policy", () => {
    expect(footerKeyAction("shiftTab", sel("main", null), rowThreadIds)).toEqual({ kind: "cyclePolicy" });
  });

  test("everything else — up, enter, other — is a no-op", () => {
    expect(footerKeyAction("up", sel("main", null), rowThreadIds)).toEqual({ kind: "none" });
    expect(footerKeyAction("enter", sel("main", null), rowThreadIds)).toEqual({ kind: "none" });
    expect(footerKeyAction("other", sel("main", null), rowThreadIds)).toEqual({ kind: "none" });
  });

  test("enter with focusIndex null must not throw — returns none (defensive; shouldn't happen in practice)", () => {
    expect(() => footerKeyAction("enter", sel("main", null), rowThreadIds)).not.toThrow();
    expect(footerKeyAction("enter", sel("main", null), rowThreadIds)).toEqual({ kind: "none" });
  });
});

describe("footerKeyAction — focus active (selection.focusIndex is a number)", () => {
  const rowThreadIds = ["main", "th_1", "th_2"];

  test("up/down move focus, clamped to [0, rows-1] at both ends", () => {
    expect(footerKeyAction("up", sel("main", 1), rowThreadIds)).toEqual({ kind: "moveFocus", index: 0 });
    expect(footerKeyAction("down", sel("main", 1), rowThreadIds)).toEqual({ kind: "moveFocus", index: 2 });
    // clamp at the top: already at row 0, up stays put
    expect(footerKeyAction("up", sel("main", 0), rowThreadIds)).toEqual({ kind: "moveFocus", index: 0 });
    // clamp at the bottom: already at the last row, down stays put
    expect(footerKeyAction("down", sel("th_2", 2), rowThreadIds)).toEqual({ kind: "moveFocus", index: 2 });
  });

  test("enter selects the thread at focusIndex", () => {
    expect(footerKeyAction("enter", sel("main", 0), rowThreadIds)).toEqual({ kind: "select", threadId: "main" });
    expect(footerKeyAction("enter", sel("main", 1), rowThreadIds)).toEqual({ kind: "select", threadId: "th_1" });
    expect(footerKeyAction("enter", sel("main", 2), rowThreadIds)).toEqual({ kind: "select", threadId: "th_2" });
  });

  test("esc EXITS FOCUS, never interrupts — the modal guard (pinned both directions vs. focus-null esc=interrupt above)", () => {
    expect(footerKeyAction("esc", sel("main", 0), rowThreadIds)).toEqual({ kind: "exitFocus" });
    expect(footerKeyAction("esc", sel("th_1", 1), rowThreadIds)).toEqual({ kind: "exitFocus" });
    expect(footerKeyAction("esc", sel("main", 0), rowThreadIds)).not.toEqual({ kind: "interrupt" });
  });

  test("shiftTab cycles policy the same as when unfocused", () => {
    expect(footerKeyAction("shiftTab", sel("main", 1), rowThreadIds)).toEqual({ kind: "cyclePolicy" });
  });

  test("any other/unrecognized key falls through and exits focus", () => {
    expect(footerKeyAction("other", sel("main", 1), rowThreadIds)).toEqual({ kind: "exitFocus" });
  });

  test("rowThreadIds empty (footer gone mid-focus) — ANY key exits focus safely, no throw", () => {
    const empty: string[] = [];
    const keys = ["up", "down", "enter", "esc", "shiftTab", "other"] as const;
    for (const key of keys) {
      expect(() => footerKeyAction(key, sel("main", 0), empty)).not.toThrow();
      expect(footerKeyAction(key, sel("main", 0), empty)).toEqual({ kind: "exitFocus" });
    }
  });

  test("enter at an out-of-range focusIndex (defensive — shouldn't happen, but must not throw or emit a malformed select)", () => {
    expect(() => footerKeyAction("enter", sel("main", 5), rowThreadIds)).not.toThrow();
    expect(footerKeyAction("enter", sel("main", 5), rowThreadIds)).toEqual({ kind: "none" });
  });
});
