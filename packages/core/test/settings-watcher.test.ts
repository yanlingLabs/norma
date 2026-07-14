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
      apply: (p, n) => {
        applied.push([p, n]);
      },
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

  test("a REJECTED async apply keeps prevSnapshot and does not crash", async () => {
    let fileContents = { v: 1 } as any;
    const applied: any[] = [];
    let rejectNext = true;
    let fire = () => {};
    const w = new SettingsWatcher({
      path: "/x",
      load: () => fileContents,
      apply: (p, n) => {
        applied.push([p, n]);
        if (rejectNext) {
          rejectNext = false;
          return Promise.reject(new Error("boom")); // async rejection, not a sync throw
        }
        return Promise.resolve();
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
    await Bun.sleep(20); // apply rejected once — the rejection must be caught, not escape
    expect(applied.length).toBe(1);
    expect(applied[0][0]).toEqual({ v: 0 });

    // Subsequent good change: apply now resolves. prev must STILL be the boot snapshot, proving
    // prevSnapshot did NOT advance past the failed ASYNC apply (keep-last-good re-converges).
    fileContents = { v: 2 };
    fire();
    await Bun.sleep(20);
    expect(applied.length).toBe(2);
    expect(applied[1][0]).toEqual({ v: 0 }); // last-known-good, NOT { v: 1 }
    expect(applied[1][1]).toEqual({ v: 2 });
  });

  test("prevSnapshot advances only AFTER the apply promise resolves", async () => {
    let fileContents = { v: 1 } as any;
    const applied: any[] = [];
    let applyCount = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fire = () => {};
    const w = new SettingsWatcher({
      path: "/x",
      load: () => fileContents,
      apply: (p, n) => {
        applied.push([p, n]);
        applyCount++;
        return applyCount === 1 ? gate : Promise.resolve(); // first apply blocks on the gate
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
    await Bun.sleep(20); // apply#1 is now in flight (pending on the gate), prev was { v: 0 }
    expect(applied.length).toBe(1);
    expect(applied[0][0]).toEqual({ v: 0 });

    // A change arriving while apply#1 is still pending: single-flighted, no new apply yet.
    fileContents = { v: 2 };
    fire();
    await Bun.sleep(20);
    expect(applied.length).toBe(1); // prevSnapshot has NOT advanced — the follow-up apply hasn't run

    // Resolve the gate → apply#1 completes → prevSnapshot advances to { v: 1 } → the coalesced
    // follow-up apply runs with prev = { v: 1 }, proving the advance happened AFTER the resolve.
    release();
    await Bun.sleep(20);
    expect(applied.length).toBe(2);
    expect(applied[1][0]).toEqual({ v: 1 }); // advanced only after apply#1 resolved
    expect(applied[1][1]).toEqual({ v: 2 });
  });

  test("overlapping changes during a slow apply are serialized + coalesced", async () => {
    let fileContents = { v: 1 } as any;
    const applied: any[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fire = () => {};
    const w = new SettingsWatcher({
      path: "/x",
      load: () => fileContents,
      apply: async (p, n) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent); // must NEVER exceed 1
        applied.push([p, n]);
        await gate; // slow apply — stays in flight until released
        concurrent--;
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
    await Bun.sleep(20); // apply A in flight (concurrent === 1)
    expect(applied.length).toBe(1);
    expect(maxConcurrent).toBe(1);

    // Two more changes arrive WHILE A is still in flight — must not start a second apply.
    fileContents = { v: 2 };
    fire();
    await Bun.sleep(20);
    fileContents = { v: 3 };
    fire();
    await Bun.sleep(20);
    expect(applied.length).toBe(1); // still only A — B and C coalesced, no overlap
    expect(maxConcurrent).toBe(1);

    // Release A → exactly ONE follow-up apply runs, reading the LATEST file ({ v: 3 }).
    release();
    await Bun.sleep(20);
    expect(applied.length).toBe(2); // not three — B and C collapsed into one follow-up
    expect(applied[1][1]).toEqual({ v: 3 }); // latest contents, not { v: 2 }
    expect(maxConcurrent).toBe(1); // apply never overlapped another
  });
});
