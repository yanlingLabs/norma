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
});
