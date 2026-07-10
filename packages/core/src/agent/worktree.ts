import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ActiveWorktree {
  name: string;
  dir: string;
  branch: string;
  originalCwd: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitResult {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Pure git worktree lifecycle (add/remove) + per-session active state. No shell, no persistence. */
export class WorktreeManager {
  private readonly baseRef: "fresh" | "head";
  private readonly sessions = new Map<string, ActiveWorktree>();

  constructor(deps?: { baseRef?: "fresh" | "head" }) {
    this.baseRef = deps?.baseRef ?? "fresh";
  }

  enter(sessionId: string, cwd: string, name?: string): ActiveWorktree {
    const already = this.sessions.get(sessionId);
    if (already) throw new Error(`already in worktree ${already.name}; exit first`);

    const isRepo = git(["rev-parse", "--git-dir"], cwd);
    if (isRepo.code !== 0) throw new Error("not a git repository");

    const toplevel = git(["rev-parse", "--show-toplevel"], cwd);
    if (toplevel.code !== 0) throw new Error("not a git repository");
    const root = toplevel.stdout.trim();

    const wtName = name ?? randomUUID().slice(0, 8);
    const dir = join(root, ".norma", "worktrees", wtName);
    const branch = `norma/${wtName}`;

    if (existsSync(dir)) throw new Error(`worktree dir already exists: ${dir}`);
    const branchList = git(["branch", "--list", branch], root);
    if (branchList.stdout.trim().length > 0) throw new Error(`branch already exists: ${branch}`);

    const base = this.resolveBaseRef(root);

    const add = git(["worktree", "add", dir, "-b", branch, base], root);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);

    const result: ActiveWorktree = { name: wtName, dir, branch, originalCwd: cwd };
    this.sessions.set(sessionId, result);
    return result;
  }

  exit(
    sessionId: string,
    action: "keep" | "remove",
    discardChanges?: boolean,
  ): { name: string; branch: string; removed: boolean; originalCwd: string } {
    const active = this.sessions.get(sessionId);
    if (!active) throw new Error("not currently in a worktree");

    if (action === "remove") {
      if (discardChanges) {
        // Force removal even with uncommitted changes — the caller has explicitly opted in to
        // discarding them (exit_worktree's discard_changes: true).
        const remove = git(["worktree", "remove", "--force", active.dir], active.originalCwd);
        if (remove.code !== 0) throw new Error(`git worktree remove failed: ${remove.stderr.trim()}`);
      } else {
        // Pre-check with `git status --short` (rather than letting a plain `git worktree remove`
        // fail and relaying git's own stderr) so the caller gets the actual dirty-paths listing —
        // exit_worktree's contract promises that listing in the error.
        const status = git(["status", "--short"], active.dir);
        if (status.stdout.trim().length > 0) {
          throw new Error(`refusing to remove: uncommitted changes:\n${status.stdout.trim()}\nre-run with discard_changes: true to delete them`);
        }
        const remove = git(["worktree", "remove", active.dir], active.originalCwd);
        if (remove.code !== 0) throw new Error(`git worktree remove failed: ${remove.stderr.trim()}`);
      }
    }

    this.sessions.delete(sessionId);
    return { name: active.name, branch: active.branch, removed: action === "remove", originalCwd: active.originalCwd };
  }

  active(sessionId: string): ActiveWorktree | undefined {
    return this.sessions.get(sessionId);
  }

  private resolveBaseRef(root: string): string {
    if (this.baseRef === "head") return "HEAD";
    const symref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], root);
    if (symref.code !== 0) return "HEAD";
    const ref = symref.stdout.trim();
    const prefix = "refs/remotes/origin/";
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref || "HEAD";
  }
}
