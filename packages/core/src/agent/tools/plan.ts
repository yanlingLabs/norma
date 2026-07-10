import { z } from "zod";
import type { ToolRegistry } from "./registry";

const EXIT_PLACEHOLDER = "exit_plan_mode is only meaningful in plan mode (no plan approval flow is wired).";
// enter_plan_mode (4g Task 4, CC parity): unlike exit_plan_mode, the engine bridge for entering
// has NO optional dependency to gate on (no PlanBroker wait — entering needs no human approval,
// it's strictly restrictive) — engine.ts's dispatch loop intercepts it UNCONDITIONALLY whenever
// the tool is called through the engine. This placeholder therefore only fires when the tool is
// invoked directly against the registry, bypassing the engine entirely (see tools-plan.test.ts).
const ENTER_PLACEHOLDER = "enter_plan_mode is only meaningful when the engine's plan-mode bridge is wired (this direct call bypassed it).";

const ExitPlanModeArgs = z.object({
  plan: z.string().min(1),
});
const EnterPlanModeArgs = z.object({});

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
      return EXIT_PLACEHOLDER;
    },
  });
  r.register({
    name: "enter_plan_mode",
    description:
      "Switch this session into plan mode: read-only tools only (writes/edits/commands are disabled) while you research and form a plan. " +
      "Call this BEFORE making any changes for a task that needs planning first. Present your plan with exit_plan_mode when ready.",
    args: EnterPlanModeArgs,
    deferred: opts?.deferred,
    // PLACEHOLDER run (engine intercepts — see ENTER_PLACEHOLDER's doc comment above).
    async run(_args: z.infer<typeof EnterPlanModeArgs>) {
      return ENTER_PLACEHOLDER;
    },
  });
}
