/** Minimal writable surface ConnWriter needs (Bun's TCP socket satisfies it). */
export interface WritableSocket {
  write(buf: Uint8Array): number;
  end(): void;
}

/**
 * Bounded outbound queue per connection (spec §5 backpressure).
 * Also handles Bun's per-write byte cap: partial writes are queued and
 * flushed on drain, so large frames are never silently truncated.
 * A consumer that can't keep up is disconnected — it resyncs from its last seq.
 */
export class ConnWriter {
  private queue: Uint8Array[] = [];
  private buffered = 0;
  private dead = false;

  constructor(private readonly socket: WritableSocket, private readonly capBytes = 4 * 1024 * 1024) {}

  get bufferedBytes(): number { return this.buffered; }

  enqueue(buf: Uint8Array): boolean {
    if (this.dead) return false;
    if (this.buffered === 0) {
      const n = this.socket.write(buf);
      if (n >= buf.length) return true;
      buf = buf.subarray(Math.max(0, n));
    }
    this.buffered += buf.length;
    this.queue.push(buf);
    if (this.buffered > this.capBytes) {
      this.dead = true;
      this.socket.end(); // slow consumer: disconnect, client resyncs from seq
      return false;
    }
    return true;
  }

  /** Wire to the socket's drain handler. */
  onDrain(): void {
    if (this.dead) return;
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      const n = this.socket.write(head);
      const written = Math.max(0, n);
      this.buffered -= written;
      if (written < head.length) {
        this.queue[0] = head.subarray(written);
        return; // still blocked; wait for next drain
      }
      this.queue.shift();
    }
  }
}
