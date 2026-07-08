import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginSupervisor,
  backoffDelayMs,
  circuitAfterFailure,
  type EligiblePlugin,
  type InvokeResult,
  type PluginConn,
  type PluginSupervisorDeps,
  type SupervisedProcess,
  type SpawnFn,
} from "../../src/plugins/supervisor";

// -------------------------------------------------------------------------------------------
// Fixtures — everything here is fake (no real OS process, no real signals). `isAlivePid`/
// `signalPid` default to inert no-ops so a test that forgets to override them can never send a
// real signal anywhere (see supervisor.ts's doc comment on why these are injectable at all).
// -------------------------------------------------------------------------------------------

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "norma-supervisor-"));
}

function fakePlugin(overrides: Partial<EligiblePlugin> = {}): EligiblePlugin {
  return { id: "demo", dir: "/plugins/demo", entry: { command: "bun", args: ["index.ts"] }, ...overrides };
}

/** A deferred-promise fake process: `.exited` resolves only when the test calls `crash()` —
 *  nothing here is tied to `kill()`, exactly like a real OS process (the supervisor sends a
 *  signal; the process decides when, if ever, it actually exits). */
function fakeProc(pid: number) {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((res) => { resolveExited = res; });
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  const proc: SupervisedProcess = { pid, exited, kill: (sig) => { kills.push(sig); } };
  return { proc, kills, crash: (code = 1) => resolveExited(code) };
}

function makeSpawnFn(pidStart = 1000) {
  const calls: Array<{ cmd: string[]; opts: { cwd: string; env: Record<string, string> } }> = [];
  const spawned: Array<ReturnType<typeof fakeProc>> = [];
  let pid = pidStart;
  const spawn: SpawnFn = (cmd, opts) => {
    calls.push({ cmd, opts });
    const rec = fakeProc(pid++);
    spawned.push(rec);
    return rec.proc;
  };
  return { spawn, calls, spawned };
}

function fakeConn(): PluginConn & { pushed: Array<Record<string, unknown>>; delivered: boolean } {
  return {
    pushed: [],
    delivered: true,
    push(event) {
      this.pushed.push(event as unknown as Record<string, unknown>);
      return this.delivered;
    },
  };
}

const DEFAULT_SETTINGS: NonNullable<PluginSupervisorDeps["settings"]> = {
  registrationTimeoutMs: 5000, backoffCapMs: 60_000, circuitFailures: 5, circuitWindowMs: 10 * 60_000,
  invokeTimeoutMs: 5000, killGraceMs: 2000,
};

