import { z } from "zod";
import { McpStdioClient } from "./client";
import type { ToolRegistry } from "../tools/registry";

export interface McpServerStatus { name: string; status: "connected" | "failed"; toolNames: string[] }
export interface McpServerConfig { command: string; args?: string[]; env?: Record<string, string> }

export class McpManager {
  private clients = new Map<string, McpStdioClient>();
  private statuses = new Map<string, McpServerStatus>();
  constructor(private readonly deps: { registry: ToolRegistry; log?: (m: string) => void }) {}

  async startAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(Object.entries(servers).map(async ([name, cfg]) => {
      const client = new McpStdioClient(cfg);
      try {
        await client.start();
        this.clients.set(name, client);
        const toolNames: string[] = [];
        for (const t of client.tools()) {
          const full = `mcp__${name}__${t.name}`;
          this.deps.registry.register({
            name: full,
            description: t.description,
            args: z.object({}).passthrough(),
            rawParameters: t.inputSchema,
            run: (args, ctx) => client.callTool(t.name, args, ctx.signal),
          });
          toolNames.push(t.name);
        }
        this.statuses.set(name, { name, status: "connected", toolNames });
      } catch (e) {
        this.deps.log?.(`mcp: server '${name}' failed to start: ${(e as Error).message}`);
        this.statuses.set(name, { name, status: "failed", toolNames: [] });
        this.clients.delete(name);
        client.stop();
        return;
      }
    }));
  }

  list(): McpServerStatus[] { return [...this.statuses.values()]; }
  stopAll(): void { for (const c of this.clients.values()) c.stop(); this.clients.clear(); }
}
