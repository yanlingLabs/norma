/** Phase 3d Task 2 — `<CompletionMenu>`: a purely presentational popup list (no stdin listener of
 *  its own — key handling lives in the composer). Covers row rendering/selection styling, the
 *  ≤maxRows window that keeps `selected` visible as the list scrolls, and JS truncation to
 *  `columns` (never Yoga wrap — see the component's file doc for why that matters for
 *  `bottomBarRows`'s row-count math). */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CompletionMenu } from "../../src/tui/completion-menu";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `/cmd${i}`, hint: `desc ${i}` }));

describe("CompletionMenu", () => {
  test("renders 'label — hint' per row", () => {
    const { lastFrame } = render(
      <CompletionMenu items={[{ label: "/compact", hint: "Compact history" }]} selected={0} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("/compact — Compact history");
  });

  test("a label with no hint renders bare (no trailing ' — ')", () => {
    const { lastFrame } = render(<CompletionMenu items={[{ label: "/help" }]} selected={0} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/help");
    expect(frame).not.toContain("—");
  });

  test("empty items renders nothing", () => {
    const { lastFrame } = render(<CompletionMenu items={[]} selected={0} />);
    expect(lastFrame() ?? "").toBe("");
  });

  test("the selected row is inverse-video; others are not", () => {
    const { lastFrame } = render(
      <CompletionMenu items={[{ label: "/a" }, { label: "/b" }, { label: "/c" }]} selected={1} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    // Inverse SGR (\x1b[7m ... \x1b[27m) wraps only the selected row's label — other codes (the
    // accent color) may be interleaved, so match "somewhere in this line" rather than adjacency.
    expect(lines[0]).not.toContain("\x1b[7m");
    expect(lines[1]).toContain("\x1b[7m");
    expect(lines[1]).toContain("\x1b[27m");
    expect(lines[2]).not.toContain("\x1b[7m");
  });

  test("at most maxRows (default 6) rows are ever rendered", () => {
    const { lastFrame } = render(<CompletionMenu items={items(20)} selected={0} />);
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  test("a custom maxRows is honored", () => {
    const { lastFrame } = render(<CompletionMenu items={items(20)} selected={0} maxRows={3} />);
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
  });

  test("the window slides so `selected` stays visible near the end of a long list", () => {
    const { lastFrame } = render(<CompletionMenu items={items(20)} selected={19} maxRows={6} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/cmd19"); // last item, currently selected, must be shown
    expect(frame).not.toContain("/cmd0"); // far scrolled away
  });

  test("the window slides to keep `selected` visible in the middle of a long list too", () => {
    const { lastFrame } = render(<CompletionMenu items={items(20)} selected={10} maxRows={6} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/cmd10");
  });

  test("a row longer than `columns` is hard-truncated with an ellipsis, never wrapped", () => {
    const { lastFrame } = render(
      <CompletionMenu items={[{ label: "/add-dir", hint: "a very long description that will not fit" }]} selected={0} columns={20} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    const lines = frame.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // one row stays one physical line, not wrapped
    expect(lines[0]!.length).toBeLessThanOrEqual(20);
    expect(lines[0]).toContain("…");
  });
});
