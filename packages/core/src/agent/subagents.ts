/**
 * SubagentManager — a concurrency semaphore + FIFO queue + a progress-STALL watchdog.
 *
 * User rule (2026-07-12): subagents must NOT be killed by a default wall-clock timeout — a
 * legitimate laptop-wide scan died at the old 300s cap. CC parity (Claude Code has no wall-clock
 * subagent timeout at all): this manager now runs TWO independent timers, both configurable, only
 * one of which is on by default —
 *
 *  - `stallTimeoutMs` (ON by default, 600000ms / `NORMA_SUBAGENT_STALL_TIMEOUT_MS`, NaN-guarded):
 *    a RESETTABLE inactivity timer. `run(fn)` hands `fn` a `progress()` callback alongside its
 *    `AbortSignal` — every call clears + re-arms the timer. No progress for the WHOLE window →
 *    abort, reject with a typed `SubagentStallError` ("stalled: no progress for Ns"), never
 *    "timed out" (that wording is reserved for the wall clock below, so a caller can tell the two
 *    apart from the message alone). A long-running bash call produces no progress pings mid-run
 *    (bash streams no events between start and exit) — but bash enforces its OWN per-call
 *    timeout, so a silently-running-but-still-alive bash tool is bounded by THAT clock, not this
 *    one. This is why the stall default (600s) is pinned to bash's own max timeout: a bash call
 *    right at its own cap must still look "alive" to this watchdog for its full duration.
 *  - `timeoutMs` (OFF by default — this is the behavior change from the old always-on 300s
 *    clock): a plain wall clock that only exists when EXPLICITLY configured, via the
 *    constructor's own `timeoutMs` getter (settings.subagents.timeoutMs) or a per-call
 *    `run(fn, {timeoutMs})` override. Both timers can coexist; whichever fires first wins (aborts
 *    `fn`'s signal, rejects with its own typed error) — the other is cleared as a no-op.
 *
 * `run()` never throws and never deadlocks: it always resolves to a typed `SubagentResult<T>`,
 * and the concurrency slot it acquires (if any — see `reentrant` below) is always released
 * (success, thrown error, stall, or an explicit wall-clock timeout) via a `finally` block.
 */

export type SubagentResult<T> =
  | { ok: true; value: T }
  // 4h-ii-c: `timedOut` is additive and set ONLY on the wall-clock timer's own rejection path;
  // `stalled` (this task) is additive and set ONLY on the stall watchdog's own rejection path —
  // every other failure (a thrown `fn`, pool saturation) leaves BOTH absent, never `false`.
  | { ok: false; error: string; timedOut?: true; stalled?: true };

export interface SubagentRunOptions {
  // 4h-i nested-spawn fix: true when the CALLING thread already holds its own concurrency
  // slot (engine.ts passes `opts.depth > 0`, i.e. this run() is a nested/grandchild spawn
  // re-entering acquire() while its own thread's slot is still held). A reentrant acquire
  // uses a BOUNDED wait (acquireTimeoutMs) instead of queueing unbounded — see acquire()'s
  // doc comment for why unbounded reentrant queueing can deadlock the whole pool. Omitted
  // (or false) → today's unbounded top-level-spawn queueing, unchanged.
  reentrant?: boolean;
  // 4h-ii-c, semantics UNCHANGED by the no-timeout task: per-call override of the constructor's
  // own wall-clock `timeoutMs`. `undefined` (omitted) — the default for every existing caller —
  // falls back to the constructor's own `timeoutMs` getter, which itself now defaults to NO wall
  // clock (see this file's own header). A positive number arms a wall clock for THIS call only,
  // explicit opt-in even when the constructor has none configured. `null` explicitly forces no
  // wall clock for this call even if the constructor DOES have one configured. The stall
  // watchdog is entirely separate and always governed by the constructor's own `stallTimeoutMs`
  // getter — there is no per-call override for it.
  timeoutMs?: number | null;
}

/** Internal marker so run()'s catch block can distinguish ITS OWN wall-clock rejection (typed
 *  `timedOut: true` on the result) from any other rejection `fn` itself produces — including one
 *  whose message happens to also contain the substring "timed out". */
