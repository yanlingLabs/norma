import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { McpManager } from "../../../src/agent/mcp/manager";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { TrustStore } from "../../../src/agent/trust";

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const ctx = (): ToolContext => ({ cwd: "/tmp", roots: ["/tmp"], sessionId: "s1" });
const isMac = process.platform === "darwin";
function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "mcp-mgr-"))); }

describe.if(isMac)("McpManager", () => {
  test("startAll registers mcp__fake__echo; execute dispatches to the server", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE] } });
    expect(registry.has("mcp__fake__echo")).toBe(true);
    const out = await registry.execute("mcp__fake__echo", { msg: "hi" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("echo: hi");
    expect(mgr.list()).toEqual([{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }]);
    mgr.stopAll();
  });

  test("a bad-command server is skipped; a good one still registers (one bad ≠ dead)", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
    await mgr.startAll({ good: { command: "bun", args: ["run", FIXTURE] }, bad: { command: "this-command-does-not-exist-xyz" } });
    expect(registry.has("mcp__good__echo")).toBe(true);
    expect(mgr.list().find((s) => s.name === "bad")!.status).toBe("failed");
    expect(mgr.list().find((s) => s.name === "good")!.status).toBe("connected");
    mgr.stopAll();
  });

  test("a server with duplicate tool names (register throws) is skipped; a sibling good server still registers (one bad ≠ dead)", async () => {
    const registry = new ToolRegistry();
    const mgr = new McpManager({ registry, trust: new TrustStore(join(realDir(), "trust.json")) });
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

function projDir(withServer = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-proj-")));
  if (withServer) writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", FIXTURE] } } }));
  return dir;
}

describe.if(isMac)("McpManager.ensureProject", () => {
  test("UNTRUSTED project .mcp.json → nothing starts/registers (SECURITY)", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json"));
    const mgr = new McpManager({ registry, trust });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(false); // not spawned/registered while untrusted
    // and NOT recorded — retries after trust:
    trust.trust(dir);
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    mgr.stopAll();
  });

  test("TRUSTED project → tool registered with scope=dir + callable", async () => {
    const dir = projDir();
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    await mgr.ensureProject(dir);
    expect(registry.has("mcp__proj__echo")).toBe(true);
    const out = await registry.execute("mcp__proj__echo", { msg: "hi" }, { cwd: dir, roots: [dir], sessionId: "s" });
    expect(out.output).toBe("echo: hi");
    // scope enforced: a call from another cwd is rejected
    const other = realDir();
    expect((await registry.execute("mcp__proj__echo", { msg: "x" }, { cwd: other, roots: [other], sessionId: "s" })).isError).toBe(true);
    mgr.stopAll();
  });

  test("malformed .mcp.json → skip, no throw; idempotent 2nd call", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-bad-")));
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    const registry = new ToolRegistry();
    const trust = new TrustStore(join(realDir(), "trust.json")); trust.trust(dir);
    const mgr = new McpManager({ registry, trust });
    await expect(mgr.ensureProject(dir)).resolves.toBeUndefined();
    await mgr.ensureProject(dir); // idempotent
    mgr.stopAll();
  });
});
