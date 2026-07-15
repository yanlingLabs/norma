import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { BackgroundTaskRegistry } from "../bg-registry";

export function registerBackgroundTools(r: ToolRegistry, deps: { bgRegistry: BackgroundTaskRegistry }, opts?: { deferred?: boolean }): void {
  const { bgRegistry } = deps;

  r.register({
    name: "bash_output",
    description: "Read new output from a background bash task started with bash's runInBackground option. Returns only output produced since the last read, plus the task's current status.",
    args: z.object({
      taskId: z.string().min(1),
      filter: z.string().max(256).optional(),
    }),
    deferred: opts?.deferred,
    run({ taskId, filter }, { sessionId }) {
      const { chunk, status, exitCode } = bgRegistry.read(sessionId, taskId);
      let body = chunk;
      if (filter) {
        try {
          const re = new RegExp(filter);
          body = chunk.split("\n").filter((line) => re.test(line)).join("\n");
        } catch {
          body = chunk + "\n[invalid filter regex — showing unfiltered output]";
        }
      }
      const suffix = `[status: ${status}${exitCode != null ? `, exit ${exitCode}` : ""}]`;
      return `${body}\n${suffix}`;
    },
  });
}
