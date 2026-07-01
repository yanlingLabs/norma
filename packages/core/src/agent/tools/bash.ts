import { z } from "zod";
import { realpathSync } from "node:fs";
import { buildSeatbeltProfile, sandboxAvailable } from "../sandbox";
import type { ToolRegistry } from "./registry";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;

export function registerBashTool(r: ToolRegistry): void {
  r.register({
    name: "bash",
    description: "Run a shell command in the session directory. Confined by a macOS sandbox: writes are limited to the session directory and network is disabled. Combined stdout+stderr is returned with the exit code.",
    args: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    }),
    async run({ command, timeoutMs }, { cwd }) {
      if (!sandboxAvailable()) {
        throw new Error("bash is unavailable: macOS sandbox-exec not found on this host");
      }
      const realCwd = realpathSync(cwd);
      const profile = buildSeatbeltProfile({ cwd: realCwd, writableRoots: [], allowNetwork: false });
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const proc = Bun.spawn(
        ["/usr/bin/sandbox-exec", "-p", profile, "/bin/bash", "-c", command],
        { cwd: realCwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, timeout);
      try {
        const [out, err, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const merged = (out + err).replace(DEPRECATION_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
        if (timedOut) return `${merged}\n[timed out after ${timeout}ms, killed]`;
        return `${merged}\n[exit ${exitCode}]`;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