class SubagentTimeoutError extends Error {}

/** Internal marker for the stall (progress-inactivity) watchdog's own rejection — typed
 *  `stalled: true` on the result, kept distinct from SubagentTimeoutError so a caller can render
 *  "no progress" differently from an explicit wall-clock timeout. */
class SubagentStallError extends Error {}

export class SubagentManager {
  // hot-settings T2: was a plain boot-captured number; now an optional getter read fresh by
  // currentMaxConcurrent() on every acquire() — a later settings reload's new
  // subagents.maxConcurrent applies to the NEXT acquire() with no pool reconstruction. Absent
  // getter, or one resolving to undefined, keeps the SAME default (4) the pre-getter code had.
  private readonly maxConcurrentFn?: () => number | undefined;
  // No-timeout task: the wall clock is now getter-shaped (same hot-reload precedent as
  // maxConcurrentFn) AND has no built-in default — an absent getter, or one resolving to
  // undefined/null, means NO wall clock at all (the behavior change from the old always-on
  // 300s). Only an explicit positive number here (or via SubagentRunOptions.timeoutMs) arms it.
  private readonly timeoutMsFn?: () => number | null | undefined;
  // No-timeout task: the stall (progress-inactivity) watchdog's own live getter. `undefined` from
  // the getter (absent getter, or one resolving to undefined) falls back to the env-derived
  // default below; an explicit `null` or `0` disables stall protection entirely.
  private readonly stallTimeoutMsFn?: () => number | null | undefined;
  private readonly stallEnvDefault: number;
  private readonly acquireTimeoutMs: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(deps?: {
    maxConcurrent?: () => number | undefined;
    timeoutMs?: () => number | null | undefined;
    stallTimeoutMs?: () => number | null | undefined;
    acquireTimeoutMs?: number;
  }) {
    this.maxConcurrentFn = deps?.maxConcurrent;
    this.timeoutMsFn = deps?.timeoutMs;
    this.stallTimeoutMsFn = deps?.stallTimeoutMs;
    // NaN-guarded: a malformed env value (e.g. accidentally set to "") must not silently disable
    // the stall watchdog (Number("") is 0, Number("abc") is NaN — either would otherwise arm a
    // bogus near-zero or NaN timeout) — fall back to the documented 600000 default instead.
    const envStall = Number(process.env.NORMA_SUBAGENT_STALL_TIMEOUT_MS ?? 600000);
    this.stallEnvDefault = Number.isNaN(envStall) ? 600000 : envStall;
    this.acquireTimeoutMs = deps?.acquireTimeoutMs ?? Number(process.env.NORMA_SUBAGENT_ACQUIRE_TIMEOUT_MS ?? 15000);
  }

  /** Read fresh on every call — never cached at construction. Exposed (not just used internally
   *  by acquire()) so a test can assert a live settings-holder change is reflected without
   *  reconstructing the pool (hot-settings T2). */
  currentMaxConcurrent(): number {
    return this.maxConcurrentFn?.() ?? 4;
  }

  /** Effective stall window for the NEXT run() call — read fresh, never cached (same
   *  hot-reload contract as currentMaxConcurrent). `null` return means "disabled". */
  private currentStallTimeoutMs(): number | null {
    const v = this.stallTimeoutMsFn?.();
    if (v === undefined) return this.stallEnvDefault;
    if (v === null || v === 0) return null;
    return v;
  }

