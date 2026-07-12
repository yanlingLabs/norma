/** Phase 3d Task 1 — the pure in-chat slash-command registry + runners. Each runner mirrors ONE
 *  main.ts subcommand route's client calls + output wording (cited in commands.ts per-runner);
 *  this file drives them through a fake `NormaClient` that only records calls + returns canned
 *  results, following app.test.tsx's `fakeClient()` precedent (recorded calls array, no real I/O)
 *  — except `/model`, which (like its main.ts route) never touches the client at all: it reads/
 *  writes `settings.json` directly under `NORMA_HOME` (an env var this suite points at a tmpdir
 *  per test so it never touches the real `~/.norma`). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMANDS, filterCommands, helpText, parseSlashInput, runCommand,
  type CommandCtx,
} from "../../src/tui/commands";
import type { NormaClient } from "../../src/client";

// ---- fake client (mirrors test/tui/app.test.tsx's fakeClient — recorded calls, canned results) ----
type Impl = Record<string, (...args: unknown[]) => unknown>;

function makeClient(impl: Impl): { client: NormaClient; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const client: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    client[name] = (...args: unknown[]) => {
      calls.push({ method: name, args });
      return Promise.resolve(fn(...args));
    };
  }
  return { client: client as unknown as NormaClient, calls };
}

function makeCtx(client: NormaClient, overrides: Partial<Omit<CommandCtx, "client" | "appendNote">> = {}) {
  const notes: string[] = [];
  const ctx: CommandCtx = {
    client,
    sessionId: overrides.sessionId ?? "sess-1",
    cwd: overrides.cwd ?? "/work/dir",
    appendNote: (text: string) => notes.push(text),
  };
  return { ctx, notes };
}

describe("parseSlashInput", () => {
  test.each([
    ["/compact", { cmd: "compact", argText: "" }],
    ["/model gpt-5.6-luna", { cmd: "model", argText: "gpt-5.6-luna" }],
    ["/add-dir /tmp/foo --persist", { cmd: "add-dir", argText: "/tmp/foo --persist" }],
    ["  /status  ", { cmd: "status", argText: "" }],
    ["/bg peek abc123", { cmd: "bg", argText: "peek abc123" }],
  ])("%s -> %j", (input, expected) => {
    expect(parseSlashInput(input as string)).toEqual(expected as { cmd: string; argText: string });
  });

  test("non-slash text -> null", () => {
    expect(parseSlashInput("hello there")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });
});

describe("filterCommands", () => {
  test("prefix matches come before fuzzy matches, both in registry order", () => {
    // "s" is a prefix of "status", "sessions", "skills" (registry order: status, sessions, ...
    // skills — see COMMANDS below) and a fuzzy subsequence-only hit of "compact"? no — "compact"
    // has no "s". Use "c" instead: prefix of "compact", "cd"; fuzzy-only (contains "c" not at
    // start) of "mcp".
    const names = filterCommands("c").map((c) => c.name);
    const prefixNames = COMMANDS.filter((c) => c.name.startsWith("c")).map((c) => c.name);
    const fuzzyOnlyNames = COMMANDS.filter((c) => !c.name.startsWith("c") && c.name.includes("c")).map((c) => c.name);
    expect(names).toEqual([...prefixNames, ...fuzzyOnlyNames]);
  });

  test("empty query returns every command in registry order", () => {
    expect(filterCommands("").map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
  });

  test("no duplicates: a command matching both prefix and fuzzy appears once", () => {
    const names = filterCommands("s").map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("fuzzy subsequence: 'mp' matches 'mcp' (m...p) but not 'model' style prefix hits duplicated", () => {
    const names = filterCommands("mp").map((c) => c.name);
    expect(names).toContain("mcp");
  });

  test("no match -> empty array", () => {
    expect(filterCommands("zzzznotacommand")).toEqual([]);
  });
});

describe("runCommand — dispatch", () => {
  test("non-slash input returns false and never touches the client", () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    return runCommand(ctx, "just chatting").then((handled) => {
      expect(handled).toBe(false);
      expect(calls).toEqual([]);
      expect(notes).toEqual([]);
    });
  });

  test("unknown slash command -> note + handled (true)", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    const handled = await runCommand(ctx, "/nope");
    expect(handled).toBe(true);
    expect(notes).toEqual(["Unknown command: /nope — /help lists commands"]);
  });

  test("a runner that throws is caught — never crashes the shell", async () => {
    const { client } = makeClient({ compact: () => { throw new Error("boom"); } });
    const { ctx, notes } = makeCtx(client);
    const handled = await runCommand(ctx, "/compact");
    expect(handled).toBe(true);
    expect(notes).toEqual(["/compact failed: boom"]);
  });
});

describe("helpText", () => {
  test("contains every command name and the full keybinding list", () => {
    const text = helpText();
    for (const c of COMMANDS) expect(text).toContain(`/${c.name}`);
    for (const key of [
      "enter send", "esc interrupt", "Esc-Esc clear", "shift+tab cycle modes", "history",
      "PgUp/PgDn scroll", "ctrl+u half-page up", "Home/End", "ctrl+o expand outputs",
      "ctrl+t tasks", "ctrl+c/ctrl+d", "/ commands", "@ files",
    ]) {
      expect(text).toContain(key);
    }
  });

  test("descriptions stay under 60 chars (registry contract)", () => {
    for (const c of COMMANDS) expect(c.description.length).toBeLessThanOrEqual(60);
  });
});

describe("runners — mirror main.ts's routes", () => {
  test("/help appends helpText() as one note, no client calls", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/help");
    expect(calls).toEqual([]);
    expect(notes).toEqual([helpText()]);
  });

  test("/compact — mirrors `case \"compact\"`: calls client.compact(sessionId), reports uptoSeq+chars", async () => {
    const { client, calls } = makeClient({ compact: () => ({ compacted: true, uptoSeq: 42, summaryChars: 900 }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/compact");
    expect(calls).toEqual([{ method: "compact", args: ["sess-9"] }]);
    expect(notes).toEqual(["compacted (through seq 42, 900 char summary)"]);
  });

  test("/compact — nothing to compact yet", async () => {
    const { client } = makeClient({ compact: () => ({ compacted: false, uptoSeq: 0, summaryChars: 0 }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/compact");
    expect(notes).toEqual(["nothing to compact yet"]);
  });

  test("/status — mirrors `case \"status\"`: calls daemonStatus, no-provider phrasing", async () => {
    const { client, calls } = makeClient({
      daemonStatus: () => ({ version: "0.0.1", uptimeMs: 61_000, socketPath: "/tmp/core.sock", provider: null, sessionsCount: 2, pluginsCount: 0 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/status");
    expect(calls).toEqual([{ method: "daemonStatus", args: [] }]);
    expect(notes[0]).toContain("norma-core v0.0.1");
    expect(notes[0]).toContain("1m 1s");
    expect(notes[0]).toContain("(none configured)");
    expect(notes[0]).toContain("sessions: 2");
    expect(notes[0]).toContain("plugins: 0");
  });

  test("/status — configured provider shows id (model)", async () => {
    const { client } = makeClient({
      daemonStatus: () => ({ version: "0.0.1", uptimeMs: 1000, socketPath: "/x", provider: { id: "codex-oauth", model: "gpt-5.6-sol" }, sessionsCount: 1, pluginsCount: 3 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/status");
    expect(notes[0]).toContain("codex-oauth (gpt-5.6-sol)");
  });

  test("/quota — mirrors `case \"quota\"`: ok state", async () => {
    const { client, calls } = makeClient({
      quotaState: () => ({ kind: "ok", inputTokens: 500, outputTokens: 12_400 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/quota");
    expect(calls).toEqual([{ method: "quotaState", args: [] }]);
    expect(notes).toEqual(["quota: ok 500 in / 12.4k out"]);
  });

  test("/quota — limited state includes resume phrasing", async () => {
    const { client } = makeClient({
      quotaState: () => ({ kind: "limited", resumeAt: 0, inputTokens: 0, outputTokens: 0 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/quota");
    expect(notes[0]).toContain("limited (resumes");
  });

  test("/sessions — mirrors `case \"sessions\"`: one line per session", async () => {
    const { client, calls } = makeClient({
      listSessions: () => ({ sessions: [{ sessionId: "s1", scope: "global", lastSeq: 12, createdAt: 0 }, { sessionId: "s2", scope: "global", lastSeq: 3, createdAt: 0 }] }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/sessions");
    expect(calls).toEqual([{ method: "listSessions", args: [] }]);
    expect(notes).toEqual(["s1 global · 12 events\ns2 global · 3 events"]);
  });

  test("/sessions — empty list note", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: [] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/sessions");
    expect(notes).toEqual(["(no sessions)"]);
  });

  test("/add-dir — mirrors `case \"add-dir\"`: path + persist flag forwarded", async () => {
    const { client, calls } = makeClient({ addDir: () => ["/a", "/b", "/c"] });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-5" });
    await runCommand(ctx, "/add-dir /some/path --persist");
    expect(calls).toEqual([{ method: "addDir", args: ["sess-5", "/some/path", true] }]);
    expect(notes).toEqual(["+ dir /some/path → 3 roots"]);
  });

  test("/add-dir — no persist flag defaults to false", async () => {
    const { client, calls } = makeClient({ addDir: () => ["/a"] });
    const { ctx } = makeCtx(client);
    await runCommand(ctx, "/add-dir /some/path");
    expect(calls).toEqual([{ method: "addDir", args: ["sess-1", "/some/path", false] }]);
  });

  test("/add-dir — missing path is a usage note, no client call", async () => {
    const { client, calls } = makeClient({ addDir: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/add-dir");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/cd — mirrors `case \"cd\"`: forwards sessionId + path, reports resolved cwd", async () => {
    const { client, calls } = makeClient({ setCwd: () => "/resolved/path" });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-7" });
    await runCommand(ctx, "/cd ../elsewhere");
    expect(calls).toEqual([{ method: "setCwd", args: ["sess-7", "../elsewhere"] }]);
    expect(notes).toEqual(["cwd → /resolved/path"]);
  });

  test("/cd — missing path is a usage note", async () => {
    const { client, calls } = makeClient({ setCwd: () => "" });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/cd");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/cd — fires onCwdChanged with the DAEMON-CONFIRMED cwd (T2 review item 3)", async () => {
    const { client } = makeClient({ setCwd: () => "/resolved/path" });
    const { ctx } = makeCtx(client);
    const seen: string[] = [];
    ctx.onCwdChanged = (newCwd: string) => seen.push(newCwd);
    await runCommand(ctx, "/cd ../elsewhere");
    expect(seen).toEqual(["/resolved/path"]); // the resolved path, never the raw "../elsewhere" arg
  });

  test("/skills — mirrors `case \"skills\"`: uses ctx.cwd, lists name/source/description", async () => {
    const { client, calls } = makeClient({ listSkills: () => [{ name: "brainstorm", description: "Explore ideas", source: "user", path: "/x" }] });
    const { ctx, notes } = makeCtx(client, { cwd: "/my/proj" });
    await runCommand(ctx, "/skills");
    expect(calls).toEqual([{ method: "listSkills", args: ["/my/proj"] }]);
    expect(notes).toEqual(["brainstorm (user) — Explore ideas"]);
  });

  test("/skills — none installed", async () => {
    const { client } = makeClient({ listSkills: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/skills");
    expect(notes).toEqual(["no skills installed"]);
  });

  test("/mcp — mirrors `case \"mcp\"`: uses ctx.cwd, lists status + namespaced tool names", async () => {
    const { client, calls } = makeClient({ listMcp: () => [{ name: "github", status: "connected", source: "user", toolNames: ["search", "get_file"] }] });
    const { ctx, notes } = makeCtx(client, { cwd: "/my/proj" });
    await runCommand(ctx, "/mcp");
    expect(calls).toEqual([{ method: "listMcp", args: ["/my/proj"] }]);
    expect(notes).toEqual(["github (user, connected) mcp__github__search, mcp__github__get_file"]);
  });

  test("/mcp — none configured", async () => {
    const { client } = makeClient({ listMcp: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/mcp");
    expect(notes).toEqual(["no MCP servers configured"]);
  });

  test("/bg (no args) — defaults to list, mirrors `bg list`", async () => {
    const { client, calls } = makeClient({ bgList: () => [{ taskId: "t1", status: "running", command: "npm test", exitCode: null, startedAt: 0 }] });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-3" });
    await runCommand(ctx, "/bg");
    expect(calls).toEqual([{ method: "bgList", args: ["sess-3"] }]);
    expect(notes).toEqual(["t1 running · npm test"]);
  });

  test("/bg list — empty", async () => {
    const { client } = makeClient({ bgList: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/bg list");
    expect(notes).toEqual(["(no bg tasks)"]);
  });

  test("/bg peek <taskId> — mirrors `bg peek`, includes chunk when present", async () => {
    const { client, calls } = makeClient({ bgPeek: () => ({ status: "running", exitCode: null, chunk: "hello output" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-3" });
    await runCommand(ctx, "/bg peek t1");
    expect(calls).toEqual([{ method: "bgPeek", args: ["sess-3", "t1"] }]);
    expect(notes[0]).toContain("running exit=-");
    expect(notes[0]).toContain("hello output");
  });

  test("/bg peek — missing taskId is a usage note", async () => {
    const { client, calls } = makeClient({ bgPeek: () => ({}) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/bg peek");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/bg kill <taskId> — mirrors `bg kill`", async () => {
    const { client, calls } = makeClient({ bgKill: () => ({ ok: true }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-3" });
    await runCommand(ctx, "/bg kill t9");
    expect(calls).toEqual([{ method: "bgKill", args: ["sess-3", "t9"] }]);
    expect(notes).toEqual(["killed t9"]);
  });

  test("/bg bogus-sub — usage note, no client call", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/bg bogus");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });
});

describe("/model — mirrors `case \"model\"` (direct settings.json I/O under NORMA_HOME, no client)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "norma-cli-cmd-model-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }));
    prevHome = process.env.NORMA_HOME;
    process.env.NORMA_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORMA_HOME;
    else process.env.NORMA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("no args -> show, marks the active model, never touches the client", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("gpt-5.6-sol");
    expect(notes[0]).toContain("* gpt-5.6-sol");
    expect(notes[0]).toContain("gpt-5.6-terra");
  });

  test("a valid slug -> switches the model, mirrors the write-path note", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model gpt-5.6-luna");
    expect(notes[0]).toContain("model gpt-5.6-luna");
    expect(notes[0]).toContain("no daemon restart needed");

    const { ctx: ctx2, notes: notes2 } = makeCtx(client);
    await runCommand(ctx2, "/model");
    expect(notes2[0]).toContain("* gpt-5.6-luna");
  });

  test("an invalid slug -> validation note, no write", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model not-a-real-model");
    expect(notes[0]).toContain("invalid model");

    const { ctx: ctx2, notes: notes2 } = makeCtx(client);
    await runCommand(ctx2, "/model");
    expect(notes2[0]).toContain("gpt-5.6-sol"); // unchanged
  });

  test("--effort switches reasoning effort", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model --effort high");
    expect(notes[0]).toContain("effort high");
  });

  test("bad usage (--effort with no value) -> usage note", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model --effort");
    expect(notes[0]).toContain("usage:");
  });
});
