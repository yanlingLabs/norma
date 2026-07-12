import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Composer } from "../../src/tui/composer";

// useInput wires its stdin listener inside a React effect, which runs on the next tick after
// render() returns (not synchronously) — same caveat spike.test.tsx documents. A short wait after
// render() (before the first write) and after each write (to let the resulting state update flush
// into a new frame) keeps every assertion below deterministic.
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

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
      />,
    );
    await wait();
    stdin.write("hi");
    await wait();
    stdin.write("\r");
    await wait();

    expect(submitted).toEqual(["hi"]);
    expect(steered).toEqual([]);
    expect(lastFrame() ?? "").toContain("❯ ▌"); // buffer cleared after submit
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
      />,
    );
    await wait();
    stdin.write("\x1b"); // esc
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
      />,
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x7f"); // backspace
    await wait();

    expect(lastFrame() ?? "").toContain("❯ ab▌");
  });
});
