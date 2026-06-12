import { describe, expect, test } from "bun:test";
import { ConnWriter } from "../src/ipc/conn-writer";

function mockSocket(acceptBytes: number) {
  const accepted: number[] = [];
  let ended = false;
  return {
    accepted, get ended() { return ended; },
    write(buf: Uint8Array): number {
      const n = Math.min(acceptBytes, buf.length);
      accepted.push(n);
      return n;
    },
    end() { ended = true; },
    setAccept(n: number) { acceptBytes = n; },
  };
}

describe("ConnWriter", () => {
  test("writes through when the socket accepts everything", () => {
    const s = mockSocket(Infinity);
    const w = new ConnWriter(s, 1024);
    expect(w.enqueue(new Uint8Array(10))).toBe(true);
    expect(w.bufferedBytes).toBe(0);
  });

  test("buffers partial writes and flushes on drain", () => {
    const s = mockSocket(4);
    const w = new ConnWriter(s, 1024);
    w.enqueue(new Uint8Array(10)); // 4 accepted, 6 buffered
    expect(w.bufferedBytes).toBe(6);
    s.setAccept(Infinity);
    w.onDrain();
    expect(w.bufferedBytes).toBe(0);
  });

  test("queues subsequent writes while blocked, preserving order", () => {
    const s = mockSocket(0);
    const w = new ConnWriter(s, 1024);
    w.enqueue(new TextEncoder().encode("AAAA"));
    w.enqueue(new TextEncoder().encode("BBBB"));
    const flushed: string[] = [];
    s.setAccept(Infinity);
    const origWrite = s.write.bind(s);
    (s as any).write = (b: Uint8Array) => { flushed.push(new TextDecoder().decode(b)); return origWrite(b); };
    w.onDrain();
    expect(flushed.join("")).toBe("AAAABBBB");
    expect(w.bufferedBytes).toBe(0);
  });

  test("ends the connection when the buffer cap is exceeded", () => {
    const s = mockSocket(0); // accepts nothing
    const w = new ConnWriter(s, 16);
    w.enqueue(new Uint8Array(10));
    expect(s.ended).toBe(false);
    w.enqueue(new Uint8Array(10)); // 20 > 16 cap
    expect(s.ended).toBe(true);
    expect(w.enqueue(new Uint8Array(1))).toBe(false); // post-end writes refused
  });
});
