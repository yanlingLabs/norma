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
});
