import { z } from "zod";
import type { ToolRegistry } from "./registry";

const SpawnArgs = z.object({
  prompt: z.string().min(1),
  agentType: z.string().optional(),
  model: z.string().optional(),
});

/** Registers spawn_agent with a placeholder run(). The engine intercepts spawn_agent tool calls
 *  before run() fires whenever cfg.subagents AND cfg.agents are both set (daemon.ts) AND the
 *  calling thread is depth 0 (see the parallel bridge in engine.ts's runThread dispatch loop,
 *  mirroring the exit_plan_mode/worktree bridges) — this placeholder only fires outside that flow
 *  (cfg.subagents/cfg.agents absent), or is never reached at all when the bridge is wired, since
 *  the engine short-circuits execution for spawn_agent calls before executeCall runs. */
export function registerSpawnAgentTool(r: ToolRegistry): void {
  r.register({
    name: "spawn_agent",
    description:
      "Launch a child agent to handle a task autonomously with its own fresh context. It runs its own tool loop and returns its final report. " +
      "Delegate multi-step work; run several in parallel by emitting multiple spawn_agent calls in one message. " +
      "The child does NOT see this conversation — put everything it needs in `prompt`. " +
      "agentType: optional subagent type; model: optional model override.",
    args: SpawnArgs,
    run(_args: z.infer<typeof SpawnArgs>) {
      return "subagents are not available in this session";
    },
  });
}
