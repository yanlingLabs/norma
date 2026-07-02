/** Batches output pushes into coalesced flushes, capping total persisted bytes. */
export class OutputCoalescer {
  private buf = "";
  private flushed = 0;
  private truncated = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistCap: number;
  private readonly flushMs: number;

  constructor(private readonly onFlush: (chunk: string) => void, opts: { persistCap?: number; flushMs?: number } = {}) {
    this.persistCap = opts.persistCap ?? 256 * 1024;
    this.flushMs = opts.flushMs ?? 250;
  }

  push(s: string): void {
    if (this.truncated) return;
    this.buf += s;
    if (this.timer === null) {
      queueMicrotask(() => this.flush());
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.truncated || this.buf.length === 0) return;
    const chunk = this.buf;
    this.buf = "";
    if (this.flushed >= this.persistCap) return;
    this.onFlush(chunk);
    this.flushed += chunk.length;
    if (this.flushed >= this.persistCap) {
      this.truncated = true;
      this.onFlush("[output truncated]");
    }
  }

  dispose(): void {
    this.flush();
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
}
