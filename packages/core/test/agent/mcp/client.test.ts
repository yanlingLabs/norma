import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpStdioClient } from "../../../src/agent/mcp/client";

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const isMac = process.platform === "darwin";

describe.if(isMac)("McpStdioClient", () => {
  test("handshake lists tools; callTool echoes", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE] });
    await c.start();
    expect(c.tools().map((t) => t.name)).toEqual(["echo"]);
    expect(c.tools()[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(await c.callTool("echo", { msg: "hi" })).toBe("echo: hi");
    c.stop();
  });

  test("startup timeout → start() rejects (server never responds)", async () => {
    const c = new McpStdioClient({ command: "sleep", args: ["30"] }); // reads nothing, never replies
    await expect(c.start(300)).rejects.toThrow();
    c.stop();
  });

  test("after stop(), callTool rejects (not running)", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE] });
    await c.start();
    c.stop();
    expect(c.dead).toBe(true);
    await expect(c.callTool("echo", { msg: "x" })).rejects.toThrow();
  });
});
