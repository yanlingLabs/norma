import { describe, expect, test } from "bun:test";
import { streamAction } from "../src/stream-state";

describe("streamAction", () => {
  test("main-thread delta streams and enters streaming state", () => {
    expect(streamAction(false, { type: "assistant_delta", threadId: "main" })).toEqual({ action: "write_delta", streaming: true });
    expect(streamAction(true, { type: "assistant_delta", threadId: "main" })).toEqual({ action: "write_delta", streaming: true });
  });

  test("child-thread delta is ignored (CLI shows child output via its assistant_message)", () => {
    expect(streamAction(false, { type: "assistant_delta", threadId: "th_1" })).toEqual({ action: "none", streaming: false });
    expect(streamAction(true, { type: "assistant_delta", threadId: "th_1" })).toEqual({ action: "none", streaming: true });
  });

  test("assistant_message after streamed deltas just terminates the line (no duplicate text)", () => {
    expect(streamAction(true, { type: "assistant_message", threadId: "main" })).toEqual({ action: "swallow_final", streaming: false });
  });

  test("assistant_message without prior deltas prints in full (replay/resume path); child message mid-stream closes line first", () => {
    expect(streamAction(false, { type: "assistant_message", threadId: "main" })).toEqual({ action: "print_full", streaming: false });
    expect(streamAction(true, { type: "assistant_message", threadId: "th_1" })).toEqual({ action: "close_then_print_full", streaming: true });
    expect(streamAction(false, { type: "assistant_message", threadId: "th_1" })).toEqual({ action: "print_full", streaming: false });
  });

  test("any other event mid-stream closes the dangling line first (e.g. agent_error with partial text)", () => {
    expect(streamAction(true, { type: "agent_error", threadId: "main" })).toEqual({ action: "close_line", streaming: false });
    expect(streamAction(false, { type: "tool_call", threadId: "main" })).toEqual({ action: "none", streaming: false });
  });
});
