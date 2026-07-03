import { describe, expect, test } from "bun:test";
import { parsePlanResponse } from "../src/plan-response";

describe("parsePlanResponse", () => {
  test("1 → approve manual; 2 → approve auto; 3 <reason> → reject w/ feedback; other → reject w/ input as feedback", () => {
    expect(parsePlanResponse("1")).toEqual({ approved: true, autoAccept: false });
    expect(parsePlanResponse("2")).toEqual({ approved: true, autoAccept: true });
    expect(parsePlanResponse("3 needs error handling")).toEqual({ approved: false, autoAccept: false, feedback: "needs error handling" });
    expect(parsePlanResponse("3")).toEqual({ approved: false, autoAccept: false, feedback: undefined });
    expect(parsePlanResponse("no, revise the API part")).toEqual({ approved: false, autoAccept: false, feedback: "no, revise the API part" });
  });

  test("whitespace is trimmed before matching", () => {
    expect(parsePlanResponse("  1  ")).toEqual({ approved: true, autoAccept: false });
    expect(parsePlanResponse("  2  ")).toEqual({ approved: true, autoAccept: true });
    expect(parsePlanResponse("  3  ")).toEqual({ approved: false, autoAccept: false, feedback: undefined });
  });
});
