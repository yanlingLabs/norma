import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../src/agent/worktree";

const isMac = process.platform === "darwin";

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** mkdtemp + git init + an initial commit so HEAD exists. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-wt-")));
  git(["init"], dir);
  git(["config", "user.email", "test@norma.dev"], dir);
  git(["config", "user.name", "Norma Test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

describe.if(isMac)("WorktreeManager", () => {
  test("enter creates the worktree dir + branch (head baseRef)", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    const wt = m.enter("s", dir, "feat");
    expect(wt.branch).toBe("norma/feat");
    expect(wt.name).toBe("feat");
    expect(wt.originalCwd).toBe(dir);
    expect(existsSync(wt.dir)).toBe(true);
    expect(m.active("s")).toEqual(wt);
    const listed = git(["branch", "--list", "norma/feat"], dir);
    expect(listed.stdout.trim().length).toBeGreaterThan(0);
  });

  test("enter creates the worktree dir + branch (fresh baseRef, falls back to HEAD without origin)", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "fresh" });
    const wt = m.enter("s", dir, "feat2");
    expect(wt.branch).toBe("norma/feat2");
    expect(existsSync(wt.dir)).toBe(true);
    const listed = git(["branch", "--list", "norma/feat2"], dir);
    expect(listed.stdout.trim().length).toBeGreaterThan(0);
  });

  test("enter default name uses a random 8-char id when omitted", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    const wt = m.enter("s", dir);
    expect(wt.name).toMatch(/^[0-9a-f]{8}$/);
  });

  test("active tracks the entered worktree", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    expect(m.active("s")).toBeUndefined();
    const wt = m.enter("s", dir, "feat");
    expect(m.active("s")).toEqual(wt);
  });

  test("enter twice for the same session → error", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    m.enter("s", dir, "feat");
    expect(() => m.enter("s", dir, "feat2")).toThrow(/already in worktree/);
  });

  test("enter in a non-git dir → error", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-wt-notgit-")));
    const m = new WorktreeManager({ baseRef: "head" });
    expect(() => m.enter("s", dir, "feat")).toThrow(/not a git repository/);
  });

  test("exit keep leaves the worktree dir; active is cleared; removed:false", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    const wt = m.enter("s", dir, "feat");
    const result = m.exit("s", "keep");
    expect(result).toEqual({ name: "feat", branch: "norma/feat", removed: false, originalCwd: dir });
    expect(existsSync(wt.dir)).toBe(true);
    expect(m.active("s")).toBeUndefined();
  });

  test("exit remove (clean) removes the worktree dir; removed:true", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    const wt = m.enter("s", dir, "feat");
    const result = m.exit("s", "remove");
    expect(result).toEqual({ name: "feat", branch: "norma/feat", removed: true, originalCwd: dir });
    expect(existsSync(wt.dir)).toBe(false);
    expect(m.active("s")).toBeUndefined();
  });

  test("exit remove (dirty) refuses without discardChanges — error lists the git status --short output", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    const wt = m.enter("s", dir, "feat");
    writeFileSync(join(wt.dir, "dirty.txt"), "uncommitted\n");
    expect(() => m.exit("s", "remove")).toThrow(/refusing to remove: uncommitted changes:/);
    expect(() => m.exit("s", "remove")).toThrow(/dirty\.txt/);
    expect(() => m.exit("s", "remove")).toThrow(/re-run with discard_changes: true to delete them/);
    // the worktree must still be there — the guard refused the removal.
    expect(existsSync(wt.dir)).toBe(true);
    expect(m.active("s")).toBeDefined(); // still active — exit() never got past the pre-check
  });

  test("exit remove (dirty) with discardChanges:true force-removes despite uncommitted changes", () => {
    const dir = repo();
    const m = new WorktreeManager({ baseRef: "head" });
    const wt = m.enter("s", dir, "feat");
    writeFileSync(join(wt.dir, "dirty.txt"), "uncommitted\n");
    const result = m.exit("s", "remove", true);
    expect(result).toEqual({ name: "feat", branch: "norma/feat", removed: true, originalCwd: dir });
    expect(existsSync(wt.dir)).toBe(false);
    expect(m.active("s")).toBeUndefined();
  });

  test("exit when not in a worktree → error", () => {
    const m = new WorktreeManager({ baseRef: "head" });
    expect(() => m.exit("no-such-session", "keep")).toThrow(/not currently in a worktree/);
  });
});
