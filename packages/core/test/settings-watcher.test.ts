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
});
