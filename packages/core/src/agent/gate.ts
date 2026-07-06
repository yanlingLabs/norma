export type GateDecision = "allow" | "ask" | "deny";
export type SessionApprovalPolicy = "ask" | "auto" | "plan";

// Skill is read-only: it reads a SKILL.md body and marks it loaded in-memory (no filesystem
// mutation) — same class as read/glob/grep. Without this it would fall through to the
// unclassified "always ask" branch below, which would block session-sticky skill loading even
// under `auto` policy (that branch ignores policy entirely, by design — fail-closed for
// genuinely unknown tools).
// ToolSearch is the same class: it reads the (in-memory) deferred tool index and marks matched
// tools loaded for the session — no filesystem/network mutation. It must be classified here (not
// left to fall through, and NOT matched by the `mcp__` prefix check below — its own name never
// starts with `mcp__`) so schema-loading itself never requires approval, even under `ask` policy.
// ask_user/task_create/task_update/task_list are read-only too: ask_user only emits a
// question_asked event and blocks on the QuestionBroker (no fs/process mutation — the human is
// the approval, so a gate prompt on top would double-ask); the task tools (registered in a later
// task) only maintain in-memory/session task state and emit task_updated.
// exit_plan_mode is read-only too: it only presents a plan for approval (no fs/process mutation)
// — it must stay allowed under "plan" policy or the model could never exit plan mode.
// spawn_agent is read-only too: allowed in ALL modes, including plan — it's orchestration (launching
// a child agent), not a mutation itself. The child inherits the parent's approval policy (engine.ts's
// bridge passes the SAME `meta` object down), so the child's own mutating tool calls still get gated
// by that policy — spawning doesn't bypass anything, it just delegates.
const READ_ONLY = new Set(["read", "glob", "grep", "ls", "bash_output", "Skill", "ToolSearch", "ask_user", "task_create", "task_update", "task_list", "exit_plan_mode", "spawn_agent"]);
const MUTATING = new Set(["write", "edit", "bash", "bash_kill", "notebook_edit", "enter_worktree", "exit_worktree"]);
const SELF_GATING = new Set(["request_directory"]);

/**
 * v1 policy matrix (spec §4.10 arrives fully in 1b-ii with the AI reviewer):
 * read-only tools always allowed; mutating tools follow the session policy;
 * anything unrecognized asks — fail-closed toward the human.
 */
export class PermissionGate {
  evaluate(toolName: string, policy: SessionApprovalPolicy): GateDecision {
    // Plan mode: only reads/self-gating tools (incl. exit_plan_mode, ask_user, task_*) are allowed;
    // everything else (writes/edit/bash/mcp__/unclassified) is denied outright — no prompt, since the
    // whole point of plan mode is that nothing mutates until the plan is approved.
    if (policy === "plan") {
      if (READ_ONLY.has(toolName)) return "allow"; // incl. exit_plan_mode, ask_user, task_*
      if (SELF_GATING.has(toolName)) return "allow"; // request_directory only asks for a dir
      return "deny"; // write/edit/bash/mcp__/unclassified — all blocked while planning
    }
    if (READ_ONLY.has(toolName)) return "allow";
    if (MUTATING.has(toolName)) return policy === "auto" ? "allow" : "ask";
    // request_directory self-gates via ApprovalBroker (path+persist-aware) — a generic gate prompt here would double-prompt
    if (SELF_GATING.has(toolName)) return "allow";
    // MCP tools are external code (network/fs/arbitrary) → approval-per-policy like bash: allowed under
    // `auto`, prompt under `ask`. Must NOT be READ_ONLY, and must NOT fall to the unclassified always-ask
    // branch below (that would block MCP tool use even under `auto`).
    if (toolName.startsWith("mcp__")) return policy === "auto" ? "allow" : "ask";
    return "ask";
  }
}
