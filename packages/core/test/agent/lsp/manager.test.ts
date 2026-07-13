import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { LspClient } from "../../../src/agent/lsp/client";
import { LspManager, LspSpawnError, languageForPath, type LspLanguage, type LspScheduler } from "../../../src/agent/lsp/manager";

const FIXTURE = join(import.meta.dir, "fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };
const isMac = process.platform === "darwin";

/** Manual scheduler: captures every armed timer by handle so a test can fire ANY of them (or
 *  all) deterministically, with no real waiting. `tick()` awaits each fired callback's return
 *  value — the manager's real timer callback returns `reap()`'s promise (ignored by a real
 *  setTimeout, but useful here to make eviction observable before the next assertion runs. */
function manualScheduler() {
  const fns = new Map<number, () => unknown>();
  let seq = 0;
  const scheduler: LspScheduler = {
    setTimeout(fn) { const id = seq++; fns.set(id, fn); return id; },
    clearTimeout(handle) { fns.delete(handle as number); },
  };
  const tick = async () => { await Promise.all([...fns.values()].map((fn) => fn())); };
  return { scheduler, tick, liveCount: () => fns.size };
}

describe("languageForPath", () => {
  test("extension matrix: known extensions route; unsupported → null", () => {
    const cases: Array<[string, LspLanguage | null]> = [
      ["a.ts", "typescript"], ["a.tsx", "typescript"], ["a.js", "typescript"], ["a.jsx", "typescript"],
      ["a.mts", "typescript"], ["a.cts", "typescript"],
      ["a.swift", "swift"],
      ["a.py", null], ["a.md", null], ["noext", null], ["/dir/only.dotfile.", null],
    ];
    for (const [p, expected] of cases) expect(languageForPath(p)).toBe(expected);
  });
});

describe.if(isMac)("LspManager", () => {
  test("lazy: 5 concurrent clientFor for the same key dedupe to ONE spawn", async () => {
    const mgr = new LspManager({ serverCommands: { typescript: FAKE } });
    const spy = spyOn(LspClient.prototype, "start");
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => mgr.clientFor("/workspace-concurrent", "typescript")),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(5);
      const first = results[0]!;
      for (const r of results) expect(r).toBe(first);
    } finally {
      spy.mockRestore();
      await mgr.stopAll();
    }
  });

  test("reuse while warm: no new spawn, and the old idle timer is disarmed (not left dangling)", async () => {
    const { scheduler, liveCount } = manualScheduler();
    const mgr = new LspManager({ serverCommands: { typescript: FAKE }, scheduler });
    const spy = spyOn(LspClient.prototype, "start");
    try {
      const a1 = await mgr.clientFor("/workspace-warm", "typescript");
      expect(liveCount()).toBe(1);
      const a2 = await mgr.clientFor("/workspace-warm", "typescript"); // warm reuse
      expect(a2).toBe(a1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(liveCount()).toBe(1); // rearmed, not accumulated — exactly one live timer, never two
    } finally {
      spy.mockRestore();
      await mgr.stopAll();
    }
  });

  test("idle reap: the timer fires stop() + eviction; a later call re-spawns", async () => {
    const { scheduler, tick } = manualScheduler();
    const mgr = new LspManager({ serverCommands: { typescript: FAKE }, scheduler, idleShutdownMs: 50 });
    const spy = spyOn(LspClient.prototype, "start");
    try {
      const a = await mgr.clientFor("/workspace-idle", "typescript");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(a.alive).toBe(true);

      await tick(); // simulate the idle window elapsing — reaps `a`
      expect(a.alive).toBe(false);

      const b = await mgr.clientFor("/workspace-idle", "typescript"); // key evicted → fresh spawn
      expect(spy).toHaveBeenCalledTimes(2);
      expect(b).not.toBe(a);
      expect(b.alive).toBe(true);
    } finally {
      spy.mockRestore();
      await mgr.stopAll();
    }
  });

  test("stopAll reaps every warm client (daemon shutdown); no dangling timers; idempotent", async () => {
    const { scheduler, liveCount } = manualScheduler();
    const mgr = new LspManager({
      serverCommands: { typescript: FAKE, swift: FAKE },
      scheduler,
    });
    const a = await mgr.clientFor("/workspace-a", "typescript");
    const b = await mgr.clientFor("/workspace-b", "swift");
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
    expect(liveCount()).toBe(2);

    await mgr.stopAll();
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(liveCount()).toBe(0); // every idle timer cleared, none left armed

    await mgr.stopAll(); // a second shutdown call is a safe no-op
  });

  test("stopAll drains an IN-FLIGHT spawn (shutdown race) — the mid-flight product is stopped, not orphaned", async () => {
    const { scheduler, liveCount } = manualScheduler();
    const mgr = new LspManager({ serverCommands: { typescript: FAKE }, scheduler });
    const stopSpy = spyOn(LspClient.prototype, "stop");
    try {
      // Kick off a spawn and, WITHOUT yielding to the event loop, call stopAll. JS is
      // single-threaded: no microtask runs between these two synchronous lines, so the spawn is
      // guaranteed to be in `inFlight` and NOT yet in `clients` when stopAll snapshots — exactly
      // the shutdown race. WITHOUT the fix, stopAll sees the key nowhere, stops nothing, resolves;
      // the spawn then completes into a live, timer-armed orphan (this assertion goes RED).
      const spawnP = mgr.clientFor("/ws-race", "typescript");
      const stopP = mgr.stopAll();
      const [client] = await Promise.all([spawnP, stopP]);
      expect(client.alive).toBe(false); // the in-flight product was actually reaped by stopAll
      expect(stopSpy).toHaveBeenCalled();
      expect(liveCount()).toBe(0); // the timer the completing spawn armed was cleared too — no dangler
    } finally {
      stopSpy.mockRestore();
      await mgr.stopAll(); // idempotent belt-and-suspenders
    }
  });

  test("missing binary → typed LspSpawnError naming the language, command, and install hint", async () => {
    const mgr = new LspManager({ serverCommands: { typescript: { command: "this-command-does-not-exist-xyz" } } });
    let caught: unknown;
    try {
      await mgr.clientFor("/workspace-missing", "typescript");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LspSpawnError);
    const message = (caught as Error).message;
    expect(message).toContain("typescript");
    expect(message).toContain("this-command-does-not-exist-xyz");
    expect(message).toContain("npm i -g typescript-language-server typescript");
    await mgr.stopAll();
  });

  test("swift missing binary → install hint points at Xcode", async () => {
    const mgr = new LspManager({ serverCommands: { swift: { command: "this-command-does-not-exist-xyz" } } });
    await expect(mgr.clientFor("/workspace-missing-swift", "swift")).rejects.toThrow(LspSpawnError);
    try {
      await mgr.clientFor("/workspace-missing-swift-2", "swift");
    } catch (e) {
      expect((e as Error).message).toContain("sourcekit-lsp ships with Xcode");
    }
    await mgr.stopAll();
  });

  test("a spawn that hangs past its own start timeout is stopped (killed), not leaked", async () => {
    const mgr = new LspManager({
      serverCommands: { typescript: { command: "sleep", args: ["30"], startTimeoutMs: 200 } },
    });
    await expect(mgr.clientFor("/workspace-hang", "typescript")).rejects.toThrow(LspSpawnError);
    // No orphaned `sleep 30`: proven by this call returning promptly (stop()'s SIGKILL fallback
    // ran inside spawn()'s catch) and by the full-suite's own pgrep-based hygiene check elsewhere
    // (tools-bash.test.ts) — mirrors client.test.ts's identical "hang" test convention.
    await mgr.stopAll();
  }, 8000);
});
