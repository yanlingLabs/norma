export type GateDecision = "allow" | "ask";
export type SessionApprovalPolicy = "ask" | "auto";

const READ_ONLY = new Set(["read", "glob", "grep", "bash_output"]);
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
    return "ask";
  }
}