function makeSupervisor(overrides: Partial<PluginSupervisorDeps> = {}) {
  const dir = tmpRunDir();
  const mints: string[] = [];
  const logs: string[] = [];
  const { spawn, calls, spawned } = makeSpawnFn();
  const { settings, ...rest } = overrides;
  const supervisor = new PluginSupervisor({
    runDir: dir,
    socketPath: "/tmp/norma-test.sock",
    mintToken: (id) => { const t = `tok_${id}_${mints.length}`; mints.push(t); return t; },
    spawn,
    now: () => Date.now(),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    onLog: (m) => logs.push(m),
    isAlivePid: () => false,
    signalPid: () => {},
    ...rest,
  });
  return { supervisor, dir, mints, logs, calls, spawned };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------------------------
// Pure functions — directly table-tested, no clock/timer involved.
// -------------------------------------------------------------------------------------------

describe("backoffDelayMs (pure)", () => {
  const cap = 60_000;
  const cases: Array<[number, number]> = [
    [0, 1000], [1, 2000], [2, 4000], [3, 8000], [4, 16000], [5, 32000], [6, 60_000], [7, 60_000],
  ];
  for (const [attempt, want] of cases) {
    test(`attempt ${attempt} -> ${want}ms (1s·2^${attempt} capped at ${cap}ms)`, () => {
      expect(backoffDelayMs(attempt, cap)).toBe(want);
    });
  }
  test("a cap smaller than the base delay clamps immediately (attempt 0)", () => {
    expect(backoffDelayMs(0, 500)).toBe(500);
  });
});

describe("circuitAfterFailure (pure)", () => {
  test("first failure -> recorded, not open (threshold 5)", () => {
    expect(circuitAfterFailure([], 1000, 600_000, 5)).toEqual({ failures: [1000], open: false });
  });
  test("the 5th failure within the window opens the circuit", () => {
    const r = circuitAfterFailure([100, 200, 300, 400], 500, 600_000, 5);
    expect(r.failures).toEqual([100, 200, 300, 400, 500]);
    expect(r.open).toBe(true);
  });
  test("a 4th-in-a-row failure with threshold 5 does NOT open", () => {
    const r = circuitAfterFailure([100, 200, 300], 400, 600_000, 5);
    expect(r.open).toBe(false);
  });
  test("failures older than the window are pruned before counting -> resets", () => {
    // 4 old failures, all now outside the 10-minute window relative to the 5th's timestamp.
    const r = circuitAfterFailure([0, 0, 0, 0], 700_000, 600_000, 5);
    expect(r.failures).toEqual([700_000]);
    expect(r.open).toBe(false);
  });
  test("boundary: exactly windowMs old is pruned (exclusive)", () => {
    const r = circuitAfterFailure([0], 600_000, 600_000, 5);
    expect(r.failures).toEqual([600_000]);
  });
  test("boundary: one ms inside the window survives", () => {
    const r = circuitAfterFailure([0], 599_999, 600_000, 5);
    expect(r.failures).toEqual([0, 599_999]);
  });
});

// -------------------------------------------------------------------------------------------
// Spawn / registration / env.
// -------------------------------------------------------------------------------------------

describe("startAll / spawn", () => {
  test("spawns the manifest entry with NORMA_PLUGIN_TOKEN/SOCKET/ID; status starts 'starting'", () => {
    const { supervisor, calls, mints } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    expect(supervisor.status(p.id)).toBe("starting");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["bun", "index.ts"]);
    expect(calls[0]!.opts.cwd).toBe("/plugins/demo");
    expect(calls[0]!.opts.env.NORMA_PLUGIN_TOKEN).toBe(mints[0]);
    expect(calls[0]!.opts.env.NORMA_SOCKET).toBe("/tmp/norma-test.sock");
    expect(calls[0]!.opts.env.NORMA_PLUGIN_ID).toBe("demo");
  });

  test("entry.cwd, when set, resolves relative to the plugin's own dir", () => {
    const { supervisor, calls } = makeSupervisor();
    supervisor.startAll([fakePlugin({ dir: "/plugins/demo", entry: { command: "bun", args: ["i.ts"], cwd: "sub" } })]);
    expect(calls[0]!.opts.cwd).toBe(join("/plugins/demo", "sub"));
  });

  test("startAll is idempotent — a second call for an already-tracked id does not spawn again", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.startAll([p]);
    expect(calls).toHaveLength(1);
  });

  test("notifyRegistered flips starting -> running and clears the registration timer", () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    expect(supervisor.notifyRegistered(p.id, conn)).toBe(true);
    expect(supervisor.status(p.id)).toBe("running");
  });

  test("notifyRegistered rejects an unknown plugin id (never throws)", () => {
    const { supervisor } = makeSupervisor();
    expect(supervisor.notifyRegistered("nope", fakeConn())).toBe(false);
  });

  test("notifyRegistered rejects a duplicate registration once already running", () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    expect(supervisor.notifyRegistered(p.id, fakeConn())).toBe(false);
  });

  test("a throwing spawn() is treated as a failed attempt (backoff), never throws out of startAll", () => {
    const logs: string[] = [];
    const supervisor = new PluginSupervisor({
      runDir: tmpRunDir(), socketPath: "/tmp/x.sock", mintToken: () => "tok",
      spawn: () => { throw new Error("command not found"); },
      settings: DEFAULT_SETTINGS,
      onLog: (m) => logs.push(m),
    });
    const p = fakePlugin();
    expect(() => supervisor.startAll([p])).not.toThrow();
    expect(supervisor.status(p.id)).toBe("backoff");
    expect(logs.some((m) => m.includes("spawn failed"))).toBe(true);
  });

  test("mintToken is called fresh for every spawn attempt (rotates on restart)", async () => {
    const { supervisor, mints } = makeSupervisor({ settings: { registrationTimeoutMs: 10, backoffCapMs: 10 } });
    supervisor.startAll([fakePlugin()]);
    expect(mints).toHaveLength(1);
    await sleep(60);
    expect(mints.length).toBeGreaterThanOrEqual(2);
    // never the same raw token twice
    expect(new Set(mints).size).toBe(mints.length);
  });
});

