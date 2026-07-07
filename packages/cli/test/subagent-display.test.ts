import { describe, expect, test } from "bun:test";
import { anySubagentAlive, subagentGlyph, subagentLabel, subagentTokens } from "../src/subagent-display";

describe("subagentGlyph", () => {
  test("statuses", () => {
    expect(subagentGlyph("queued")).toBe("◌");
    expect(subagentGlyph("working")).toBe("●");
    expect(subagentGlyph("done")).toBe("✓");
    expect(subagentGlyph("weird")).toBe("◌");
  });
});

describe("subagentLabel", () => {
  test("description wins when non-empty", () => {
    expect(subagentLabel("explore auth module", "long prompt here")).toBe("explore auth module");
    expect(subagentLabel("  padded  ", "p")).toBe("padded");
  });
  test("falls back to prompt first line, 40-char cap with ellipsis", () => {
    expect(subagentLabel(undefined, "short prompt")).toBe("short prompt");
    expect(subagentLabel("", "first line\nsecond line")).toBe("first line");
    expect(subagentLabel("   ", "x".repeat(45))).toBe("x".repeat(39) + "…");
    expect(subagentLabel(undefined, "x".repeat(40))).toBe("x".repeat(40)); // exactly 40 fits
  });
});

describe("anySubagentAlive", () => {
  test("alive iff any status != done", () => {
    expect(anySubagentAlive([])).toBe(false);
    expect(anySubagentAlive(["done", "done"])).toBe(false);
    expect(anySubagentAlive(["done", "queued"])).toBe(true);
    expect(anySubagentAlive(["working"])).toBe(true);
  });
});

describe("subagentTokens (TS-only: CLI shows the arrows)", () => {
  test("empty until anything is known", () => {
    expect(subagentTokens(undefined, 0, 0)).toBe("");
  });
  test("down-only while input unknown; live chars estimate at chars/4 (ceil)", () => {
    expect(subagentTokens(undefined, 0, 9)).toBe("↓ 3");
    expect(subagentTokens(undefined, 842, 0)).toBe("↓ 842");
  });
  test("both arrows once input known; banked + live estimate; formatTokens units", () => {
    expect(subagentTokens(12300, 4100, 0)).toBe("↑ 12.3k ↓ 4.1k");
    expect(subagentTokens(1000, 100, 8)).toBe("↑ 1.0k ↓ 102");
  });
});
