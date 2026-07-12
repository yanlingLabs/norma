import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { enterAltScreen, leaveAltScreen } from "../../src/tui/alt-screen";
import { PagerSpike } from "../../src/tui/pager-spike";

// Same caveat as spike.test.tsx / composer.test.tsx: useInput wires its stdin listener inside a
// React effect that runs on the next tick after render() returns, and state-driven re-renders need
// a tick to flush into a new frame. A short wait after render() and after each stdin.write keeps
// every assertion below deterministic.
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const LINES = Array.from({ length: 100 }, (_, i) => `seed-${String(i).padStart(3, "0")}`);

describe("alt-screen escape sequences", () => {
  test("(a) enterAltScreen/leaveAltScreen write the exact escape sequences to the injected sink", () => {
    const sink: string[] = [];
    enterAltScreen((s) => sink.push(s));
    leaveAltScreen((s) => sink.push(s));
    expect(sink).toEqual(["\x1b[?1049h\x1b[2J\x1b[H", "\x1b[?1049l"]);
  });
});

describe("PagerSpike", () => {
  test("(b) normal <-> pager toggle, with ↑/↓ windowing over 100 seeded lines", async () => {
    const { stdin, lastFrame } = render(<PagerSpike lines={LINES} write={() => {}} />);
    await wait();

    expect(lastFrame() ?? "").toContain("normal view");
    expect(lastFrame() ?? "").not.toContain("seed-000");

    stdin.write("\x0f"); // ctrl+o -> pager
    await wait();
    let frame = lastFrame() ?? "";
    expect(frame).not.toContain("normal view");
    expect(frame).toContain("seed-000");
    expect(frame).toContain("seed-009"); // default rows=10 -> offset 0..9
    expect(frame).not.toContain("seed-010");
    expect(frame).toContain("transcript"); // footer

    stdin.write("\x1b[A"); // up arrow at offset 0 clamps — no crash, no shift
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("seed-000");

    stdin.write("\x1b[B"); // down arrow -> offset 1
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("seed-000");
    expect(frame).toContain("seed-001");
    expect(frame).toContain("seed-010");

    stdin.write("\x1b[A"); // up arrow -> back to offset 0
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("seed-000");

    stdin.write("\x1b"); // esc -> normal
    await wait();
    frame = lastFrame() ?? "";
    expect(frame).toContain("normal view");
    expect(frame).not.toContain("seed-000");
  });

  test("(c) enter/leave sink calls bracket the mode-flip renders in order", async () => {
    const order: string[] = [];
    const seenAt = { enter: "", leave: "" };
    let getFrame: () => string = () => "";
    const write = (s: string) => {
      if (s === "\x1b[?1049h\x1b[2J\x1b[H") {
        order.push("enter");
        seenAt.enter = getFrame(); // frame as of the instant BEFORE the mode-flip commits
      } else if (s === "\x1b[?1049l") {
        order.push("leave");
        seenAt.leave = getFrame();
      }
    };
    const { stdin, lastFrame } = render(<PagerSpike lines={LINES} write={write} />);
    getFrame = () => lastFrame() ?? "";
    await wait();

    stdin.write("\x0f"); // ctrl+o -> pager
    await wait();
    expect(order).toEqual(["enter"]);
    expect(seenAt.enter).toContain("normal view"); // still normal at the moment `enter` fired
    expect(lastFrame() ?? "").toContain("seed-000"); // settled: pager view now showing

    stdin.write("\x1b"); // esc -> normal
    await wait();
    expect(order).toEqual(["enter", "leave"]);
    expect(seenAt.leave).toContain("seed-000"); // still pager at the moment `leave` fired
    expect(lastFrame() ?? "").toContain("normal view"); // settled: normal view restored
  });
});
