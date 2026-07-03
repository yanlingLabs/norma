export type GateDecision = "allow" | "ask";
export type SessionApprovalPolicy = "ask" | "auto";

// Skill is read-only: it reads a SKILL.md body and marks it loaded in-memory (no filesystem
// mutation) — same class as read/glob/grep. Without this it would fall through to the
// unclassified "always ask" branch below, which would block session-sticky skill loading even
// under `auto` policy (that branch ignores policy entirely, by design — fail-closed for
// genuinely unknown tools).
const READ_ONLY = new Set(["read", "glob", "grep", "bash_output", "Skill"]);
const MUTATING = new Set(["write", "edit", "bash", "bash_kill"]);
const SELF_GATING = new Set(["request_directory"]);

/**
 * v1 policy matrix (spec §4.10 arrives fully in 1b-ii with the AI reviewer):
 * read-only tools always allowed; mutating tools follow the session policy;
 * anything unrecognized asks — fail-closed toward the human.
 */
export class PermissionGate {
  evaluate(toolName: string, policy: SessionApprovalPolicy): GateDecision {
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