// -------------------------------------------------------------------------------------------
// Registration timeout.
// -------------------------------------------------------------------------------------------

describe("registration timeout", () => {
  test("kills the process (SIGTERM) and schedules backoff when nothing registers in time", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor } = makeSupervisor({
      settings: { registrationTimeoutMs: 20, killGraceMs: 500 },
      isAlivePid: () => true,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    expect(supervisor.status(p.id)).toBe("starting");
    await sleep(70);
    expect(supervisor.status(p.id)).toBe("backoff");
    expect(signals.some((s) => s.sig === "SIGTERM")).toBe(true);
  });

  test("PID file is removed once the registration timeout fires", async () => {
    const { supervisor, dir } = makeSupervisor({ settings: { registrationTimeoutMs: 20 } });
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(existsSync(pidPath)).toBe(true);
    await sleep(70);
    expect(existsSync(pidPath)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Crash mid-invoke + notifyDisconnected.
// -------------------------------------------------------------------------------------------

describe("crash while an invoke is outstanding", () => {
  test("the outstanding invoke resolves typed 'crashed during <tool>'; status -> backoff", async () => {
    const { supervisor, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);

    const invokePromise = supervisor.invoke(p.id, "echo", "{}");
    expect(conn.pushed).toHaveLength(1);
    expect(conn.pushed[0]!.type).toBe("plugin_tool_invoke");

    spawned[0]!.crash(137);
    const result = await invokePromise;
    expect(result).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during echo` });
    expect(supervisor.status(p.id)).toBe("backoff");
  });

  test("multiple outstanding invokes each fail with THEIR OWN tool name", async () => {
    const { supervisor, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());

    const a = supervisor.invoke(p.id, "toolA", "{}");
    const b = supervisor.invoke(p.id, "toolB", "{}");
    spawned[0]!.crash(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during toolA` });
    expect(rb).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during toolB` });
  });

  test("a stale exited() from a superseded attempt never clobbers a NEWER attempt (generation guard)", async () => {
    // registrationTimeoutMs deliberately long — this test forces the generation bump directly via
    // restart() so it never races a real registration/backoff timer (avoids timing flakiness).
    const { supervisor, spawned } = makeSupervisor({ settings: { registrationTimeoutMs: 5000 } });
    const p = fakePlugin();
    supervisor.startAll([p]);
    expect(spawned).toHaveLength(1);

    supervisor.restart(p); // forces a fresh spawn / new generation, independent of any timer
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(supervisor.status(p.id)).toBe("starting");

    // The FIRST (now-superseded) process's exited promise resolves late (e.g. its SIGKILL finally
    // landing) — this must be a no-op for the CURRENT (second) attempt.
    spawned[0]!.crash(137);
    await sleep(10);
    expect(supervisor.status(p.id)).toBe("starting");
  });
});

describe("notifyDisconnected", () => {
  test("while running: fails pending invokes typed and enters backoff, same as a process crash", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    const invokePromise = supervisor.invoke(p.id, "sleep", "{}");
    supervisor.notifyDisconnected(p.id);
    const result = await invokePromise;
    expect(result).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during sleep` });
    expect(supervisor.status(p.id)).toBe("backoff");
  });

  test("is a no-op while merely 'starting' (nothing registered yet)", () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyDisconnected(p.id);
    expect(supervisor.status(p.id)).toBe("starting");
  });

  test("is a no-op for an unknown plugin id", () => {
    const { supervisor } = makeSupervisor();
    expect(() => supervisor.notifyDisconnected("nope")).not.toThrow();
  });
});

