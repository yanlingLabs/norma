/** Phase 3c Task 1 — `makeSyncStdout` wraps every `write()` in BSU/ESU (`\x1b[?2026h ... \x1b[?2026l`,
 *  "begin/end synchronized update") so a terminal that understands the mode paints a whole Ink frame
 *  atomically instead of flickering through intermediate states. Everything else Ink reads off
 *  stdout (`columns`, `rows`, `isTTY`, `on`/`off` for the 'resize' event Ink itself subscribes to in
 *  its constructor) must forward to the REAL stream untouched — Ink literally does
 *  `this.options.stdout.columns`, `.rows`, `.on('resize', ...)` (see ink.js `calculateLayout`/
 *  constructor). We fake a minimal EventEmitter-based stream rather than touching real process.stdout
 *  so the test is deterministic and doesn't depend on the sandbox having a real TTY. */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { makeSyncStdout } from "../../src/tui/sync-stdout";

class FakeWriteStream extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  writes: unknown[][] = [];
  write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    this.writes.push([chunk, encoding, callback]);
    if (typeof encoding === "function") (encoding as () => void)();
    else if (typeof callback === "function") (callback as () => void)();
    return true;
  }
}

describe("makeSyncStdout", () => {
  test("write(chunk) wraps the string in BSU/ESU before forwarding to the real stream", () => {
    const real = new FakeWriteStream();
    const proxy = makeSyncStdout(real as unknown as NodeJS.WriteStream);
    proxy.write("hello");
    expect(real.writes).toHaveLength(1);
    expect(real.writes[0]![0]).toBe("\x1b[?2026hhello\x1b[?2026l");
  });

  test("write(chunk, callback) form: callback still gets invoked, chunk still wrapped", () => {
    const real = new FakeWriteStream();
    const proxy = makeSyncStdout(real as unknown as NodeJS.WriteStream);
    let called = false;
    proxy.write("hi", () => {
      called = true;
    });
    expect(real.writes[0]![0]).toBe("\x1b[?2026hhi\x1b[?2026l");
    expect(called).toBe(true);
  });

  test("write(chunk, encoding, callback) form: both args forwarded faithfully, chunk still wrapped", () => {
    const real = new FakeWriteStream();
    const proxy = makeSyncStdout(real as unknown as NodeJS.WriteStream);
    let called = false;
    proxy.write("hi", "utf8", () => {
      called = true;
    });
    expect(real.writes[0]![0]).toBe("\x1b[?2026hhi\x1b[?2026l");
    expect(real.writes[0]![1]).toBe("utf8");
    expect(called).toBe(true);
  });

  test("columns/rows/isTTY read through to the real stream", () => {
    const real = new FakeWriteStream();
    const proxy = makeSyncStdout(real as unknown as NodeJS.WriteStream);
    expect(proxy.columns).toBe(80);
    expect(proxy.rows).toBe(24);
    expect(proxy.isTTY).toBe(true);
    real.rows = 10;
    expect(proxy.rows).toBe(10); // live passthrough, not a stale snapshot
  });

  test("on/off forward to the real stream — a 'resize' listener attached via the proxy fires on the real stream's emit", () => {
    const real = new FakeWriteStream();
    const proxy = makeSyncStdout(real as unknown as NodeJS.WriteStream);
    let fired = 0;
    const handler = () => {
      fired++;
    };
    proxy.on("resize", handler);
    real.emit("resize");
    expect(fired).toBe(1);
    proxy.off("resize", handler);
    real.emit("resize");
    expect(fired).toBe(1); // off() removed it from the real stream too
  });
});
