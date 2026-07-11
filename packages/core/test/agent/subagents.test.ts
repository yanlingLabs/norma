import { describe, expect, test } from "bun:test";
import { SubagentManager } from "../../src/agent/subagents";

describe("SubagentManager", () => {
  test("never exceeds maxConcurrent; queue drains", async () => {
    const m = new SubagentManager({ maxConcurrent: 2, timeoutMs: 5000 });
    let inFlight = 0;
    let peak = 0;
    const task = () =>
      m.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return "x";
      });
    const res = await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(res.every((r) => r.ok)).toBe(true);
  });

  test("timeout → {ok:false}", async () => {
    const m = new SubagentManager({ timeoutMs: 20 });
    const r = await m.run(() => new Promise((res) => setTimeout(res, 1000)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timed out");
  });

  test("thrown fn → {ok:false} with message", async () => {
    const m = new SubagentManager({});
    const r = await m.run(async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("boom") });
  });

  test("thrown non-Error (e.g. a bare string) → {ok:false} with the stringified value, not \"undefined\"", async () => {
    const m = new SubagentManager({});
    const r = await m.run(async () => {
      throw "boom-string";
    });
    expect(r).toEqual({ ok: false, error: "boom-string" });
  });

  test("slot released on throw (a queued task still runs)", async () => {
    const m = new SubagentManager({ maxConcurrent: 1, timeoutMs: 5000 });
    const first = m.run(async () => {
      throw new Error("first fails");
    });
    const second = m.run(async () => "second ok");
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(false);
    expect(r2).toEqual({ ok: true, value: "second ok" });
  });

  // T3 review fix: nested-spawn semaphore reentrancy stall — a reentrant acquire (a thread
  // that already holds its own slot, re-entering to spawn a nested child) must fail fast
  // under saturation instead of queueing unbounded behind the full per-run timeoutMs (300s),
  // AND must not leak the slot it never got.
  describe("reentrant acquire (nested spawn saturation)", () => {
    test("a reentrant acquire under full saturation fails with the typed 'pool saturated' error within the bounded acquireTimeoutMs, not the (much longer) per-run timeoutMs", async () => {
      const m = new SubagentManager({ maxConcurrent: 1, timeoutMs: 5000, acquireTimeoutMs: 30 });
      // saturate the single slot with a long-running non-reentrant task that never releases
      // in time for the reentrant probe below
      const holder = m.run(() => new Promise((res) => setTimeout(() => res("holder done"), 2000)));

      const start = Date.now();
      const nested = await m.run(async () => "should never run", { reentrant: true });
      const elapsed = Date.now() - start;

      expect(nested.ok).toBe(false);
      if (!nested.ok) {
        expect(nested.error).toContain("pool saturated");
        expect(nested.error).toContain("nested");
      }
      // bounded by acquireTimeoutMs (30ms), nowhere near timeoutMs (5000ms)
      expect(elapsed).toBeLessThan(1000);

      const holderResult = await holder;
      expect(holderResult).toEqual({ ok: true, value: "holder done" });
    });

    test("no slot leak: after a reentrant give-up, the internal queue is empty and a subsequent acquire still hands the slot to a LIVE waiter", async () => {
      const m = new SubagentManager({ maxConcurrent: 1, timeoutMs: 5000, acquireTimeoutMs: 30 });
      let releaseHolder!: (v: string) => void;
      const holder = m.run(() => new Promise<string>((res) => { releaseHolder = res; }));

      // reentrant probe queues behind the holder, then gives up (spliced out of the queue)
      const nested = await m.run(async () => "nested", { reentrant: true });
      expect(nested.ok).toBe(false);

      // explicit per the review's own wording: "the internal queue is EMPTY" — not just
      // inferred from the live-waiter behavior below
      expect((m as unknown as { queue: unknown[] }).queue.length).toBe(0);

      // release the original holder's slot — if the timed-out reentrant resolver were still in
      // the queue (not spliced), release() would hand the slot to it instead of a live waiter,
      // and this next acquire would hang until ITS OWN timeoutMs elapsed (or forever).
      releaseHolder("holder done");
      await holder;

      const live = await m.run(async () => "live waiter got the slot");
      expect(live).toEqual({ ok: true, value: "live waiter got the slot" });
    });

    test("a NON-reentrant queued acquire is NOT prematurely timed out — it still waits for a real release, even past acquireTimeoutMs", async () => {
      const m = new SubagentManager({ maxConcurrent: 1, timeoutMs: 5000, acquireTimeoutMs: 20 });
      let releaseHolder!: (v: string) => void;
      const holder = m.run(() => new Promise<string>((res) => { releaseHolder = res; }));

      // queues (default, non-reentrant) behind the holder — must NOT be timed out by
      // acquireTimeoutMs even though we wait well past it before releasing
      const queued = m.run(async () => "queued eventually ran");
      await new Promise((r) => setTimeout(r, 100)); // well past acquireTimeoutMs (20ms)

      releaseHolder("holder done");
      const [holderResult, queuedResult] = await Promise.all([holder, queued]);
      expect(holderResult).toEqual({ ok: true, value: "holder done" });
      expect(queuedResult).toEqual({ ok: true, value: "queued eventually ran" });
    });
  });

  // 4h-ii-c: per-call `timeoutMs` override on run() — `undefined` (omitted) keeps the
  // constructor's own default; a positive number overrides it for THIS call only; `null` means
  // NO timer at all (task_stop/abort is the only way that call ever ends). The timeout
  // rejection itself is also now TYPED — `timedOut: true` on the result, additive, set ONLY on
  // the timer-fired path.
  describe("per-call timeoutMs override + typed timedOut (4h-ii-c)", () => {
    test("run(fn, {timeoutMs: 50}) with a slow fn rejects in ~50ms (the per-call override), NOT the constructor's much larger default, and the result is typed timedOut:true", async () => {
      const m = new SubagentManager({ timeoutMs: 300000 }); // constructor default stays huge
      const start = Date.now();
      const r = await m.run(() => new Promise((res) => setTimeout(res, 5000)), { timeoutMs: 50 });
      const elapsed = Date.now() - start;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("timed out");
        expect(r.timedOut).toBe(true);
      }
      expect(elapsed).toBeLessThan(1000); // bounded by the 50ms per-call override
    });

    test("run(fn, {timeoutMs: null}) never times out — resolves OK even when fn is slower than the constructor's own (small) default", async () => {
      const m = new SubagentManager({ timeoutMs: 50 }); // small constructor default
      const r = await m.run(() => new Promise((res) => setTimeout(() => res("done"), 150)), { timeoutMs: null });
      expect(r).toEqual({ ok: true, value: "done" });
    });

    test("a plain constructor-default timeout (no per-call opts) is ALSO typed timedOut:true — additive, not just the override path", async () => {
      const m = new SubagentManager({ timeoutMs: 20 });
      const r = await m.run(() => new Promise((res) => setTimeout(res, 1000)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.timedOut).toBe(true);
    });

    test("a non-timeout failure (thrown error) is NOT typed timedOut — the field stays absent", async () => {
      const m = new SubagentManager({});
      const r = await m.run(async () => {
        throw new Error("boom");
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.timedOut).toBeUndefined();
    });
  });
});
