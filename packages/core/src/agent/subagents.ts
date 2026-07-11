/**
 * SubagentManager — a concurrency semaphore + FIFO queue + per-run timeout.
 *
 * `run()` never throws and never deadlocks: it always resolves to a typed
 * `SubagentResult<T>`, and the concurrency slot it acquires (if any — see
 * `reentrant` below) is always released (success, thrown error, or timeout)
 * via a `finally` block.
 */

export type SubagentResult<T> =
  | { ok: true; value: T }
  // 4h-ii-c: `timedOut` is additive and set ONLY on the timer-fired rejection path below — every
  // other failure (a thrown `fn`, pool saturation) leaves it absent, never `false`.
  | { ok: false; error: string; timedOut?: true };

export interface SubagentRunOptions {
  // 4h-i nested-spawn fix: true when the CALLING thread already holds its own concurrency
  // slot (engine.ts passes `opts.depth > 0`, i.e. this run() is a nested/grandchild spawn
  // re-entering acquire() while its own thread's slot is still held). A reentrant acquire
  // uses a BOUNDED wait (acquireTimeoutMs) instead of queueing unbounded — see acquire()'s
  // doc comment for why unbounded reentrant queueing can deadlock the whole pool. Omitted
  // (or false) → today's unbounded top-level-spawn queueing, unchanged.
  reentrant?: boolean;
  // 4h-ii-c: per-call override of the constructor's own `timeoutMs`. `undefined` (omitted) —
  // the default for every existing caller — keeps today's behavior exactly (the constructor's
  // `timeoutMs`, 300s unless overridden there). A positive number overrides it for THIS call
  // only. `null` means NO timer is ever set for this call: it can only end via `fn` itself
  // settling or its `AbortSignal` being aborted some OTHER way (e.g. a future task_stop) — never
  // by SubagentManager's own clock. Used by a detached `run_in_background` spawn (engine.ts),
  // which has no waiting parent to time out FOR.
  timeoutMs?: number | null;
}

/** Internal marker so run()'s catch block can distinguish ITS OWN timer-fired rejection (typed
 *  `timedOut: true` on the result) from any other rejection `fn` itself produces — including one
 *  whose message happens to also contain the substring "timed out". */
class SubagentTimeoutError extends Error {}

export class SubagentManager {
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(deps?: { maxConcurrent?: number; timeoutMs?: number; acquireTimeoutMs?: number }) {
    this.maxConcurrent = deps?.maxConcurrent ?? 4;
    this.timeoutMs = deps?.timeoutMs ?? Number(process.env.NORMA_SUBAGENT_TIMEOUT_MS ?? 300000);
    this.acquireTimeoutMs = deps?.acquireTimeoutMs ?? Number(process.env.NORMA_SUBAGENT_ACQUIRE_TIMEOUT_MS ?? 15000);
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
   * nested spawn) an unbounded reentrant wait deadlocks the whole pool for the full per-run
   * `timeoutMs` (300s) with no way out — worse, it starts THAT clock only after acquire()
   * would eventually resolve, so the real stall is 300s on top of however long the wait was.
   * On expiry the queued resolver is SPLICED out of `queue` (not merely marked dead) — this
   * is the critical part: `release()` must never hand the freed slot to an abandoned waiter
   * that will never itself call `release()`, which would permanently shrink effective
   * concurrency (a slot leak that never recovers).
   */
  private acquire(reentrant: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.active < this.maxConcurrent) {
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

  async run<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: SubagentRunOptions): Promise<SubagentResult<T>> {
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
      // constructor default, unchanged; `null` skips the timer entirely — see
      // SubagentRunOptions.timeoutMs's own doc comment.
      const effectiveTimeout = opts?.timeoutMs === undefined ? this.timeoutMs : opts.timeoutMs;
      const timer = effectiveTimeout === null ? undefined : setTimeout(() => ac.abort(), effectiveTimeout);
      try {
        const value = await Promise.race([
          fn(ac.signal),
          new Promise<never>((_, rej) => {
            ac.signal.addEventListener("abort", () => {
              rej(new SubagentTimeoutError(`timed out after ${Math.round(effectiveTimeout! / 1000)}s`));
            });
          }),
        ]);
        return { ok: true, value };
      } finally {
        // guard: no timer was ever set when effectiveTimeout is null (opts.timeoutMs: null) — a
        // bare clearTimeout(undefined) is harmless, but the guard documents the no-timer case.
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof SubagentTimeoutError) {
        return { ok: false, error: e.message, timedOut: true };
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.release();
    }
  }
}
