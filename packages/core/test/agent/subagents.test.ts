import { describe, expect, test } from "bun:test";
import { SubagentManager } from "../../src/agent/subagents";

describe("SubagentManager", () => {
  test("never exceeds maxConcurrent; queue drains", async () => {
    const m = new SubagentManager({ maxConcurrent: () => 2, stallTimeoutMs: () => 5000 });
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
    const m = new SubagentManager({ maxConcurrent: () => 1, stallTimeoutMs: () => 5000 });
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
  // under saturation instead of queueing unbounded behind however long the holder takes, AND
  // must not leak the slot it never got.
  describe("reentrant acquire (nested spawn saturation)", () => {
    test("a reentrant acquire under full saturation fails with the typed 'pool saturated' error within the bounded acquireTimeoutMs, not the holder's own (much longer) runtime", async () => {
      const m = new SubagentManager({ maxConcurrent: () => 1, stallTimeoutMs: () => 5000, acquireTimeoutMs: 30 });
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
      // bounded by acquireTimeoutMs (30ms), nowhere near the holder's 2000ms runtime
      expect(elapsed).toBeLessThan(1000);

      const holderResult = await holder;
      expect(holderResult).toEqual({ ok: true, value: "holder done" });
    });

    test("no slot leak: after a reentrant give-up, the internal queue is empty and a subsequent acquire still hands the slot to a LIVE waiter", async () => {
      const m = new SubagentManager({ maxConcurrent: () => 1, stallTimeoutMs: () => 5000, acquireTimeoutMs: 30 });
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
      // and this next acquire would hang until the reentrant caller's own give-up path resolved
      // (or forever).
      releaseHolder("holder done");
      await holder;

      const live = await m.run(async () => "live waiter got the slot");
      expect(live).toEqual({ ok: true, value: "live waiter got the slot" });
    });

    test("a NON-reentrant queued acquire is NOT prematurely timed out — it still waits for a real release, even past acquireTimeoutMs", async () => {
      const m = new SubagentManager({ maxConcurrent: () => 1, stallTimeoutMs: () => 5000, acquireTimeoutMs: 20 });
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
  // constructor's own configured wall clock (no-timeout task: itself off by default); a positive
  // number overrides it for THIS call only; `null` means NO timer at all for this call. The
  // timeout rejection itself is typed — `timedOut: true` on the result, additive, set ONLY on
  // the wall-clock timer's own rejection path (never on a stall, never on a thrown error).
  describe("per-call timeoutMs override + typed timedOut (4h-ii-c)", () => {
    test("run(fn, {timeoutMs: 50}) with a slow fn rejects in ~50ms (the per-call override), NOT the constructor's much larger configured clock, and the result is typed timedOut:true", async () => {
      const m = new SubagentManager({ timeoutMs: () => 300000, stallTimeoutMs: () => null }); // constructor default stays huge; stall disabled to isolate this test to the wall clock
      const start = Date.now();
      const r = await m.run(() => new Promise((res) => setTimeout(res, 5000)), { timeoutMs: 50 });
      const elapsed = Date.now() - start;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("timed out");
        expect(r.timedOut).toBe(true);
        expect(r.stalled).toBeUndefined();
      }
      expect(elapsed).toBeLessThan(1000); // bounded by the 50ms per-call override
    });

    test("run(fn, {timeoutMs: null}) never times out — resolves OK even when fn is slower than the constructor's own (small) configured clock", async () => {
      const m = new SubagentManager({ timeoutMs: () => 50, stallTimeoutMs: () => null }); // small constructor wall clock, stall disabled
      const r = await m.run(() => new Promise((res) => setTimeout(() => res("done"), 150)), { timeoutMs: null });
      expect(r).toEqual({ ok: true, value: "done" });
    });

    test("a plain constructor-configured wall clock (no per-call opts) is ALSO typed timedOut:true — additive, not just the override path", async () => {
      const m = new SubagentManager({ timeoutMs: () => 20, stallTimeoutMs: () => null });
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

  // No-default-wall-clock task (user rule 2026-07-12, CC parity): the old always-on 300s
  // NORMA_SUBAGENT_TIMEOUT_MS default is GONE — a subagent is no longer killed by a bare wall
  // clock unless one is explicitly configured. In its place: a resettable progress-STALL
  // watchdog, on by default (600000ms), that only fires on genuine INACTIVITY.
  describe("no default wall clock; progress-stall watchdog replaces it (CC parity)", () => {
    test("(a) no wall clock by default: a fn that runs ~400ms with NO progress pings, stall explicitly disabled, completes fine — nothing here ever arms a bare wall-clock timer", async () => {
      const m = new SubagentManager({ stallTimeoutMs: () => null }); // no timeoutMs configured at all; stall off too
      const start = Date.now();
      const r = await m.run(() => new Promise((res) => setTimeout(() => res("done"), 400)));
      const elapsed = Date.now() - start;
      expect(r).toEqual({ ok: true, value: "done" });
      expect(elapsed).toBeGreaterThanOrEqual(390); // ran its full course, nothing cut it short
    });

    test("(b) stall fires on genuine inactivity: 5 progress pings ~10ms apart, then silence — rejects with a typed stall error once the (short) stall window elapses with no further ping", async () => {
      const m = new SubagentManager({ stallTimeoutMs: () => 30 });
      const r = await m.run(async (_signal, progress) => {
        for (let i = 0; i < 5; i++) {
          await new Promise((res) => setTimeout(res, 10));
          progress();
        }
        // silence from here on — no more progress() calls; the fn itself never resolves except
        // via the stall watchdog aborting it
        await new Promise<never>(() => {});
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("stalled");
        expect(r.error).not.toContain("timed out");
        expect(r.stalled).toBe(true);
        expect(r.timedOut).toBeUndefined();
      }
    });

    test("(b-reset) pings genuinely RESET the window (not an absolute cap): pinging every ~10ms for 150ms total against a 30ms stall window completes fine", async () => {
      const m = new SubagentManager({ stallTimeoutMs: () => 30 });
      const r = await m.run(async (_signal, progress) => {
        for (let i = 0; i < 15; i++) {
          await new Promise((res) => setTimeout(res, 10));
          progress();
        }
        return "survived 150ms against a 30ms window because pings kept resetting it";
      });
      expect(r).toEqual({ ok: true, value: "survived 150ms against a 30ms window because pings kept resetting it" });
    });

    test("(c) hot knob: swapping a live stallTimeoutMs holder between runs changes the NEXT run's behavior, no pool reconstruction", async () => {
      let holder: number | null = 30;
      const m = new SubagentManager({ stallTimeoutMs: () => holder });
      // first run: 30ms window, silent fn well past it → stalls
      const first = await m.run(() => new Promise<never>(() => {}));
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.stalled).toBe(true);

      // widen the window live — the SAME manager instance, no reconstruction
      holder = 5000;
      const start = Date.now();
      const second = await m.run(() => new Promise((res) => setTimeout(() => res("done"), 100)));
      expect(second).toEqual({ ok: true, value: "done" });
      expect(Date.now() - start).toBeLessThan(1000);
    });

    test("(d) explicit constructor timeoutMs opt-in still enforces a genuine wall clock (getter-shaped, same as stallTimeoutMs)", async () => {
      const m = new SubagentManager({ timeoutMs: () => 50, stallTimeoutMs: () => null });
      const start = Date.now();
      const r = await m.run(() => new Promise((res) => setTimeout(res, 5000)));
      const elapsed = Date.now() - start;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("timed out after");
        expect(r.timedOut).toBe(true);
      }
      expect(elapsed).toBeLessThan(1000);
    });

    test("(e) stallTimeoutMs env fallback honored, and NaN-guarded against a malformed value", async () => {
      const original = process.env.NORMA_SUBAGENT_STALL_TIMEOUT_MS;
      try {
        process.env.NORMA_SUBAGENT_STALL_TIMEOUT_MS = "40";
        const m1 = new SubagentManager({}); // no getter at all — falls back to the env var
        const r1 = await m1.run(() => new Promise<never>(() => {}));
        expect(r1.ok).toBe(false);
        if (!r1.ok) expect(r1.stalled).toBe(true);

        process.env.NORMA_SUBAGENT_STALL_TIMEOUT_MS = "not-a-number";
        const m2 = new SubagentManager({});
        // NaN-guarded → falls back to the documented 600000 default, so a 100ms fn completes
        // fine (nowhere near either a bogus NaN timeout or the real 600s default).
        const r2 = await m2.run(() => new Promise((res) => setTimeout(() => res("done"), 100)));
        expect(r2).toEqual({ ok: true, value: "done" });
      } finally {
        if (original === undefined) delete process.env.NORMA_SUBAGENT_STALL_TIMEOUT_MS;
        else process.env.NORMA_SUBAGENT_STALL_TIMEOUT_MS = original;
      }
    });

    test("stall and wall-clock can coexist: whichever fires first wins, and the OTHER never fires afterward (no dangling timer/rejection)", async () => {
      const m = new SubagentManager({ timeoutMs: () => 5000, stallTimeoutMs: () => 30 });
      const r = await m.run(() => new Promise<never>(() => {})); // no progress → stall wins, well before the 5s wall clock
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.stalled).toBe(true);
        expect(r.timedOut).toBeUndefined();
        expect(r.error).toContain("stalled");
      }
    });
  });
});
