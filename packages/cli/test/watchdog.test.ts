import { describe, expect, test } from "bun:test";
import { isStalled, applyEvent, type WatchdogState } from "../src/watchdog";

function fresh(): WatchdogState { return { turnRunning: false, toolsInFlight: 0, approvalsPending: 0, lastEventAt: 0 }; }

describe("watchdog isStalled", () => {
  test("fires only when running, no tool in-flight, no approval pending, past threshold", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 1000);
    expect(isStalled(s, 1000, 5000)).toBe(false);        // just started
    expect(isStalled(s, 6001, 5000)).toBe(true);         // 5001ms of silence, running, idle
    applyEvent(s, { type: "tool_call" }, 7000);          // a tool is now in flight
    expect(isStalled(s, 99000, 5000)).toBe(false);       // never stalls while a tool runs
    applyEvent(s, { type: "tool_result" }, 8000);        // tool done
    expect(isStalled(s, 14001, 5000)).toBe(true);        // silent again → stalls
  });

  test("does not fire while an approval is pending", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "approval_requested" }, 100);
    expect(isStalled(s, 999999, 5000)).toBe(false);      // waiting on the user, not a stall
    applyEvent(s, { type: "approval_resolved" }, 200);
    expect(isStalled(s, 6000, 5000)).toBe(true);
  });

  test("does not fire after the turn completes", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "turn_completed" }, 100);
    expect(isStalled(s, 999999, 5000)).toBe(false);
  });
});
