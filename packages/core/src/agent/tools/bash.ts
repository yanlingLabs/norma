import { z } from "zod";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildSeatbeltProfile, sandboxAvailable } from "../sandbox";
import type { ToolRegistry } from "./registry";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;
const MAX_CAPTURE = 256 * 1024; // hard bound before the registry's own 64KB cap; prevents OOM on chatty long runs

export function registerBashTool(r: ToolRegistry): void {
  r.register({
    name: "bash",
    description: "Run a shell command in the session directory. Confined by a macOS sandbox: writes are limited to the session directory and network is disabled. Combined stdout+stderr is returned with the exit code.",
    args: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    }),
    async run({ command, timeoutMs }, { cwd, roots, tmpDir }) {
      if (!sandboxAvailable()) {
        throw new Error("bash is unavailable: macOS sandbox-exec not found on this host");
      }
      const realCwd = realpathSync(cwd);
      const scratch = tmpDir ?? realCwd; // engine always supplies a session tmp; fall back to cwd
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

        const finish = (code: number | null) => {
          clearTimeout(timer);
          const merged = buf.replace(DEPRECATION_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd()
            + (truncated ? "\n[output truncated at 256KB]" : "");
          resolve(timedOut ? `${merged}\n[timed out after ${timeout}ms, killed]` : `${merged}\n[exit ${code}]`);
        };

        child.on("close", (code) => finish(code));
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve(`failed to launch sandboxed bash: ${(err as Error).message}\n[exit -1]`);
        });
      });
    },
  });
}