// -------------------------------------------------------------------------------------------
// invoke() edge cases.
// -------------------------------------------------------------------------------------------

describe("invoke()", () => {
  test("unknown/never-started plugin -> typed not_running, never throws", async () => {
    const { supervisor } = makeSupervisor();
    const res: InvokeResult = await supervisor.invoke("nope", "tool", "{}");
    expect(res).toEqual({ code: "not_running" });
  });

  test("status 'starting' (registered not yet) -> typed not_running", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const res = await supervisor.invoke(p.id, "tool", "{}");
    expect(res).toEqual({ code: "not_running" });
  });

  test("push failing to deliver -> typed no_connection, pending entry cleaned up", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    conn.delivered = false;
    supervisor.notifyRegistered(p.id, conn);
    const res = await supervisor.invoke(p.id, "tool", "{}");
    expect(res).toEqual({ code: "no_connection" });
  });

  test("no resolveToolResult within invokeTimeoutMs -> typed timeout", async () => {
    const { supervisor } = makeSupervisor({ settings: { invokeTimeoutMs: 20 } });
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    const res = await supervisor.invoke(p.id, "tool", "{}");
    expect(res).toEqual({ code: "timeout" });
  });

  test("a plugin.toolResult error -> typed plugin_error carrying the message", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "tool", "{}");
    const requestId = conn.pushed[0]!.requestId as string;
    supervisor.resolveToolResult({ requestId, error: "boom" });
    expect(await invokePromise).toEqual({ code: "plugin_error", message: "boom" });
  });

  test("a successful plugin.toolResult resolves ok:true with resultJson", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "tool", "{}");
    const requestId = conn.pushed[0]!.requestId as string;
    supervisor.resolveToolResult({ requestId, resultJson: "\"hi\"" });
    expect(await invokePromise).toEqual({ ok: true, resultJson: "\"hi\"" });
  });
});

// -------------------------------------------------------------------------------------------
// resolveToolResult() — double-settle-proof (mirrors PeripheralBroker.respond()).
// -------------------------------------------------------------------------------------------

describe("resolveToolResult() double-settle-proof", () => {
  test("a second resolveToolResult for the same requestId is a safe no-op — first result wins", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "echo", "{}");
    const requestId = conn.pushed[0]!.requestId as string;

    const first = supervisor.resolveToolResult({ requestId, resultJson: "\"first\"" });
    expect(first).toEqual({ ok: true });
    const second = supervisor.resolveToolResult({ requestId, resultJson: "\"second\"" });
    expect(second).toEqual({ ok: true }); // never throws, no alreadyResolved on the wire shape

    const result = await invokePromise;
    expect(result).toEqual({ ok: true, resultJson: "\"first\"" }); // second call never applied
  });

  test("resolveToolResult for an unknown requestId is a safe no-op", () => {
    const { supervisor } = makeSupervisor();
    expect(supervisor.resolveToolResult({ requestId: "never-existed" })).toEqual({ ok: true });
  });
});

// -------------------------------------------------------------------------------------------
// Circuit breaker (class-level integration — exact 5-in-10min values are pinned by the pure
// circuitAfterFailure tests above; this exercises the WIRING with a lower threshold for speed).
// -------------------------------------------------------------------------------------------

