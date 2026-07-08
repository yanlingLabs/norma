import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import type { ToolContext } from "../../src/agent/tools/registry";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";

// 14 stub mcp__ tools spanning a few "services" so keyword search has something to rank.
const STUB_MCP: Array<[string, string]> = [
  ["mcp__slack__send", "Send a slack message"],
  ["mcp__slack__read", "Read slack channels"],
  ["mcp__jira__create", "Create a jira ticket"],
  ["mcp__jira__read", "Read jira tickets"],
  ["mcp__jira__update", "Update a jira ticket"],
  ["mcp__github__create_pr", "Create a github pull request"],
  ["mcp__github__list_issues", "List github issues"],
  ["mcp__github__merge_pr", "Merge a github pull request"],
  ["mcp__notion__create_page", "Create a notion page"],
  ["mcp__notion__search", "Search notion pages"],
  ["mcp__figma__get_file", "Get a figma file"],
  ["mcp__figma__comment", "Comment on a figma file"],
  ["mcp__zoom__schedule", "Schedule a zoom meeting"],
  ["mcp__zoom__list", "List zoom meetings"],
];

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerToolSearchTool(r);
  for (const [name, description] of STUB_MCP) {
    r.register({ name, description, args: z.object({}).passthrough(), run: () => "ok" });
  }
  return r;
}

function ctxWith(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/", roots: ["/"], sessionId: "s", ...overrides };
}

describe("ToolSearch", () => {
  test("select: loads exact names and returns their schemas", async () => {
    const r = buildRegistry();
    const loaded = new Set<string>();
    const marks: string[] = [];
    const out = await r.execute(
      "ToolSearch",
      { query: "select:mcp__slack__send,mcp__jira__create" },
      ctxWith({ loadedTools: loaded, deferThreshold: 12, markToolLoaded: (n) => { marks.push(n); } }),
    );
    expect(out.isError).toBe(false);
    expect(marks.sort()).toEqual(["mcp__jira__create", "mcp__slack__send"]);
    expect(out.output).toContain('"name":"mcp__slack__send"'); // full spec JSON in the result
    expect(out.output).toContain('"name":"mcp__jira__create"');
    expect(out.output).toContain("now callable");
  });

  test("keyword search ranks by hits; +term is required", async () => {
    const r = buildRegistry();
    const marks: string[] = [];
    const out = await r.execute(
      "ToolSearch",
      { query: "+slack send" },
      ctxWith({ loadedTools: new Set(), deferThreshold: 12, markToolLoaded: (n) => { marks.push(n); } }),
    );
    expect(out.isError).toBe(false);
    expect(marks).toEqual(["mcp__slack__send", "mcp__slack__read"]); // send ranks higher (2 hits vs 1)
    const sendIdx = out.output.indexOf('"name":"mcp__slack__send"');
    const readIdx = out.output.indexOf('"name":"mcp__slack__read"');
    expect(sendIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(sendIdx);
    expect(out.output).not.toContain("jira");
  });

  test("maxResults caps matches (default 5)", async () => {
    const r = buildRegistry();
    const marks: string[] = [];
    // "mcp" is a substring of every stubbed tool name (they all start with "mcp__")
    const out = await r.execute(
      "ToolSearch",
      { query: "mcp" },
      ctxWith({ loadedTools: new Set(), deferThreshold: 12, markToolLoaded: (n) => { marks.push(n); } }),
    );
    expect(out.isError).toBe(false);
    expect(marks.length).toBe(5);
    expect(out.output).toContain("Loaded 5 tool(s)");
  });

  test("no matches → friendly non-error with nearest names", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ToolSearch",
      { query: "zzzznomatch" },
      ctxWith({ loadedTools: new Set(), deferThreshold: 12 }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("no deferred tools matched");
    expect(out.output).toContain("mcp__slack__send"); // one of the nearest deferred names
  });

  test("searches ONLY the deferred index (loaded + built-ins never returned)", async () => {
    const r = buildRegistry();
    r.register({ name: "read", description: "read a file from disk", args: z.object({}).passthrough(), run: () => "ok" }); // built-in, non-mcp
    const loaded = new Set<string>(["mcp__slack__read"]); // already loaded this session
    const out = await r.execute(
      "ToolSearch",
      { query: "read" },
      ctxWith({ loadedTools: loaded, deferThreshold: 12 }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).not.toContain('"name":"mcp__slack__read"'); // already loaded — excluded
    expect(out.output).not.toContain('"name":"read"'); // built-in — never part of the deferred index
    expect(out.output).toContain('"name":"mcp__jira__read"'); // still-deferred match
  });

  // Phase 4b Task 4 (spec §3): plugin__ tools ride the exact same deferral/ToolSearch machinery as
  // mcp__ (isExternalToolName, registry.ts) — ToolSearch itself has no prefix-specific logic, but
  // this pins that fact against a regression rather than trusting it by inference.
  test("plugin__ tools defer and load identically to mcp__ (isExternalToolName widening)", async () => {
    const r = buildRegistry();
    for (let i = 1; i <= 13; i++) {
      r.register({ name: `plugin__demo__t${i}`, description: `plugin tool ${i}`, args: z.object({}).passthrough(), run: () => "ok" });
    }
    const marks: string[] = [];
    const out = await r.execute(
      "ToolSearch",
      { query: "select:plugin__demo__t1,plugin__demo__t2" },
      ctxWith({ loadedTools: new Set(), deferThreshold: 12, markToolLoaded: (n) => { marks.push(n); } }),
    );
    expect(out.isError).toBe(false);
    expect(marks.sort()).toEqual(["plugin__demo__t1", "plugin__demo__t2"]);
    expect(out.output).toContain('"name":"plugin__demo__t1"');
    expect(out.output).toContain('"name":"plugin__demo__t2"');
  });
});
