import { z } from "zod";
import type { ToolRegistry } from "./registry";

const PLACEHOLDER = "exit_plan_mode is only meaningful in plan mode (no plan approval flow is wired).";

const ExitPlanModeArgs = z.object({
  plan: z.string().min(1),
});

export function registerPlanTool(r: ToolRegistry, opts?: { deferred?: boolean }): void {
  r.register({
    name: "exit_plan_mode",
    description:
      "Call when you are in plan mode and have finished researching and writing a plan for a task that requires making edits — presents the plan to the user for approval. " +
      "Do NOT call for research-only questions or when no edits are needed. plan: the plan as markdown.",
    args: ExitPlanModeArgs,
    deferred: opts?.deferred,
    // The engine intercepts exit_plan_mode before run() whenever cfg.plans is set (wired in a later
    // task) — this placeholder only fires if the tool is invoked outside that flow (e.g. policy !== "plan").
    async run(_args: z.infer<typeof ExitPlanModeArgs>) {
      return PLACEHOLDER;
    },
  });
}
