import { describe, expect, test } from "bun:test";
import { AbortAwaitProvider, GatedProvider, deferred } from "../../src/agent/test-providers";
import { setupEngine } from "./engine-steer.test";

describe("engine interrupt", () => {
  test("interrupt aborts a running turn → turn_completed(aborted)", async () => {
    const provider = new AbortAwaitProvider(); // streamTurn blocks until signal aborts
    const { engine, sessionId, events } = setupEngine(provider); // events = collected SessionEvents via a hub subscriber
    const turn = engine.runTurn(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.isRunning(sessionId)).toBe(true);
    const res = engine.interrupt(sessionId);
    expect(res.wasRunning).toBe(true);
    await turn;
    const completed = events.find((e) => e.type === "turn_completed");
    expect(completed?.stopReason).toBe("aborted");
    // the provider actually received an aborting signal:
    expect(provider.requests[0]!.signal?.aborted).toBe(true);
  });

  test("interrupt when idle → wasRunning:false, no throw", () => {
    const provider = new AbortAwaitProvider();
    const { engine, sessionId } = setupEngine(provider);
    expect(engine.interrupt(sessionId)).toEqual({ wasRunning: false });
  });

  test("abort wins over a queued steer: turn_completed(aborted), does not continue looping", async () => {
    // round 0 blocks on the gate (so we can steer + interrupt while it's in flight), then
    // yields done(aborted) once the signal fires — mirroring what the real providers do.
    const gate = deferred();
    const provider = new GatedProvider(
      [[{ type: "done", stopReason: "aborted" }]],
      [gate.promise],
    );
    const { engine, sessionId, events } = setupEngine(provider);
    const turn = engine.runTurn(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    engine.steer(sessionId, "one more thing"); // queued while round 0 is gated
    const res = engine.interrupt(sessionId);
    expect(res.wasRunning).toBe(true);
    gate.resolve(); // let round 0 finish with stopReason "aborted"
    await turn;
    // exactly one round: the pending steer must NOT cause the turn to continue looping.
    expect(provider.requests.length).toBe(1);
    const completed = events.find((e) => e.type === "turn_completed");
    expect(completed?.stopReason).toBe("aborted");
  });
});
