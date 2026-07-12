import { describe, expect, test } from "bun:test";
import {
  enterAltScreen,
  leaveAltScreen,
  enableMouseTracking,
  disableMouseTracking,
  parseMouseInput,
} from "../../src/tui/alt-screen";

// The PagerSpike (T1 scaffold) was removed in Phase 3b Task 7 once the real ctrl+o pager landed —
// its behavioral coverage (toggle, windowing, enter/leave ordering) moved into test/tui/pager.test.tsx,
// which drives the mechanism through the actual <App>. What stays here is the pure escape-sequence
// contract of alt-screen.ts, which the pager relies on verbatim.

describe("alt-screen escape sequences", () => {
  test("enterAltScreen/leaveAltScreen write the exact escape sequences to the injected sink", () => {
    const sink: string[] = [];
    enterAltScreen((s) => sink.push(s));
    leaveAltScreen((s) => sink.push(s));
    expect(sink).toEqual(["\x1b[?1049h\x1b[2J\x1b[H", "\x1b[?1049l"]);
  });
});

// Phase 3c Task 1 — SGR mouse-wheel tracking, added alongside the alt-screen buffer switch since the
// fullscreen shell wants scroll-wheel support the moment it owns the alternate screen.
describe("mouse tracking escape sequences", () => {
  test("enableMouseTracking/disableMouseTracking write the exact SGR mouse-mode escapes", () => {
    const sink: string[] = [];
    enableMouseTracking((s) => sink.push(s));
    disableMouseTracking((s) => sink.push(s));
    expect(sink).toEqual(["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
  });
});

describe("parseMouseInput", () => {
  test("wheel up: SGR button code 64", () => {
    expect(parseMouseInput("\x1b[<64;10;5M")).toEqual({ isMouse: true, wheel: { dir: "up" } });
  });

  test("wheel down: SGR button code 65", () => {
    expect(parseMouseInput("\x1b[<65;10;5M")).toEqual({ isMouse: true, wheel: { dir: "down" } });
  });

  test("wheel up/down recognized on button-release form too ('m' terminator)", () => {
    expect(parseMouseInput("\x1b[<64;1;1m")).toEqual({ isMouse: true, wheel: { dir: "up" } });
    expect(parseMouseInput("\x1b[<65;1;1m")).toEqual({ isMouse: true, wheel: { dir: "down" } });
  });

  test("other SGR mouse events (click/release/motion) are swallowed as mouse noise, no wheel", () => {
    expect(parseMouseInput("\x1b[<0;10;5M")).toEqual({ isMouse: true });
    expect(parseMouseInput("\x1b[<0;10;5m")).toEqual({ isMouse: true });
    expect(parseMouseInput("\x1b[<35;42;12M")).toEqual({ isMouse: true }); // motion
    expect(parseMouseInput("\x1b[<32;1;1M")).toEqual({ isMouse: true }); // drag
  });

  test("plain text input passes through untouched", () => {
    expect(parseMouseInput("a")).toEqual({ isMouse: false });
    expect(parseMouseInput("\r")).toEqual({ isMouse: false });
    expect(parseMouseInput("\x1b[A")).toEqual({ isMouse: false }); // arrow-up, not mouse
  });

  test("partial/truncated SGR sequences are not misclassified as mouse", () => {
    expect(parseMouseInput("\x1b[<64;10")).toEqual({ isMouse: false });
    expect(parseMouseInput("\x1b[<")).toEqual({ isMouse: false });
    expect(parseMouseInput("\x1b[64;10;5M")).toEqual({ isMouse: false }); // missing '<'
  });
});
