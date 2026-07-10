/**
 * SubagentManager — a concurrency semaphore + FIFO queue + per-run timeout.
 *
 * `run()` never throws and never deadlocks: it always resolves to a typed
 * `SubagentResult<T>`, and the concurrency slot it acquires (if any — see
 * `reentrant` below) is always released (success, thrown error, or timeout)
 * via a `finally` block.
 */

export type SubagentResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SubagentRunOptions {
  // 4h-i nested-spawn fix: true when the CALLING thread already holds its own concurrency
  // slot (engine.ts passes `opts.depth > 0`, i.e. this run() is a nested/grandchild spawn
  // re-entering acquire() while its own thread's slot is still held). A reentrant acquire
  // uses a BOUNDED wait (acquireTimeoutMs) instead of queueing unbounded — see acquire()'s
  // doc comment for why unbounded reentrant queueing can deadlock the whole pool. Omitted
  // (or false) → today's unbounded top-level-spawn queueing, unchanged.
  reentrant?: boolean;
}

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
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const value = await Promise.race([
          fn(ac.signal),
          new Promise<never>((_, rej) => {
            ac.signal.addEventListener("abort", () => {
              rej(new Error(`timed out after ${Math.round(this.timeoutMs / 1000)}s`));
            });
          }),
        ]);
        return { ok: true, value };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.release();
    }
  }
}
