import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Spike } from "../../src/tui/spike";

test("spike: Static committed lines + dynamic region render together", () => {
  const { lastFrame } = render(<Spike committed={["line-A", "line-B"]} live="LIVE-42" />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("line-A");
  expect(frame).toContain("line-B");
  expect(frame).toContain("LIVE-42");
});

test("spike: useInput handler is wired (stdin write reaches onKey)", async () => {
  let seen = "";
  const { stdin } = render(<Spike committed={[]} live="x" onKey={(s) => { seen = s; }} />);
  // useInput wires raw-mode + the stdin listener inside a React effect, which
  // runs on the next tick after render() returns (not synchronously). The
  // mock stdin from ink-testing-library does not replay a write that lands
  // before the listener is attached, so we must let effects flush first.
  await new Promise((r) => setTimeout(r, 0));
  stdin.write("z");
  await new Promise((r) => setTimeout(r, 10));
  expect(seen).toBe("z");
});