describe("circuit breaker (integration)", () => {
  test("repeated fast failures trip the circuit; no further spawn attempts follow", async () => {
    const { supervisor, calls } = makeSupervisor({
      settings: { registrationTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 3, circuitWindowMs: 600_000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    await sleep(250);
    expect(supervisor.status(p.id)).toBe("circuit-open");
    const countAtOpen = calls.length;
    await sleep(100);
    expect(calls.length).toBe(countAtOpen); // circuit-open never schedules another attempt
  });

  test("failures outside the circuit window don't accumulate (class-level, injected now())", async () => {
    // registrationTimeoutMs is deliberately long (never fires in this test) — failures are driven
    // directly via notifyDisconnected so this test races exactly ONE real timer (the short backoff
    // restart), not a registration timeout as well. Only backoffCapMs is short.
    let nowMs = 0;
    const { supervisor } = makeSupervisor({
      now: () => nowMs,
      settings: { registrationTimeoutMs: 5000, backoffCapMs: 15, circuitFailures: 2, circuitWindowMs: 1000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    supervisor.notifyDisconnected(p.id); // failure #1 recorded at nowMs=0
    expect(supervisor.status(p.id)).toBe("backoff"); // 1 failure, threshold 2 — not open yet

    await sleep(60); // let the short (15ms) backoff timer respawn automatically
    expect(supervisor.status(p.id)).toBe("starting"); // second attempt, failures untouched by respawn

    // Jump the injected clock far past the 1000ms window before recording the SECOND failure.
    nowMs = 10_000;
    supervisor.notifyRegistered(p.id, fakeConn());
    supervisor.notifyDisconnected(p.id); // failure #2 recorded at nowMs=10_000

    // Failure #1 (timestamp 0) is now 10_000ms stale — pruned before counting. Only failure #2
    // survives, so the circuit must NOT be open despite this being the second failure overall.
    expect(supervisor.status(p.id)).toBe("backoff");
  });
});

// -------------------------------------------------------------------------------------------
// Orphan reclaim (boot-time PID file handling).
// -------------------------------------------------------------------------------------------

describe("reclaimOrphans", () => {
  test("no PID file on disk -> no-op; the plugin is untouched (startAll spawns it fresh)", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin();
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("stopped"); // never tracked
    supervisor.startAll([p]);
    expect(calls).toHaveLength(1);
  });

  test("dead PID -> file cleaned up, plugin left untracked (not adopted)", () => {
    const { supervisor, dir } = makeSupervisor({ isAlivePid: () => false });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeFileSync(pidPath, "999999");
    supervisor.reclaimOrphans([p]);
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.status(p.id)).toBe("stopped");
  });

  test("malformed PID file content -> treated as dead, cleaned up", () => {
    const { supervisor, dir } = makeSupervisor({ isAlivePid: () => true }); // would be "alive" if ever checked
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeFileSync(pidPath, "not-a-pid");
    supervisor.reclaimOrphans([p]);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("live PID -> adopted into 'starting', given the re-registration window, no fresh spawn", () => {
    const { supervisor, dir, calls } = makeSupervisor({ isAlivePid: (pid) => pid === 424_242 });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", `${p.id}.pid`), "424242");
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("starting");
    expect(calls).toHaveLength(0);
  });

  test("live PID that registers within the window -> running, exactly like a fresh spawn", () => {
    const { supervisor, dir } = makeSupervisor({ isAlivePid: (pid) => pid === 424_242 });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", `${p.id}.pid`), "424242");
    supervisor.reclaimOrphans([p]);
    const conn = fakeConn();
    expect(supervisor.notifyRegistered(p.id, conn)).toBe(true);
    expect(supervisor.status(p.id)).toBe("running");
  });

  test("live PID that never re-registers is killed (SIGTERM) after the window and enters backoff", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 20, killGraceMs: 500 },
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", `${p.id}.pid`), "424242");
    supervisor.reclaimOrphans([p]);
    await sleep(70);
    expect(signals).toEqual([{ pid: 424_242, sig: "SIGTERM" }]);
    expect(supervisor.status(p.id)).toBe("backoff");
  });

  test("an unresponsive orphan is SIGKILLed after the kill grace elapses, if still alive", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, killGraceMs: 20 },
      isAlivePid: (pid) => pid === 424_242, // "still alive" forever — never actually dies
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", `${p.id}.pid`), "424242");
    supervisor.reclaimOrphans([p]);
    await sleep(90);
    expect(signals).toEqual([
      { pid: 424_242, sig: "SIGTERM" },
      { pid: 424_242, sig: "SIGKILL" },
    ]);
  });

  test("startAll folds reclaimOrphans in — a live-orphan plugin is adopted, never double-spawned", () => {
    const { supervisor, dir, calls } = makeSupervisor({ isAlivePid: (pid) => pid === 555 });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", `${p.id}.pid`), "555");
    supervisor.startAll([p]);
    expect(calls).toHaveLength(0);
    expect(supervisor.status(p.id)).toBe("starting");
  });

  test("startAll spawns OTHER eligible plugins normally alongside one reclaimed orphan", () => {
    const { supervisor, dir, calls } = makeSupervisor({ isAlivePid: (pid) => pid === 555 });
    const orphaned = fakePlugin({ id: "orphaned" });
    const fresh = fakePlugin({ id: "fresh" });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", "orphaned.pid"), "555");
    supervisor.startAll([orphaned, fresh]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.env.NORMA_PLUGIN_ID).toBe("fresh");
    expect(supervisor.status("orphaned")).toBe("starting");
    expect(supervisor.status("fresh")).toBe("starting");
  });
});

// -------------------------------------------------------------------------------------------
// PID file lifecycle.
// -------------------------------------------------------------------------------------------

describe("PID file lifecycle", () => {
  test("written on spawn with the spawned pid, under <runDir>/plugins/<id>.pid", () => {
    const { supervisor, dir, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(readFileSync(pidPath, "utf8")).toBe(String(spawned[0]!.proc.pid));
  });

  test("removed by stopAll", () => {
    const { supervisor, dir } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(existsSync(pidPath)).toBe(true);
    supervisor.stopAll();
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.status(p.id)).toBe("stopped");
  });

  test("re-written (new pid) on every restart after a crash", async () => {
    const { supervisor, dir, spawned } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, backoffCapMs: 15 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    await sleep(70);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(readFileSync(pidPath, "utf8")).toBe(String(spawned[spawned.length - 1]!.proc.pid));
  });
});

// -------------------------------------------------------------------------------------------
// stopAll / restart().
// -------------------------------------------------------------------------------------------

describe("stopAll", () => {
  test("kills every owned process, marks stopped, fails pending invokes, clears timers", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor } = makeSupervisor({ signalPid: (pid, sig) => signals.push({ pid, sig }) });
    const running = fakePlugin({ id: "running" });
    const starting = fakePlugin({ id: "starting" });
    supervisor.startAll([running, starting]);
    const conn = fakeConn();
    supervisor.notifyRegistered(running.id, conn);
    const invokePromise = supervisor.invoke(running.id, "sleep", "{}");

    supervisor.stopAll();

    expect(supervisor.status(running.id)).toBe("stopped");
    expect(supervisor.status(starting.id)).toBe("stopped");
    expect(signals.some((s) => s.sig === "SIGTERM")).toBe(true);
    expect(await invokePromise).toEqual({ code: "crashed", message: `plugin ${running.id} crashed during sleep` });
  });

  test("a late exited() after stopAll never resurrects the plugin into backoff", async () => {
    const { supervisor, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.stopAll();
    spawned[0]!.crash(1);
    await sleep(10);
    expect(supervisor.status(p.id)).toBe("stopped");
  });
});

describe("restart() (manual restart rider)", () => {
  test("forces a fresh spawn cycle from circuit-open, clearing failure history", async () => {
    const { supervisor, calls } = makeSupervisor({
      settings: { registrationTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 1, circuitWindowMs: 600_000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    await sleep(50);
    expect(supervisor.status(p.id)).toBe("circuit-open");
    const before = calls.length;

    supervisor.restart(p);
    expect(calls.length).toBe(before + 1);
    expect(supervisor.status(p.id)).toBe("starting");
  });

  test("restarts a never-before-seen plugin id too (fresh spawn)", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin({ id: "brand-new" });
    supervisor.restart(p);
    expect(calls).toHaveLength(1);
    expect(supervisor.status(p.id)).toBe("starting");
  });
});
