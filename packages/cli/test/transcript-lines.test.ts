import { describe, expect, test } from "bun:test";
import { BLUE, DIM, GREEN, RESET, agentFinishLines, agentSpawnLine, turnSummaryLine } from "../src/task-block";

describe("agentSpawnLine", () => {
  test("exact ANSI: blue dot, plain Agent(label), dim agentType", () => {
    expect(agentSpawnLine("Fix the bug", "general-purpose")).toBe(
      `${BLUE}●${RESET} Agent(Fix the bug) ${DIM}general-purpose${RESET}`,
    );
  });
});

describe("agentFinishLines", () => {
  test("with tool calls: two lines — green dot + dim finished summary, then dim tool-call count", () => {
    expect(agentFinishLines("Fix the bug", 123000, 7)).toEqual([
      `${GREEN}●${RESET} ${DIM}Agent "Fix the bug" finished · 2m 3s${RESET}`,
      `${DIM}⎿ Ran 7 tool calls${RESET}`,
    ]);
  });

  test("zero tool calls: second line omitted", () => {
    expect(agentFinishLines("Fix the bug", 14000, 0)).toEqual([
      `${GREEN}●${RESET} ${DIM}Agent "Fix the bug" finished · 14s${RESET}`,
    ]);
  });
});

describe("turnSummaryLine", () => {
  test("exact ANSI: dim-wrapped summary with elapsed + up/down tokens", () => {
    expect(turnSummaryLine("Worked", 123000, 1200, 842)).toBe(
      `${DIM}✳ Worked for 2m 3s · ↑ 1.2k ↓ 842 tokens${RESET}`,
    );
  });
});
