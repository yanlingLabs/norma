import { z } from "zod";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { McpStdioClient } from "./client";
import type { ToolRegistry } from "../tools/registry";
import type { TrustStore } from "../trust";

export interface McpServerStatus { name: string; status: "connected" | "failed"; toolNames: string[]; source: "user" | "project" }
export interface McpServerConfig { command: string; args?: string[]; env?: Record<string, string> }

const ProjectMcpConfig = z.object({
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
});
type ProjectState = { kind: "none" } | { kind: "started"; servers: McpServerStatus[]; clients: McpStdioClient[]; toolNames: string[] };

export class McpManager {
  private clients = new Map<string, McpStdioClient>();
  private statuses = new Map<string, McpServerStatus>();
  private projects = new Map<string, ProjectState>();
  constructor(private readonly deps: { registry: ToolRegistry; trust: TrustStore; log?: (m: string) => void }) {}

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
        this.statuses.set(name, { name, status: "connected", toolNames, source: "user" });
      } catch (e) {
        this.deps.log?.(`mcp: server '${name}' failed to start: ${(e as Error).message}`);
        this.statuses.set(name, { name, status: "failed", toolNames: [], source: "user" });
        this.clients.delete(name);
        client.stop();
        return;
      }
    }));
  }

  /**
   * Trust-gated project `.mcp.json` bring-up. Idempotent per canonicalized cwd (a "none" or
   * "started" record short-circuits future calls). SECURITY: an untrusted dir returns WITHOUT
   * recording anything — nothing is read/spawned/registered, and a later `trust.trust(dir)` +
   * another `ensureProject` call will retry and start it. Defensive: a missing/malformed
   * `.mcp.json` degrades to a recorded "none" rather than throwing. Every server start is
   * individually guarded (mirrors `startAll`) so one bad server doesn't block its siblings.
   */
  async ensureProject(cwd: string): Promise<void> {
    let dir: string;
    try { dir = realpathSync(cwd); } catch { dir = cwd; }
    if (this.projects.has(dir)) return; // already started or recorded "none"
    if (!this.deps.trust.isTrusted(dir)) return; // untrusted → not recorded (retry after trust)

    let cfg: z.infer<typeof ProjectMcpConfig>;
    try {
      cfg = ProjectMcpConfig.parse(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")));
    } catch {
      this.projects.set(dir, { kind: "none" }); // missing/malformed → record none
      return;
    }
    const servers = cfg.mcpServers ?? {};
    if (Object.keys(servers).length === 0) {
      this.projects.set(dir, { kind: "none" });
      return;
    }

    const state: ProjectState = { kind: "started", servers: [], clients: [], toolNames: [] };
    await Promise.all(Object.entries(servers).map(async ([name, sc]) => {
      const client = new McpStdioClient(sc);
      try {
        await client.start();
      } catch (e) {
        this.deps.log?.(`mcp: project server '${name}' (${dir}) failed: ${(e as Error).message}`);
        state.servers.push({ name, status: "failed", toolNames: [], source: "project" });
        client.stop();
        return;
      }
      const toolNames: string[] = [];
      for (const t of client.tools()) {
        const full = `mcp__${name}__${t.name}`;
        if (this.deps.registry.has(full)) {
          this.deps.log?.(`mcp: project tool '${full}' collides — skipped`);
          continue;
        }
        try {
          this.deps.registry.register({
            name: full,
            description: t.description,
            args: z.object({}).passthrough(),
            rawParameters: t.inputSchema,
            scope: dir,
            run: (a, ctx) => client.callTool(t.name, a, ctx.signal),
          });
        } catch (e) {
          this.deps.log?.(`mcp: register '${full}' failed: ${(e as Error).message}`);
          continue;
        }
        toolNames.push(t.name);
        state.toolNames.push(full);
      }
      state.clients.push(client);
      state.servers.push({ name, status: "connected", toolNames, source: "project" });
    }));
    this.projects.set(dir, state);
  }

  /**
   * SYNC/PURE: returns already-known statuses without spawning/reading anything. User servers
   * (source "user") are always included; project servers (source "project") for `cwd` are
   * included only if `ensureProject(cwd)` has already recorded a "started" state for it — this
   * method does NOT call `ensureProject` itself (callers, e.g. the daemon's request handler,
   * must `await ensureProject(cwd)` first).
   */
  list(cwd?: string): McpServerStatus[] {
    const out = [...this.statuses.values()];
    if (cwd) {
      let dir: string;
      try { dir = realpathSync(cwd); } catch { dir = cwd; }
      const state = this.projects.get(dir);
      if (state?.kind === "started") out.push(...state.servers);
    }
    return out;
  }

  stopAll(): void {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
    for (const state of this.projects.values()) {
      if (state.kind === "started") {
        for (const c of state.clients) c.stop();
        for (const n of state.toolNames) this.deps.registry.unregister(n);
      }
    }
    this.projects.clear();
  }
}
