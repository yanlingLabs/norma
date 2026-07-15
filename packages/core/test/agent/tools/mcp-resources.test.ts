import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync } from "node:fs";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { registerMcpResourceTools } from "../../../src/agent/tools/mcp-resources";
import { McpManager } from "../../../src/agent/mcp/manager";
import { TrustStore } from "../../../src/agent/trust";

const FIXTURE = join(import.meta.dir, "..", "mcp", "fake-mcp-server.ts");
const isMac = process.platform === "darwin";
function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "mcp-res-"))); }

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1", ...overrides };
}

async function makeMgr() {
  const registry = new ToolRegistry();
  const trust = new TrustStore(join(realDir(), "trust.json"));
  const mgr = new McpManager({ registry, trust });
  registerMcpResourceTools(registry, { mcp: mgr });
  return { registry, mgr };
}

describe.if(isMac)("list_mcp_resources / read_mcp_resource (CC parity — MCP resources)", () => {
  test("no resource-capable servers connected → clean, non-error result (server omitted)", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ plain: { command: "bun", args: ["run", FIXTURE] } }); // no NORMA_FAKE_RESOURCES
    const out = await registry.execute("list_mcp_resources", {}, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("No resource-capable MCP servers are currently connected.");
    mgr.stopAll();
  });

  test("list across every resource-capable server (server omitted); a plain server is excluded", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({
      plain: { command: "bun", args: ["run", FIXTURE] },
      res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } },
    });
    const out = await registry.execute("list_mcp_resources", {}, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("## res");
    expect(out.output).toContain("uri: fake://greeting");
    expect(out.output).toContain("name: greeting");
    expect(out.output).toContain("description: A greeting text resource");
    expect(out.output).toContain("mimeType: text/plain");
    expect(out.output).toContain("uri: fake://pixel");
    expect(out.output).not.toContain("## plain");
    mgr.stopAll();
  });

  test("scoped list (server given) returns just that server's section", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    const out = await registry.execute("list_mcp_resources", { server: "res" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output.startsWith("## res")).toBe(true);
    expect(out.output).toContain("fake://greeting");
    mgr.stopAll();
  });

  test("scoped list with an unknown server name → isError", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    const out = await registry.execute("list_mcp_resources", { server: "nope" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("unknown MCP server");
    mgr.stopAll();
  });

  test("scoped list against a connected-but-non-capable server → isError", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ plain: { command: "bun", args: ["run", FIXTURE] } });
    const out = await registry.execute("list_mcp_resources", { server: "plain" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("does not expose resources");
    mgr.stopAll();
  });

  test("read text resource → verbatim contents", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    const out = await registry.execute("read_mcp_resource", { server: "res", uri: "fake://greeting" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("hello from fake resource");
    mgr.stopAll();
  });

  test("read image blob without a vision-capable model → binary summary, no attach", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    let attached: string | undefined;
    const out = await registry.execute("read_mcp_resource", { server: "res", uri: "fake://pixel" }, ctx({
      attachImage: (dataUrl) => { attached = dataUrl; },
      visionCapable: false,
    }));
    expect(out.isError).toBe(false);
    expect(out.output).toMatch(/^\[binary image\/png, \d+ bytes — base64 omitted\]$/);
    expect(attached).toBeUndefined();
    mgr.stopAll();
  });

  test("read image blob WITH a vision-capable model → attaches via ctx.attachImage", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    let attached: string | undefined;
    const out = await registry.execute("read_mcp_resource", { server: "res", uri: "fake://pixel" }, ctx({
      attachImage: (dataUrl) => { attached = dataUrl; },
      visionCapable: true,
    }));
    expect(out.isError).toBe(false);
    expect(out.output).toContain("The image follows this result as the next message.");
    expect(attached).toMatch(/^data:image\/png;base64,/);
    mgr.stopAll();
  });

  test("read unknown uri → isError", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    const out = await registry.execute("read_mcp_resource", { server: "res", uri: "fake://nope" }, ctx());
    expect(out.isError).toBe(true);
    mgr.stopAll();
  });

  test("read with an unknown server name → isError", async () => {
    const { registry, mgr } = await makeMgr();
    await mgr.startAll({ res: { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } } });
    const out = await registry.execute("read_mcp_resource", { server: "nope", uri: "fake://greeting" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("unknown MCP server");
    mgr.stopAll();
  });
});
