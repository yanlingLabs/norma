/**
 * SubagentManager — a concurrency semaphore + FIFO queue + per-run timeout.
 *
 * `run()` never throws and never deadlocks: it always resolves to a typed
 * `SubagentResult<T>`, and the concurrency slot it acquires is always
 * released (success, thrown error, or timeout) via a `finally` block.
 */

export type SubagentResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class SubagentManager {
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(deps?: { maxConcurrent?: number; timeoutMs?: number }) {
    this.maxConcurrent = deps?.maxConcurrent ?? 4;
    this.timeoutMs = deps?.timeoutMs ?? Number(process.env.NORMA_SUBAGENT_TIMEOUT_MS ?? 300000);
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.active < this.maxConcurrent) {
        this.active++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
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

  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<SubagentResult<T>> {
    await this.acquire();
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
