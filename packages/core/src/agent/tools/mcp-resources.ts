import { z } from "zod";
import type { ToolRegistry, ToolContext } from "./registry";
import type { McpManager } from "../mcp/manager";
import type { McpResourceInfo, McpResourceContent } from "../mcp/client";
import { attachImageGuarded, base64DecodedBytes } from "./attach-image";

/**
 * CC parity: `ListMcpResourcesTool` / `ReadMcpResourceTool` — two FIXED built-in tools (NOT
 * `mcp__<server>__<tool>` proxies, so they never ride `isExternalToolName`'s external-count
 * deferral trigger; they're plain built-ins that ride the SAME `deferred: true` mechanism as
 * Norma's other specialized built-ins — e.g. `schedule`, `notebook_edit`, `worktree`. That
 * broader-than-CC deferral (CC keeps its fixed catalogue eager) is a deliberate, noted
 * divergence, consistent with how every comparable Norma built-in registers.
 *
 * CONDITIONAL REGISTRATION: CC registers these two tools only when at least one connected server
 * declares resources support. Norma's `ToolRegistry` has no per-tool "is this visible right now"
 * predicate beyond `scope` (cwd) and the deferred/loaded machinery — both are static per
 * registration, not a live capability check — and MCP servers connect/disconnect at several
 * independent points (boot `startAll`, per-cwd `ensureProject`, `startPlugins`), so there is no
 * cheap hook to flip registration on/off as servers come and go. Given the task's explicit
 * permission to diverge here: these two tools are ALWAYS registered (whenever the daemon wires an
 * McpManager at all — daemon.ts, alongside every other tool registration), and instead resolve
 * their own "no resource-capable servers" case at RUN time with a clean, honest result string
 * (never a throw) — see `list_mcp_resources` below. `read_mcp_resource` with an unknown/
 * non-capable `server` DOES throw (isError:true) since that's a concrete, resolvable user/model
 * mistake, not a "nothing to see here" state.
 */
export function registerMcpResourceTools(r: ToolRegistry, deps: { mcp: McpManager }, opts?: { deferred?: boolean }): void {
  const { mcp } = deps;

  r.register({
    name: "list_mcp_resources",
    description:
      "List resources exposed by connected MCP servers. Omit `server` to list across every resource-capable connected server; pass `server` to scope the listing to one. Use `read_mcp_resource` with a listed `uri` to fetch a resource's contents.",
    args: z.object({ server: z.string().min(1).optional() }),
    deferred: opts?.deferred,
    async run({ server }, ctx) {
      if (server) {
        const client = mcp.findServer(ctx.cwd, server);
        if (!client) throw new Error(`unknown MCP server: ${server}`);
        if (!client.resourcesCapable()) throw new Error(`MCP server '${server}' does not expose resources`);
        return renderServerSection(server, await client.listResources(ctx.signal));
      }
      const servers = mcp.resourceServers(ctx.cwd);
      if (servers.length === 0) return "No resource-capable MCP servers are currently connected.";
      const sections = await Promise.all(servers.map(async ({ name, client }) => {
        try {
          return renderServerSection(name, await client.listResources(ctx.signal));
        } catch (e) {
          return `## ${name}\n[error listing resources: ${e instanceof Error ? e.message : String(e)}]`;
        }
      }));
      return sections.join("\n\n");
    },
  });

  r.register({
    name: "read_mcp_resource",
    description:
      "Read an MCP resource by server name and URI (from list_mcp_resources). Text contents are returned verbatim; binary contents are summarized unless they're an image and the model can view images, in which case the image is attached.",
    args: z.object({ server: z.string().min(1), uri: z.string().min(1) }),
    deferred: opts?.deferred,
    async run({ server, uri }, ctx) {
      const client = mcp.findServer(ctx.cwd, server);
      if (!client) throw new Error(`unknown MCP server: ${server}`);
      if (!client.resourcesCapable()) throw new Error(`MCP server '${server}' does not expose resources`);
      const contents = await client.readResource(uri, ctx.signal);
      if (contents.length === 0) throw new Error(`no contents returned for resource ${uri} on server '${server}'`);
      const rendered = contents.map((c) => renderResourceContent(c, ctx));
      return rendered.length === 1
        ? rendered[0]!
        : rendered.map((body, i) => `-- content ${i + 1} (${contents[i]!.uri}) --\n${body}`).join("\n\n");
    },
  });
}

function renderServerSection(name: string, resources: McpResourceInfo[]): string {
  if (resources.length === 0) return `## ${name}\n(no resources)`;
  const lines = resources.map((res) => {
    const parts = [`- uri: ${res.uri}`];
    if (res.name) parts.push(`  name: ${res.name}`);
    if (res.description) parts.push(`  description: ${res.description}`);
    if (res.mimeType) parts.push(`  mimeType: ${res.mimeType}`);
    return parts.join("\n");
  });
  return `## ${name}\n${lines.join("\n")}`;
}

/** Text verbatim (the registry's own 64KB MAX_OUTPUT still applies on top, exactly like any other
 *  tool output). Blob: binary summary UNLESS it's an image and the model can actually see it
 *  (`ctx.visionCapable` — the same CU-independent bridge multimodal-read's `read` tool rides),
 *  in which case it rides `attachImageGuarded` (parity-tail review): the shared IMAGE_MAX_BYTES
 *  cap applies, and an oversized blob renders the guard's "[image omitted: ...]" note WITHOUT
 *  ever being decoded — all byte counts here come from `base64DecodedBytes` (length math), so an
 *  arbitrarily large server-sent blob never costs a full Buffer decode just to be refused. When
 *  the guard attaches, the returned string never carries the base64 bytes (bypasses MAX_OUTPUT
 *  exactly like a CU screenshot / an image `read`). Exported for direct tests (web.ts's
 *  ssrfGuard/htmlToText precedent). */
export function renderResourceContent(c: McpResourceContent, ctx: ToolContext): string {
  if (typeof c.text === "string") return c.text;
  if (typeof c.blob === "string") {
    const mime = c.mimeType ?? "application/octet-stream";
    const bytes = base64DecodedBytes(c.blob);
    if (mime.startsWith("image/") && ctx.visionCapable && ctx.attachImage) {
      const note = attachImageGuarded(ctx, { mime, base64: c.blob });
      if (note) return note;
      return `Image resource ${c.uri} (${mime}, ${bytes} bytes). The image follows this result as the next message.`;
    }
    return `[binary ${mime}, ${bytes} bytes — base64 omitted]`;
  }
  return "[empty resource content]";
}
