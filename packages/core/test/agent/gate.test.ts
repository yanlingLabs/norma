import { describe, expect, test } from "bun:test";
import { PermissionGate } from "../../src/agent/gate";

describe("PermissionGate v1", () => {
  const gate = new PermissionGate();

  test("read-only tools are allowed under both policies", () => {
    for (const name of ["read", "glob", "grep", "ls"]) {
      expect(gate.evaluate(name, "ask")).toBe("allow");
      expect(gate.evaluate(name, "auto")).toBe("allow");
    }
  });

  test("mutating tools ask under ask-policy, allow under auto-policy", () => {
    for (const name of ["write", "edit"]) {
      expect(gate.evaluate(name, "ask")).toBe("ask");
      expect(gate.evaluate(name, "auto")).toBe("allow");
    }
  });

  test("unknown tools always ask (fail-closed toward the human)", () => {
    expect(gate.evaluate("mystery", "auto")).toBe("ask");
  });

  test("request_directory self-gates via its own ApprovalBroker prompt (the engine gate must not also ask — would double-prompt); fail-closed is preserved for genuinely unknown tools", () => {
    expect(gate.evaluate("request_directory", "ask")).toBe("allow");
    expect(gate.evaluate("request_directory", "auto")).toBe("allow");
    expect(gate.evaluate("mystery", "ask")).toBe("ask");
    expect(gate.evaluate("mystery", "auto")).toBe("ask");
  });

  test("bash is a mutating tool: ask under ask-policy, allow under auto", () => {
    const gate = new PermissionGate();
    expect(gate.evaluate("bash", "ask")).toBe("ask");
    expect(gate.evaluate("bash", "auto")).toBe("allow");
  });

  test("bash_output is read-only: always allowed", () => {
    expect(gate.evaluate("bash_output", "ask")).toBe("allow");
  });

  test("bash_kill is mutating: ask under ask-policy, allow under auto-policy", () => {
    expect(gate.evaluate("bash_kill", "ask")).toBe("ask");
    expect(gate.evaluate("bash_kill", "auto")).toBe("allow");
  });

  test("Skill is read-only: always allowed (loading a skill body must not require approval)", () => {
    expect(gate.evaluate("Skill", "ask")).toBe("allow");
    expect(gate.evaluate("Skill", "auto")).toBe("allow");
  });

  test("mcp__ tools are approval-per-policy (like bash): allow under auto, ask under ask", () => {
    const g = new PermissionGate();
    expect(g.evaluate("mcp__srv__tool", "auto")).toBe("allow");
    expect(g.evaluate("mcp__srv__tool", "ask")).toBe("ask");
    expect(g.evaluate("read", "ask")).toBe("allow"); // READ_ONLY unchanged
  });

  // Phase 4b Task 4 (spec §3): "plugin.register/tool.register supplies name + one-liner ...
  // registered into ToolRegistry as plugin__<id>__<tool>, gated like MCP (approval per policy,
  // never READ_ONLY)". Byte-identical to the mcp__ test above — plugin__ must hit the SAME branch.
  test("plugin__ tools are gated EXACTLY like mcp__ tools: approval-per-policy (never READ_ONLY), allow under auto, ask under ask", () => {
    const g = new PermissionGate();
    expect(g.evaluate("plugin__sample-echo__echo", "auto")).toBe("allow");
    expect(g.evaluate("plugin__sample-echo__echo", "ask")).toBe("ask");
    expect(g.evaluate("read", "ask")).toBe("allow"); // READ_ONLY unchanged
  });

  test("ToolSearch is read-only: always allowed (loading a deferred tool's schema must not require approval)", () => {
    expect(gate.evaluate("ToolSearch", "ask")).toBe("allow");
    expect(gate.evaluate("ToolSearch", "auto")).toBe("allow");
  });

  test("ask_user + task tools are allow under ask policy", () => {
    for (const t of ["ask_user", "task_create", "task_update", "task_list"]) expect(gate.evaluate(t, "ask")).toBe("allow");
  });

  test("ask/auto matrices unchanged (byte-identical snapshot)", () => {
    const g = new PermissionGate();
    for (const p of ["ask", "auto"] as const) {
      for (const [t, exp] of [
        ["read", "allow"],
        ["write", p === "auto" ? "allow" : "ask"],
        ["bash", p === "auto" ? "allow" : "ask"],
        ["mcp__x__y", p === "auto" ? "allow" : "ask"],
        ["plugin__x__y", p === "auto" ? "allow" : "ask"],
        ["frobnicate", "ask"],
      ] as const) {
        expect(g.evaluate(t, p)).toBe(exp);
      }
    }
  });

  test("plan matrix: read-only + exit_plan_mode + ask_user + task_* allow; write/edit/bash/bash_kill/mcp/plugin deny; unclassified deny", () => {
    const g = new PermissionGate();
    for (const t of ["read", "glob", "grep", "ls", "Skill", "ToolSearch", "ask_user", "task_create", "task_list", "exit_plan_mode", "request_directory"]) {
      expect(g.evaluate(t, "plan")).toBe("allow");
    }
    for (const t of ["write", "edit", "bash", "bash_kill", "mcp__x__y", "plugin__x__y", "frobnicate"]) {
      expect(g.evaluate(t, "plan")).toBe("deny");
    }
  });

  // 4g Task 5: web_fetch is Norma's only network-capable tool. It gets its OWN gate class
  // (NETWORK), distinct from both READ_ONLY and MUTATING, because its plan-mode answer differs
  // from MUTATING's (allow, not deny — read-only research is legitimate while planning) while its
  // ask/auto answer is IDENTICAL to MUTATING's/bash's (ask under `ask`, allow under `auto`).
  test("web_fetch is gate-classed NETWORK: allow under plan and auto, ask under ask", () => {
    const g = new PermissionGate();
    expect(g.evaluate("web_fetch", "plan")).toBe("allow");
    expect(g.evaluate("web_fetch", "auto")).toBe("allow");
    expect(g.evaluate("web_fetch", "ask")).toBe("ask");
  });

  test("web_fetch must NOT be classed READ_ONLY: it diverges from bash in plan mode (allow) but must match bash's ask/auto answer exactly, not read-only's unconditional allow", () => {
    const g = new PermissionGate();
    // If web_fetch were accidentally READ_ONLY, "ask" policy would wrongly return "allow" here.
    expect(g.evaluate("web_fetch", "ask")).toBe(g.evaluate("bash", "ask"));
    expect(g.evaluate("web_fetch", "auto")).toBe(g.evaluate("bash", "auto"));
  });

  // 4g Task 6: web_search joins web_fetch in the NETWORK class — same live-network-call posture
  // (read-only research, no arbitrary fs/process mutation, but still a real outbound HTTP call to
  // a third party), so it gets the IDENTICAL plan/ask/auto answer as web_fetch above.
  test("web_search is gate-classed NETWORK: allow under plan and auto, ask under ask", () => {
    const g = new PermissionGate();
    expect(g.evaluate("web_search", "plan")).toBe("allow");
    expect(g.evaluate("web_search", "auto")).toBe("allow");
    expect(g.evaluate("web_search", "ask")).toBe("ask");
  });
});
