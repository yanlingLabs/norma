import { describe, expect, test } from "bun:test";
import { enterAltScreen, leaveAltScreen } from "../../src/tui/alt-screen";

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
