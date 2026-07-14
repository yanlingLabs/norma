import { describe, expect, test } from "bun:test";
import { SettingsWatcher } from "../src/settings-watcher";

describe("SettingsWatcher", () => {
  test("a valid change triggers apply(prev, next) once after debounce", async () => {
    let fileContents = { reviewer: { enabled: true } } as any;
    let applied: any[] = [];
    let fire = () => {};
    const w = new SettingsWatcher({
      path: "/x",
      load: () => fileContents,
      apply: (p, n) => applied.push([p, n]),
      debounceMs: 5,
      watch: (_p, cb) => {
        fire = cb;
        return { close() {} };
      },
    });
    w.start({ reviewer: { enabled: false } } as any);
    fileContents = { reviewer: { enabled: true } };
    fire(); fire(); fire(); // burst → debounced to ONE apply
    await Bun.sleep(20);
    expect(applied.length).toBe(1);
    expect(applied[0][0]).toEqual({ reviewer: { enabled: false } }); // prev
    expect(applied[0][1]).toEqual({ reviewer: { enabled: true } }); // next
  });

  test("a parse failure keeps prev and does NOT call apply", async () => {
    let applied = 0;
    let fire = () => {};
    const w = new SettingsWatcher({
      path: "/x",
      load: () => {
        throw new Error("torn file");
      },
      apply: () => {
        applied++;
      },
      debounceMs: 5,
      watch: (_p, cb) => {
        fire = cb;
        return { close() {} };
      },
    });
    w.start({ reviewer: { enabled: false } } as any);
    fire();
    await Bun.sleep(20);
    expect(applied).toBe(0); // no swap on a bad file
  });

  test("stop() closes the watch and no further apply fires", async () => {
    let applied = 0;
    let fire = () => {};
    let closed = false;
    const w = new SettingsWatcher({
      path: "/x",
      load: () => ({ reviewer: { enabled: true } }) as any,
      apply: () => {
        applied++;
      },
      debounceMs: 5,
      watch: (_p, cb) => {
        fire = cb;
        return {
          close() {
            closed = true;
          },
        };
      },
    });
    w.start({ reviewer: { enabled: false } } as any);
    w.stop();
    expect(closed).toBe(true);
    fire();
    await Bun.sleep(20);
    expect(applied).toBe(0);
  });

  test("a throwing apply keeps prevSnapshot and does not crash", async () => {
    let fileContents = { v: 1 } as any;
    const applied: any[] = [];
    let throwNext = true;
    let fire = () => {};
    const w = new SettingsWatcher({
      path: "/x",
      load: () => fileContents,
      apply: (p, n) => {
        applied.push([p, n]);
        if (throwNext) {
          throwNext = false;
          throw new Error("apply boom");
        }
      },
      debounceMs: 5,
      watch: (_p, cb) => {
        fire = cb;
        return { close() {} };
      },
    });
    w.start({ v: 0 } as any);
    fileContents = { v: 1 };
    fire();
    await Bun.sleep(20); // apply threw once — must not reject/crash the test (no escaped throw)
    expect(applied.length).toBe(1);
    expect(applied[0][0]).toEqual({ v: 0 }); // prev was the boot snapshot

    // A subsequent good change: apply now succeeds. prev must STILL be the boot snapshot,
    // proving prevSnapshot did NOT advance past the failed apply (keep-last-good re-converges).
    fileContents = { v: 2 };
    fire();
    await Bun.sleep(20);
    expect(applied.length).toBe(2);
    expect(applied[1][0]).toEqual({ v: 0 }); // last-known-good, NOT { v: 1 }
    expect(applied[1][1]).toEqual({ v: 2 });
  });

  test("start() called twice does not leak / still applies once per change", async () => {
    let applied = 0;
    const handlers: { cb: () => void; closed: boolean }[] = [];
    const fire = (h: { cb: () => void; closed: boolean }) => {
      if (!h.closed) h.cb(); // models fs.watch: a closed handle never fires again
    };
    const w = new SettingsWatcher({
      path: "/x",
      load: () => ({ v: 1 }) as any,
      apply: () => {
        applied++;
      },
      debounceMs: 5,
      watch: (_p, cb) => {
        const h = { cb, closed: false };
        handlers.push(h);
        return {
          close() {
            h.closed = true;
          },
        };
      },
    });
    w.start({ v: 0 } as any);
    w.start({ v: 0 } as any); // double start — must not leak the first handle
    expect(handlers.length).toBe(2);
    const first = handlers[0]!;
    const second = handlers[1]!;
    expect(first.closed).toBe(true); // first handle closed by the re-arm guard
    expect(second.closed).toBe(false); // second handle is the live one
    fire(first); // stale handle → no-op (closed)
    fire(second); // live handle → one apply
    await Bun.sleep(20);
    expect(applied).toBe(1); // exactly one apply per change, no ghost from the leaked watcher

    w.stop();
    expect(second.closed).toBe(true);
    fire(second);
    await Bun.sleep(20);
    expect(applied).toBe(1); // stop() fully quiets it
  });
});
