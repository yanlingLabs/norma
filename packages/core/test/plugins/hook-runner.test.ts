import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner, type HookEventPayload, type HookSpec } from "../../src/plugins/hook-runner";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "norma-hook-runner-"));
}

function mkPayload(overrides: Partial<HookEventPayload> = {}): HookEventPayload {
  return { event: "pre-tool", sessionId: "sess-1", pluginId: "demo", ts: 1234, ...overrides };
}

function mkSpec(overrides: Partial<HookSpec> = {}): HookSpec {
  return { pluginId: "demo", command: "true", cwd: tmpDir(), ...overrides };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HookRunner.run", () => {
  test("(a) exit-0 script echoing stdout → ok, stdout captured", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "echo hello-stdout" }), mkPayload());
    expect(result.status).toBe("ok");
    expect(result.stdout.trim()).toBe("hello-stdout");
    expect(result.reason).toBeUndefined();
  });

  test("(b) exit-2 script writing stderr → blocked, reason from stderr", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "echo denied-reason 1>&2; exit 2" }), mkPayload());
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("denied-reason");
  });

  test("(b2) exit-2 with no stderr → blocked, reason undefined", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "exit 2" }), mkPayload());
    expect(result.status).toBe("blocked");
    expect(result.reason).toBeUndefined();
  });

  test("(c) exit-1 → error", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "echo boom 1>&2; exit 1" }), mkPayload());
    expect(result.status).toBe("error");
    expect(result.reason).toBe("boom");
  });

  test("(d) sleeping script + timeoutMs 100 → timeout in ~100ms, process is actually dead", async () => {
    const runner = new HookRunner();
    const dir = tmpDir();
    const pidFile = join(dir, "pid");
    const start = Date.now();
    const result = await runner.run(
      mkSpec({ cwd: dir, command: `echo $$ > "${pidFile}"; sleep 5`, timeoutMs: 100 }),
      mkPayload(),
    );
    const elapsed = Date.now() - start;

    expect(result.status).toBe("timeout");
    // Resolved close to the 100ms timeout, nowhere near the 5s sleep — proves the timer won the race.
    expect(elapsed).toBeLessThan(2000);

    // Poll (bounded, short interval) that the spawned shell's own pid is no longer alive — proves
    // proc.kill() actually reaped the process rather than leaving it running in the background.
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    for (let i = 0; i < 25; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await sleep(20);
    }
    expect(alive).toBe(false);
  });

  test("(e) stdout beyond the cap is truncated at 8192 chars", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "yes x | head -c 20000" }), mkPayload());
    expect(result.status).toBe("ok");
    expect(result.stdout.length).toBe(8192);
  });

  test("(f) the JSON payload arrives on stdin — round-trips through a `cat`", async () => {
    const runner = new HookRunner();
    const payload = mkPayload({ event: "session-start", extra: "field" });
    const result = await runner.run(mkSpec({ command: "cat" }), payload);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  test("(g) a bogus/nonexistent command → error, never throws", async () => {
    const runner = new HookRunner();
    const result = await runner.run(mkSpec({ command: "this-command-does-not-exist-xyz-123" }), mkPayload());
    expect(result.status).toBe("error");
  });

  test("(g2) Bun.spawn itself throwing (invalid cwd) → error, never throws", async () => {
    const runner = new HookRunner();
    const result = await runner.run(
      mkSpec({ command: "echo hi", cwd: "/no/such/directory/for/sure/xyz-abc-123" }),
      mkPayload(),
    );
    expect(result.status).toBe("error");
    expect(result.reason).toBeDefined();
  });

  test("(h) NORMA_SESSION_ID/NORMA_PLUGIN_ID/NORMA_HOOK_EVENT are set in the child's env", async () => {
    const runner = new HookRunner();
    const result = await runner.run(
      mkSpec({ pluginId: "plugin-x", command: 'printf "%s|%s|%s" "$NORMA_SESSION_ID" "$NORMA_PLUGIN_ID" "$NORMA_HOOK_EVENT"' }),
      mkPayload({ sessionId: "sess-42", pluginId: "plugin-x", event: "turn-end" }),
    );
    expect(result.status).toBe("ok");
    expect(result.stdout).toBe("sess-42|plugin-x|turn-end");
  });

  // C1 regression (4f T1 review): a child that exits before reading stdin (`exit 0`) combined with a
  // large payload can make Bun's FileSink stdin `write()`/`end()` REJECT (EPIPE) instead of throwing
  // synchronously. Pre-fix, that rejection was unhandled — Bun terminates the whole process on an
  // unhandled rejection ("UNHANDLED REJECTION: EPIPE: broken pipe, send"), which would take the
  // entire daemon down, not just this one hook run. Post-fix (awaiting the writes inside the
  // try/catch), the rejection is caught like any other early-exit write failure and run() just
  // resolves normally. The only meaningful assertion here is that this test (and the process running
  // it) SURVIVES at all — if the fix regresses, this whole test file crashes rather than reporting a
  // clean failure.
  test("(i) C1: large payload + child that exits before reading stdin → no unhandled EPIPE rejection, run() resolves ok", async () => {
    const runner = new HookRunner();
    const bigPayload = mkPayload({ padding: "x".repeat(5_000_000) }); // multi-MB, reliably triggers EPIPE on write
    const result = await runner.run(mkSpec({ command: "exit 0" }), bigPayload);
    expect(result.status).toBe("ok");
  });

  // C2 regression (4f T1 review): the timeout path used to call `proc.kill()` (default SIGTERM), which
  // a hook can trivially ignore (`trap '' TERM`). `await proc.exited` then blocks until the child exits
  // on its own — for a genuinely hung/infinite-loop hook, that's forever, defeating the timeout and
  // (downstream) hanging the pre-tool gate. Post-fix, the timeout path sends SIGKILL, which cannot be
  // trapped. The explicit 3000ms bun-test-level timeout (3rd arg) is a fail-fast guard for the RED
  // state: pre-fix this hook (SIGTERM-immune) makes run() hang for the sleep's full duration, and we
  // want that to show up as a fast, unambiguous test failure rather than stalling the whole suite.
  // NB: `sleep 2`, not `sleep 30` — `sh -c` forks `sleep` as a separate grandchild, so SIGKILLing the
  // `sh` process (proc.pid) orphans it rather than killing it; it self-exits on its own shortly after
  // (harmless), but `sleep 30` specifically collides with the literal `pgrep -f 'sleep 30'` orphan
  // check in test/agent/tools-bash.test.ts, so a longer-but-distinct duration avoids cross-file flakes.
  test(
    "(j) C2: SIGTERM-ignoring hook (trap '' TERM; sleep 2) + timeoutMs ~100 → timeout resolves promptly via SIGKILL, child is dead",
    async () => {
      const runner = new HookRunner();
      const dir = tmpDir();
      const pidFile = join(dir, "pid");
      const start = Date.now();
      const result = await runner.run(
        mkSpec({ cwd: dir, command: `trap '' TERM; echo $$ > "${pidFile}"; sleep 2`, timeoutMs: 100 }),
        mkPayload(),
      );
      const elapsed = Date.now() - start;

      expect(result.status).toBe("timeout");
      // Budget well under 1s: proves SIGKILL won, not the ignored SIGTERM + eventual natural exit.
      expect(elapsed).toBeLessThan(1000);

      // Poll (bounded, short interval) that the spawned shell's own pid is no longer alive — proves
      // the timeout path actually killed the SIGTERM-immune process rather than merely giving up on it.
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      let alive = true;
      for (let i = 0; i < 25; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await sleep(20);
      }
      expect(alive).toBe(false);
    },
    3000,
  );

  // C3 regression (4f T1 re-review, post-C1): the C1 fix awaited the stdin write/end BEFORE the
  // timeout `Promise.race` was constructed. A non-draining but ALIVE hook (never reads stdin)
  // combined with a payload above the pipe-buffer threshold (~512-600KB) blocks that awaited write
  // forever — the race/timer is never armed, so run() hangs unboundedly instead of resolving
  // "timeout". Fix: the stdin write/end is now a fire-and-forget task the race does not wait on, so
  // the timer is always armed immediately regardless of whether the write drains. `exec sleep 15`
  // (not `sleep 30`, to avoid the tools-bash.test.ts pgrep-sleep-30 collision) replaces the shell
  // with `sleep` via `exec` so it never reads stdin and the pipe never drains. The explicit 5000ms
  // bun-test-level timeout (3rd arg) is a fail-fast guard for the RED state: pre-fix, this hangs
  // indefinitely (no timeout, ever) rather than reporting a clean failure.
  test(
    "(k) C3: non-draining alive hook + oversized (~1MB) payload + short timeout → resolves timeout promptly, write does not gate the race",
    async () => {
      const runner = new HookRunner();
      const bigPayload = mkPayload({ padding: "x".repeat(1_000_000) });
      const start = Date.now();
      const result = await runner.run(mkSpec({ command: "exec sleep 15", timeoutMs: 200 }), bigPayload);
      const elapsed = Date.now() - start;

      expect(result.status).toBe("timeout");
      // Budget well under the 15s sleep and well past the 200ms timeoutMs — proves the timer won
      // the race rather than the write blocking it indefinitely.
      expect(elapsed).toBeLessThan(1500);
    },
    5000,
  );
});
