import { z } from "zod";
import type { ToolRegistry } from "./registry";

const PLACEHOLDER = "worktree support is not available in this session";

const EnterArgs = z.object({ name: z.string().optional() });
const ExitArgs = z.object({ action: z.enum(["keep", "remove"]), discard_changes: z.boolean().optional() });

/** Registers enter_worktree/exit_worktree with placeholder run()s. The engine intercepts both
 *  tool names before run() fires whenever cfg.worktrees (a WorktreeManager) is set (see the
 *  dispatch-loop bridge in engine.ts, mirroring the exit_plan_mode bridge) — these placeholders
 *  only fire when the tool is invoked outside that flow (cfg.worktrees absent). */
export function registerWorktreeTools(r: ToolRegistry, opts?: { deferred?: boolean }): void {
  r.register({
    name: "enter_worktree",
    description:
      "Create an isolated git worktree (a copy of the repo on a new branch) and switch this session into it, so your work happens on the copy. " +
      "name: optional worktree name. Requires a git repository.",
    args: EnterArgs,
    deferred: opts?.deferred,
    run(_args: z.infer<typeof EnterArgs>) {
      return PLACEHOLDER;
    },
  });
  r.register({
    name: "exit_worktree",
    description:
      "Leave the current git worktree. action 'keep' leaves the worktree and its branch for you to merge/PR; " +
      "'remove' deletes the worktree, but refuses if it has uncommitted changes (you'll get the `git status --short` listing back). " +
      "discard_changes: true forces removal even when dirty, PERMANENTLY discarding those uncommitted changes — only set it once you're sure.",
    args: ExitArgs,
    deferred: opts?.deferred,
    run(_args: z.infer<typeof ExitArgs>) {
      return PLACEHOLDER;
    },
  });
}
