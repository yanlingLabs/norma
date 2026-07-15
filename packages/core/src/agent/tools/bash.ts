import { z } from "zod";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildSeatbeltProfile, sandboxAvailable } from "../sandbox";
import type { ToolRegistry } from "./registry";
import type { BackgroundTaskRegistry } from "../bg-registry";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;
const MAX_CAPTURE = 256 * 1024; // hard bound before the registry's own 64KB cap; prevents OOM on chatty long runs

export function registerBashTool(r: ToolRegistry, deps: { bgRegistry?: BackgroundTaskRegistry } = {}): void {
  r.register({
    name: "bash",
    description: "Run a shell command in the session directory. Confined by a macOS sandbox: writes are limited to the session directory and network is disabled. Combined stdout+stderr is returned with the exit code. Note: bare mktemp may fail under the sandbox (macOS ignores $TMPDIR); use $TMPDIR explicitly, e.g. mktemp \"$TMPDIR/XXXXXX\". Set runInBackground: true to launch long-running commands without blocking; poll output with bash_output and stop them with task_stop. If a prior bash call was blocked by the safety reviewer, pass justification: a short explanation of why this command is necessary and safe; the reviewer will reconsider. It does not affect execution. IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience: Read files with `read`, search with `grep`, list files with `glob`.",
    args: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
      runInBackground: z.boolean().optional(),
      justification: z.string().optional(),
    }),
    async run({ command, timeoutMs, runInBackground }, { cwd, roots, tmpDir, sessionId, signal }) {
      if (runInBackground) {
        if (!deps.bgRegistry) throw new Error("background tasks are not available in this context");
        return `background task ${deps.bgRegistry.start(sessionId, command)} started`;
      }
      if (!sandboxAvailable()) {
        throw new Error("bash is unavailable: macOS sandbox-exec not found on this host");
      }
      const realCwd = realpathSync(cwd);
      const scratch = realpathSync(tmpDir ?? realCwd); // engine always supplies a session tmp; fall back to cwd
      const writable = [...new Set([realCwd, ...roots.map((r) => realpathSync(r)), scratch])];
      const profile = buildSeatbeltProfile({
        cwd: realCwd,
        writableRoots: writable.filter((r) => r !== realCwd),
        allowNetwork: false,
      });
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

      return await new Promise<string>((resolve) => {
        const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], {
          cwd: realCwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: { ...process.env, TMPDIR: scratch },
        });

        let buf = "";
        let truncated = false;
        const append = (d: Buffer) => {
          if (truncated) return;
          buf += d.toString("utf8");
          if (buf.length > MAX_CAPTURE) {
            buf = buf.slice(0, MAX_CAPTURE);
            truncated = true;
          }
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          // Negative pid targets the whole process group. `detached: true` made
          // this child its own group leader (setsid), so this also reaps
          // sandbox-exec, bash, and any forked/backgrounded grandchildren —
          // closing all pipe fds so stream collection unblocks promptly.
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* group already gone */
          }
        }, timeout);

        let aborted = false;
        const onAbort = () => {
          aborted = true;
          // Same group-kill as the timeout path — reaps the whole process
          // group so an interrupted session.turn doesn't leave orphans.
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* group already gone */
          }
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const finish = (code: number | null) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const merged = buf.replace(DEPRECATION_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd()
            + (truncated ? "\n[output truncated at 256KB]" : "");
          if (aborted) resolve(`${merged}\n[aborted]`);
          else resolve(timedOut ? `${merged}\n[timed out after ${timeout}ms, killed]` : `${merged}\n[exit ${code}]`);
        };

        child.on("close", (code) => finish(code));
        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(`failed to launch sandboxed bash: ${(err as Error).message}\n[exit -1]`);
        });
      });
    },
  });
}
