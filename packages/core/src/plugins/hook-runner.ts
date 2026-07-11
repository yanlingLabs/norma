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

    try {
      // Bun's FileSink write()/end() are typed `number | Promise<number>` — when the child has
      // already exited (or exits mid-write) the write can fail asynchronously (EPIPE) rather than
      // throwing synchronously. Awaiting here routes that failure into this catch instead of
      // becoming an unhandled rejection, which would otherwise crash the whole daemon process.
      await proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
    } catch {
      // A process that exits immediately (e.g. `exit 1` before reading stdin) can make the write
      // itself throw/reject (incl. EPIPE) — irrelevant to the exit-code outcome decided below, so
      // swallow it; the child just won't see (all of) the payload.
    }

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
