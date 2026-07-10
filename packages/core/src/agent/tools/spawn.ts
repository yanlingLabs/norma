import { z } from "zod";
import type { ToolRegistry } from "./registry";

/** Registers spawn_agent with a placeholder run(). The engine intercepts spawn_agent tool calls
 *  before run() fires whenever cfg.subagents AND cfg.agents are both set (daemon.ts) AND the
 *  calling thread is depth 0 (see the parallel bridge in engine.ts's runThread dispatch loop,
 *  mirroring the exit_plan_mode/worktree bridges) — this placeholder only fires outside that flow
 *  (cfg.subagents/cfg.agents absent), or is never reached at all when the bridge is wired, since
 *  the engine short-circuits execution for spawn_agent calls before executeCall runs.
 *
 *  `models` (4e gate F9, design upgrade): the calling provider's own `models()` ids, when the
 *  provider enumerates a known set (e.g. codex-oauth's gpt-5.6 trio). When non-empty, the `model`
 *  arg is a CLOSED zod `enum` — not just a free string — so the JSON schema the model actually
 *  sees in the tools array (`ToolRegistry.specs()` → `z.toJSONSchema`, confirmed to serialize a
 *  zod enum as `{"type":"string","enum":[...]}`) constrains the choice at the source, the same
 *  "pick from the list" pattern Claude Code uses for its own tool enums — rather than relying on
 *  a model reading prose and guessing anyway (the live defect this fixes: a hallucinated id like
 *  "gpt-5-mini"). The description clause ALSO enumerates the ids (some clients render enums
 *  poorly / strip schema detail before showing the model the tool). Omitted, or the calling
 *  provider's models() is empty (e.g. openai-compatible against an arbitrary endpoint it can't
 *  enumerate), falls back to a plain `z.string().optional()` — unchanged behavior.
 *
 *  IMPORTANT: this schema enum is NOT the runtime gate. The engine's spawn bridge intercepts
 *  spawn_agent calls and hand-parses `call.argsJson` directly (engine.ts's spawn bridge, ~line
 *  488) BEFORE this tool's own zod validation would ever run — so a provider that ignores its own
 *  declared schema (or a client that strips it) could still send an out-of-enum string through.
 *  The bridge's OWN `known.some(m => m.id === effectiveOverride)` check (engine.ts) is what
 *  actually rejects it at runtime; this schema is defense-in-depth / the steering half of a
 *  two-layer gate — same shape as the plugin consent re-gate precedent (schema/UX nudge one layer,
 *  authoritative runtime check the other), not a replacement for it. */
export function registerSpawnAgentTool(r: ToolRegistry, opts: { models?: string[] } = {}): void {
  const hasModels = !!opts.models && opts.models.length > 0;
  const modelField = hasModels
    ? z.enum(opts.models as [string, ...string[]]).optional()
    : z.string().optional();
  const modelClause = hasModels
    ? `model: optional override, one of: ${opts.models!.join(", ")} (omit to inherit the session model)`
    : "model: optional model override";
  const SpawnArgs = z.object({
    prompt: z.string().min(1),
    agentType: z.string().optional(),
    model: modelField,
    description: z.string().min(1),
    max_turns: z.number().int().positive().max(50).optional(),
  });
  r.register({
    name: "spawn_agent",
    description:
      "Launch a child agent to handle a task autonomously with its own fresh context. It runs its own tool loop and returns its final report. " +
      "Delegate multi-step work; run several in parallel by emitting multiple spawn_agent calls in one message. " +
      "The child does NOT see this conversation — put everything it needs in `prompt`. " +
      `agentType: optional subagent type; ${modelClause}; description: a short (3-5 word) summary of the task (required); ` +
      "max_turns: optional cap (1-50) on the child's own tool-use iterations, after which it stops with an error (omit to inherit the default cap).",
    args: SpawnArgs,
    run(_args: z.infer<typeof SpawnArgs>) {
      return "subagents are not available in this session";
    },
  });
}
