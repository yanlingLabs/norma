import { describe, expect, test } from "bun:test";
import { PermissionGate } from "../../src/agent/gate";

describe("PermissionGate v1", () => {
  const gate = new PermissionGate();

  test("read-only tools are allowed under both policies", () => {
    for (const name of ["read", "glob", "grep"]) {
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

  test("ToolSearch is read-only: always allowed (loading a deferred tool's schema must not require approval)", () => {
    expect(gate.evaluate("ToolSearch", "ask")).toBe("allow");
    expect(gate.evaluate("ToolSearch", "auto")).toBe("allow");
  });
});
