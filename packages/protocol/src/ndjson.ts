const NL = 0x0a;

export function encodeLine(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg) + "\n");
}

/** Byte-accurate line splitter (safe across UTF-8 chunk boundaries). */
export class LineDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  constructor(private readonly maxLine = 8 * 1024 * 1024) {}

  push(chunk: Uint8Array): string[] {
    // TODO(perf): replace merge-copy with a growable buffer if multi-connection load warrants it (O(n²) for drip-fed near-limit lines).
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] === NL) {
        // Blank lines are skipped: NDJSON has no use for them in JSON-RPC and JSON.parse("") throws downstream.
        if (i > start) lines.push(this.decoder.decode(merged.subarray(start, i)));
        start = i + 1;
      }
    }
    this.buf = merged.subarray(start);
    if (this.buf.length > this.maxLine) {
      this.buf = new Uint8Array(0);
      throw new Error(`ndjson: line too long (> ${this.maxLine} bytes)`);
    }
    return lines;
  }
}
