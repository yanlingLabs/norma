import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerMemoryTools } from "../../src/agent/tools/memory";
import { MemoryStore } from "../../src/agent/memory";

// Phase 5b Task 2: memory_read/memory_write/memory_delete — the agent-facing surface over T1's
// MemoryStore. PLAIN TOOLS (task-stop.ts is the model): testable directly against the tool +
// store, no engine involved.

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-mem-tools-")));
}

const alwaysTrusted = { isTrusted: (_dir: string) => true };
const neverTrusted = { isTrusted: (_dir: string) => false };

function setup(trust: { isTrusted: (dir: string) => boolean } = alwaysTrusted) {
  const home = realDir();
  const memory = new MemoryStore({ normaHome: home, trust });
  const r = new ToolRegistry();
  const projectDirs = new Map<string, string>();
  registerMemoryTools(r, { memory, cwdOf: (sid) => projectDirs.get(sid) });
  return { home, memory, r, projectDirs };
}

// ctx.cwd is DELIBERATELY a different path than whatever cwdOf(sessionId) returns in tests below —
// this proves the tools resolve project scope via cwdOf, never ctx.cwd (see memory.ts's own doc
// comment on why: ctx.cwd is the current THREAD's cwd, which can be a transient worktree path).
const ctx = (sessionId: string) => ({ cwd: "/not-the-project-dir", roots: ["/tmp"], sessionId });

describe("memory_read/memory_write/memory_delete tools (phase 5b Task 2)", () => {
  test("write -> read -> delete round trip (user scope, default)", async () => {
    const { r } = setup();

    const writeOut = await r.execute(
      "memory_write",
      { name: "coffee-pref", description: "Likes oat milk lattes", body: "User prefers oat milk lattes over regular." },
      ctx("s1"),
    );
    expect(writeOut).toMatchObject({ isError: false, output: 'saved memory fact "coffee-pref" (user scope)' });

    const readOut = await r.execute("memory_read", { name: "coffee-pref" }, ctx("s1"));
    expect(readOut.isError).toBe(false);
    expect(readOut.output).toContain("coffee-pref (user)");
    expect(readOut.output).toContain("Likes oat milk lattes");
    expect(readOut.output).toContain("User prefers oat milk lattes over regular.");

    const deleteOut = await r.execute("memory_delete", { name: "coffee-pref" }, ctx("s1"));
    expect(deleteOut).toMatchObject({ isError: false, output: 'deleted memory fact "coffee-pref" (user scope)' });

    const readAfterDelete = await r.execute("memory_read", { name: "coffee-pref" }, ctx("s1"));
    expect(readAfterDelete.isError).toBe(true);
  });

  test("memory_write default type is 'user' when omitted", async () => {
    const { home, r } = setup();
    await r.execute("memory_write", { name: "a", description: "d", body: "b" }, ctx("s1"));
    const readOut = await r.execute("memory_read", { name: "a" }, ctx("s1"));
    expect(readOut.output).toContain("a (user)");
    expect(existsSync(join(home, "memory", "a.md"))).toBe(true);
  });

  test("memory_write records audit with source:'tool' and the calling session's id", async () => {
    const { memory, r } = setup();
    await r.execute("memory_write", { name: "a", description: "d", body: "b" }, ctx("s42"));
    const tail = memory.auditTail();
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ source: "tool", sessionId: "s42", action: "write", scope: "user", name: "a" });
  });

  test("memory_delete records audit with source:'tool' and the calling session's id", async () => {
    const { memory, r } = setup();
    await r.execute("memory_write", { name: "a", description: "d", body: "b" }, ctx("s42"));
    await r.execute("memory_delete", { name: "a" }, ctx("s42"));
    const tail = memory.auditTail();
    expect(tail[1]).toMatchObject({ source: "tool", sessionId: "s42", action: "delete", scope: "user", name: "a" });
  });

  test("unknown name -> memory_read is a typed isError, verbatim from the store", async () => {
    const { r } = setup();
    const out = await r.execute("memory_read", { name: "ghost" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toBe('memory fact "ghost" not found or corrupt');
  });

  test("memory_delete on unknown name -> typed isError, verbatim from the store", async () => {
    const { r } = setup();
    const out = await r.execute("memory_delete", { name: "ghost" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toBe('memory fact "ghost" not found');
  });

  test("project scope, untrusted cwd -> memory_read isError with the store's trust message", async () => {
    const { r, projectDirs } = setup(neverTrusted);
    projectDirs.set("s1", "/some/untrusted/project");
    const out = await r.execute("memory_read", { scope: "project", name: "x" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "project memory requires a trusted directory" });
  });

  test("project scope, untrusted cwd -> memory_write isError, nothing written", async () => {
    const { home, r, projectDirs } = setup(neverTrusted);
    projectDirs.set("s1", "/some/untrusted/project");
    const out = await r.execute("memory_write", { scope: "project", name: "x", description: "d", body: "b" }, ctx("s1"));
    expect(out).toMatchObject({ isError: true, output: "project memory requires a trusted directory" });
    expect(existsSync(join(home, "memory", "x.md"))).toBe(false);
  });

  test("project scope resolves the directory via cwdOf(sessionId), NOT ctx.cwd", async () => {
    const { r, projectDirs } = setup(alwaysTrusted);
    const projectDir = realDir();
    projectDirs.set("s1", projectDir);

    const out = await r.execute("memory_write", { scope: "project", name: "x", description: "d", body: "b" }, ctx("s1"));
    expect(out.isError).toBe(false);
    expect(existsSync(join(projectDir, ".norma", "memory", "x.md"))).toBe(true);
  });

  test("project scope with no cwdOf entry for the session -> untrusted-project error (undefined cwd)", async () => {
    const { r } = setup(alwaysTrusted); // trust would allow it, but there's no cwd to even check
    const out = await r.execute("memory_read", { scope: "project", name: "x" }, ctx("no-such-session"));
    expect(out).toMatchObject({ isError: true, output: "project memory requires a trusted directory" });
  });

  test("missing required args -> zod invalid-arguments typed error", async () => {
    const { r } = setup();
    const out = await r.execute("memory_write", { name: "a" }, ctx("s1"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("invalid arguments for memory_write");
  });
});
