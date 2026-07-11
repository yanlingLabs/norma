/**
 * HookRunner — pure process mechanics for ONE plugin hook invocation (Phase 4f design §Protocol,
 * plan Task 1). Spawns `sh -c <command>` with the event JSON on stdin, races the exit against a
 * timeout, caps stdout/stderr, and maps the exit-code protocol (0=ok / 2=blocked+stderr-reason /
 * anything else=error) to a `HookResult`. This class NEVER throws — every path (spawn failure,
 * timeout, non-zero exit, stream-read failure) resolves a `HookResult`; callers (HookRegistry /
 * the engine facade, Tasks 2-3) can await it unconditionally.
 *
 * Deliberately has NO opinion on: which hooks run for an event, sequencing/short-circuiting
 * across multiple hooks, fail-open policy, or where results get injected (system-reminder vs.
 * blocked tool_result) — that's HookRegistry + the engine facade (Task 2/3).
 */

/** One hook, resolved to something directly spawnable — plugin id (for env/logging), the shell
 *  command from norma-plugin.json, the plugin's directory (cwd), and an optional per-hook
 *  timeout override (falls back to `DEFAULT_TIMEOUT_MS` below). */
export interface HookSpec {
  pluginId: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
}

/** The JSON object written to the child's stdin. `event`/`sessionId`/`pluginId`/`ts` are common to
 *  every hook event; per-event extra fields (toolName, argsJson, stdout, ...) ride along via the
 *  index signature — callers building a payload for a specific event add those directly. */
export type HookEventPayload = {
  event: string;
  sessionId: string;
  pluginId: string;
  ts: number;
} & Record<string, unknown>;

export interface HookResult {
  status: "ok" | "blocked" | "error" | "timeout";
  reason?: string;
  stdout: string;
}

/** F2 (design doc): fail-open default — a hook that neither errors nor is given a manifest
 *  `timeoutMs` gets 10s before it's killed and treated as "timeout" (fail-open at the call site,
 *  not here — this class just reports the outcome). */
const DEFAULT_TIMEOUT_MS = 10_000;
const STDOUT_CAP = 8192;
const STDERR_CAP = 1024;

export class HookRunner {
  async run(spec: HookSpec, payload: HookEventPayload): Promise<HookResult> {
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["sh", "-c", spec.command], {
        cwd: spec.cwd,
        env: {
          ...process.env,
          NORMA_SESSION_ID: payload.sessionId,
          NORMA_PLUGIN_ID: spec.pluginId,
          NORMA_HOOK_EVENT: payload.event,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      // Spawn itself threw (e.g. `cwd` doesn't exist, `sh` missing) — never propagate, report it
      // the same shape as any other hook failure.
      return { status: "error", stdout: "", reason: err instanceof Error ? err.message : String(err) };
    }

    // Fire-and-forget: write/end the stdin payload as a CONCURRENT task, not one the timeout race
    // below awaits. Bun's FileSink write()/end() are typed `number | Promise<number>` — a bare
    // `.catch()` can't chain on the sync-number fast path, so this async IIFE (whose `await`
    // normalizes both) is what reliably contains a rejection. If this write were awaited here
    // (pre-C3-fix), a non-draining-but-alive hook + a payload above the pipe-buffer threshold
    // (~512-600KB) would block it forever — BEFORE the race/timer below is ever constructed — so
    // the timeout would never fire and run() would hang unboundedly. Not awaiting it means the
    // race is always armed immediately, regardless of whether the write drains. A write blocked on
    // a hung hook gets unblocked when the timeout path SIGKILLs the child below: the pipe breaks,
    // the write rejects (EPIPE), and that rejection is caught right here — never an unhandled
    // rejection (C1 stays closed). A normal, well-behaved child still receives the full payload +
    // EOF, since write+end complete long before any realistic timeout fires.
    void (async () => {
      try {
        await proc.stdin.write(JSON.stringify(payload));
        await proc.stdin.end();
      } catch {
        // Child gone early (exit before reading stdin) or pipe closed by our own SIGKILL on
        // timeout — either way irrelevant to the outcome decided below; swallow it.
      }
    })();

    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    // Fast path (process exited before the timer fired): clear it so it can't fire later and keep
    // the process/event-loop alive for no reason.
    if (timer !== undefined) clearTimeout(timer);

    if (timedOut) {
      try {
        // SIGKILL, not the default SIGTERM: a hook can trivially install `trap '' TERM` (or simply
        // ignore it) and a SIGTERM would then never actually stop it, leaving `await proc.exited`
        // below blocked forever and defeating the timeout entirely. SIGKILL cannot be trapped or
        // ignored. A timed-out hook gets no grace period — going straight to SIGKILL (rather than
        // TERM-then-KILL escalation) keeps this simple, which is the right tradeoff for v1.
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // Don't resolve "timeout" until the process is actually dead — await its real exit rather
      // than trusting that kill() is synchronous/instantaneous.
      await proc.exited;
      return { status: "timeout", stdout: "" };
    }

    let stdout = "";
    let stderr = "";
    try {
      stdout = (await new Response(proc.stdout).text()).slice(0, STDOUT_CAP);
    } catch {
      /* stream read failed — treat as empty, exit code still decides the outcome below */
    }
    try {
      stderr = (await new Response(proc.stderr).text()).slice(0, STDERR_CAP);
    } catch {
      /* same as above */
    }

    const exitCode = proc.exitCode;
    if (exitCode === 0) return { status: "ok", stdout };
    if (exitCode === 2) return { status: "blocked", stdout, reason: stderr.trim() || undefined };
    return { status: "error", stdout, reason: stderr.trim() || `exited with code ${exitCode}` };
  }
}
