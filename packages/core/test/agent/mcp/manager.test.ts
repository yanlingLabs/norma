import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpManager } from "../../../src/agent/mcp/manager";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const ctx = (): ToolContext => ({ cwd: "/tmp", roots: ["/tmp"], sessionId: "s1" });
const isMac = process.platform === "darwin";

describe.if(isMac)("McpManager", () => {
  test("startAll registers mcp__fake__echo; execute dispatches to the server", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE] } });
    expect(registry.has("mcp__fake__echo")).toBe(true);
    const out = await registry.execute("mcp__fake__echo", { msg: "hi" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("echo: hi");
    expect(mgr.list()).toEqual([{ name: "fake", status: "connected", toolNames: ["echo"] }]);
    mgr.stopAll();
  });

  test("a bad-command server is skipped; a good one still registers (one bad ≠ dead)", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry });
    await mgr.startAll({ good: { command: "bun", args: ["run", FIXTURE] }, bad: { command: "this-command-does-not-exist-xyz" } });
    expect(registry.has("mcp__good__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "bad")!.status).toBe("failed");
    expect(mgr.list().find((s) => s.name === "good")!.status).toBe("connected");
    mgr.stopAll();
  });

  test("a server with duplicate tool names (register throws) is skipped; a sibling good server still registers (one bad ≠ dead)", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry });
    await mgr.startAll({
      good: { command: "bun", args: ["run", FIXTURE] },
      dup: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_DUP: "1" } },
    });
    // startAll must never throw regardless of one server's registration failure.
    expect(registry.has("mcp__good__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "good")!.status).toBe("connected");
    expect(mgr.list().find((s) => s.name === "dup")!.status).toBe("failed");
    mgr.stopAll();
  });
});