  /**
   * Resolves `true` once a concurrency slot is held. Resolves `false` ONLY for a `reentrant`
   * caller that gave up after `acquireTimeoutMs` without ever getting one.
   *
   * Non-reentrant (top-level, depth-0) callers queue UNBOUNDED, exactly as before this fix —
   * legitimately waiting behind long-running siblings (e.g. a 5th concurrent top-level spawn
   * when maxConcurrent is 4) is correct behavior, not a stall.
   *
   * Reentrant (nested, depth > 0) callers use a BOUNDED wait: the calling thread already
   * holds its OWN slot, so under saturation (every slot held by a thread itself blocked on a
   * nested spawn) an unbounded reentrant wait deadlocks the whole pool — with no way out since
   * nothing but a manual kill or the (no-longer-default) wall clock would ever unblock it. On
   * expiry the queued resolver is SPLICED out of `queue` (not merely marked dead) — this is the
   * critical part: `release()` must never hand the freed slot to an abandoned waiter that will
   * never itself call `release()`, which would permanently shrink effective concurrency (a slot
   * leak that never recovers).
   */
  private acquire(reentrant: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.active < this.currentMaxConcurrent()) {
        this.active++;
        resolve(true);
        return;
      }
      if (!reentrant) {
        this.queue.push(() => resolve(true));
        return;
      }
      // Reentrant + saturated: bounded wait. `settled` arbitrates the two ways this can end —
      // release() calling `entry()` first (normal hand-off), or the timer firing first
      // (give-up); whichever happens first wins and the other becomes a no-op.
      let settled = false;
      const entry = (): void => {
        if (settled) return; // timer already fired + spliced this out — do not consume a slot
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return; // release() already handed this waiter its slot
        settled = true;
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1); // CRITICAL: prevents the slot leak — see doc above
        resolve(false);
      }, this.acquireTimeoutMs);
      this.queue.push(entry);
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  async run<T>(fn: (signal: AbortSignal, progress: () => void) => Promise<T>, opts?: SubagentRunOptions): Promise<SubagentResult<T>> {
    const acquired = await this.acquire(opts?.reentrant ?? false);
    if (!acquired) {
      // Reentrant give-up: no slot was ever taken, so there is nothing for a `finally` to
      // release — return directly, matching the shape of every other typed failure below.
      return {
        ok: false,
        error: "subagent pool saturated — too many nested/concurrent subagents; reduce fan-out or nesting",
      };
    }
    try {
      const ac = new AbortController();
      // 4h-ii-c: `undefined` opts.timeoutMs (every pre-existing caller) resolves to the
      // constructor's own getter (no-timeout task: itself defaulting to `null`, i.e. no wall
      // clock at all); `null` skips the timer entirely — see SubagentRunOptions.timeoutMs's own
      // doc comment.
      const effectiveTimeout = opts?.timeoutMs === undefined ? (this.timeoutMsFn?.() ?? null) : opts.timeoutMs;
      const stallMs = this.currentStallTimeoutMs();
      // Set by whichever timer actually fires, read by the single shared abort listener below —
      // `ac` can only ever be aborted by one of these two timers (fn only ever sees `ac.signal`,
      // a read-only view; it has no way to call `ac.abort()` itself), so this is exhaustive.
      let cause: "timeout" | "stall" | undefined;

      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStall = () => {
        if (stallMs === null) return; // disabled — no-op, `progress()` becomes a harmless no-op too
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => { cause = "stall"; ac.abort(); }, stallMs);
      };
      armStall(); // arm on entry — a fn that never calls progress() at all is still covered
      const progress = () => armStall();

      const wallTimer = effectiveTimeout === null
        ? undefined
        : setTimeout(() => { cause = "timeout"; ac.abort(); }, effectiveTimeout);

      try {
        const value = await Promise.race([
          fn(ac.signal, progress),
          new Promise<never>((_, rej) => {
            ac.signal.addEventListener("abort", () => {
              if (cause === "stall") rej(new SubagentStallError(`stalled: no progress for ${Math.round(stallMs! / 1000)}s`));
              else rej(new SubagentTimeoutError(`timed out after ${Math.round((effectiveTimeout ?? 0) / 1000)}s`));
            });
          }),
        ]);
        return { ok: true, value };
      } finally {
        // guard: a timer may never have been armed (stallMs/effectiveTimeout null) — a bare
        // clearTimeout(undefined) is harmless, but the guard documents the no-timer case.
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        if (wallTimer !== undefined) clearTimeout(wallTimer);
      }
    } catch (e) {
      if (e instanceof SubagentStallError) return { ok: false, error: e.message, stalled: true };
      if (e instanceof SubagentTimeoutError) return { ok: false, error: e.message, timedOut: true };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.release();
    }
  }
}
