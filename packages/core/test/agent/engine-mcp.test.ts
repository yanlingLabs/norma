import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { McpManager } from "../../src/agent/mcp/manager";
import { TrustStore } from "../../src/agent/trust";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";

const FIXTURE = join(import.meta.dir, "mcp", "fake-mcp-server.ts");
const isMac = process.platform === "darwin";

function realDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function writeProjectMcpJson(dir: string): void {
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", FIXTURE] } } }));
}

const oneRoundEndTurn = () => new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);

// Session-aware project MCP wiring: ensureProject(cwd) runs at the TOP of turn() (before the
// turn's tools are requested from the provider) and specs(cwd) filters project-scoped tools to
// sessions whose cwd is trusted + inside the project dir. Guarded to macOS because the fixture
// MCP server (fake-mcp-server.ts) is spawned as a real subprocess via McpStdioClient, mirroring
// packages/core/test/agent/mcp/manager.test.ts.
describe.if(isMac)("engine + project MCP (session-aware)", () => {
  test("trusted session cwd: ensureProject runs at turn start, specs(cwd) surfaces the project tool", async () => {
    const dir = realDir("engine-mcp-trusted-");
    writeProjectMcpJson(dir);
    const trust = new TrustStore(join(realDir("engine-mcp-trust-"), "trust.json"));
    trust.trust(dir);
    const registry = new ToolRegistry();
    const mcp = new McpManager({ registry, trust });

    const provider = oneRoundEndTurn();
    const { engine, sessionId } = setupEngine(provider, { cwd: dir, registry, mcp });
    await engine.runTurn(sessionId);

    const toolNames = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("mcp__proj__echo");

    mcp.stopAll();
  });

  test("untrusted/other session cwd: the project tool is absent from tools, and a direct execute is rejected (defense-in-depth)", async () => {
    // The project is trusted + already started for its OWN dir (as if another session had
    // already triggered ensureProject for it).
    const trustedDir = realDir("engine-mcp-trusted2-");
    writeProjectMcpJson(trustedDir);
    const trust = new TrustStore(join(realDir("engine-mcp-trust2-"), "trust.json"));
    trust.trust(trustedDir);
    const registry = new ToolRegistry();
    const mcp = new McpManager({ registry, trust });
    await mcp.ensureProject(trustedDir);
    expect(registry.has("mcp__proj__echo")).toBe(true);

    // A DIFFERENT session, whose cwd is neither the trusted project dir nor itself trusted.
    const untrustedDir = realDir("engine-mcp-untrusted-");
    const provider = oneRoundEndTurn();
    const { engine, sessionId } = setupEngine(provider, { cwd: untrustedDir, registry, mcp });
    await engine.runTurn(sessionId);

    const toolNames = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(toolNames).not.toContain("mcp__proj__echo");

    // Defense-in-depth: even a direct execute call scoped to the untrusted cwd is rejected,
    // regardless of what the model was shown.
    const out = await registry.execute("mcp__proj__echo", { msg: "hi" }, { cwd: untrustedDir, roots: [untrustedDir], sessionId: "s" });
    expect(out.isError).toBe(true);

    mcp.stopAll();
  });
});
