import { z } from "zod";
import type { ToolRegistry, ToolContext } from "./registry";
import type { RoutineStore } from "../../routines/store";

const HEAD_LEN = 60;

/** First line of `prompt`, truncated to HEAD_LEN chars — same "short preview, not the whole
 *  thing" shape as SessionStore's own fallbackTitle (sessions/store.ts). */
function promptHead(prompt: string): string {
  const line = (prompt.split("\n", 1)[0] ?? "").trim();
  return line.length > HEAD_LEN ? `${line.slice(0, HEAD_LEN - 1)}…` : line;
}

const ScheduleArgs = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    spec: z.string().min(1),
    prompt: z.string().min(1),
    policy: z.enum(["auto", "plan"]).optional(),
    cwd: z.string().optional(),
  }),
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("delete"), id: z.string().min(1) }),
  z.object({ op: z.literal("enable"), id: z.string().min(1) }),
  z.object({ op: z.literal("disable"), id: z.string().min(1) }),
]);

const DESCRIPTION =
  "Manage scheduled routines: unattended background prompts that fire headless on a recurring schedule, each in its own session. " +
  'op="create" requires spec and prompt: spec is either an interval ("every <N><s|m|h|d>", e.g. "every 30m", "every 2h") ' +
  'or a standard 5-field cron expression ("m h dom mon dow", e.g. "0 9 * * 1-5"). ' +
  'policy is optional (default "auto") and MUST be "auto" (tools run without approval) or "plan" (read-only research only) — ' +
  '"ask" is rejected: a routine runs headless, with nobody present to answer an approval prompt. ' +
  "cwd is optional and defaults to this session's working directory. " +
  'op="list" shows every routine (id, spec, enabled/disabled, next run time, prompt preview). ' +
  'op="delete"/"enable"/"disable" take an existing routine\'s id.';

/** Registers the `schedule` tool — the agent-facing management surface over `RoutineStore`
 *  (phase 5 routines T3, design doc §4: "gate-carded under `ask` policy like other mutating
 *  tools"). MUTATING is asserted by agent/gate.ts's own set membership, not re-checked here — see
 *  test/routines/schedule-tool.test.ts and test/agent/gate.test.ts.
 *
 *  Every op returns human-readable text (never JSON) for the model to read directly, and every
 *  expected failure (unknown id, invalid spec, `policy:"ask"`) is either a plain "not found" string
 *  (delete/enable/disable on an unknown id — RoutineStore's own contract: these never throw) or a
 *  thrown `TypeError` from `RoutineStore.create`/`update` that ToolRegistry.execute's catch turns
 *  into an isError tool_result — no try/catch needed here, matching background.ts/plan.ts's own
 *  "let the registry's execute() catch do the isError conversion" precedent. */
export function registerScheduleTool(r: ToolRegistry, deps: { routines: RoutineStore }, opts?: { deferred?: boolean }): void {
  const { routines } = deps;

  r.register({
    name: "schedule",
    description: DESCRIPTION,
    args: ScheduleArgs,
    deferred: opts?.deferred,
    run(args: z.infer<typeof ScheduleArgs>, ctx: ToolContext): string {
      switch (args.op) {
        case "create": {
          const routine = routines.create({
            spec: args.spec,
            prompt: args.prompt,
            policy: args.policy,
            cwd: args.cwd ?? ctx.cwd,
          });
          return `created routine ${routine.id}: ${routine.spec} (policy ${routine.policy}, cwd ${routine.cwd}) — next run ${new Date(routine.nextRunAt).toISOString()}`;
        }
        case "list": {
          const all = routines.list();
          if (all.length === 0) return "no routines scheduled.";
          return all
            .map((rt) =>
              `${rt.id}  ${rt.spec}  ${rt.enabled ? "enabled" : "disabled"}  next=${new Date(rt.nextRunAt).toISOString()}  prompt="${promptHead(rt.prompt)}"`,
            )
            .join("\n");
        }
        case "delete": {
          const removed = routines.delete(args.id);
          return removed ? `deleted routine ${args.id}` : `no routine found with id ${args.id}`;
        }
        case "enable":
        case "disable": {
          const updated = routines.update(args.id, { enabled: args.op === "enable" });
          if (!updated) return `no routine found with id ${args.id}`;
          return `routine ${updated.id} ${updated.enabled ? "enabled" : "disabled"}`;
        }
      }
    },
  });
}
