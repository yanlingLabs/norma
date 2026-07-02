import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { buildSeatbeltProfile, sandboxAvailable } from "./sandbox";
import { OutputCoalescer } from "./bg-coalescer";
import type { NewSessionEvent } from "@norma/protocol";

const RING_CAP = 1024 * 1024; // 1 MiB in-memory ring per task
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;

interface Task {
  taskId: string; sessionId: string; command: string;
  child: ChildProcess; status: "running" | "exited" | "killed"; exitCode: number | null;
  ring: string; cursor: number; ringDropped: boolean; startedAt: number;
  coalescer: OutputCoalescer;
}

export interface BgDeps {
  emit: (sessionId: string, event: NewSessionEvent) => void;
  spawnCtx: (sessionId: string) => { cwd: string; roots: string[]; tmpDir: string };
  killGraceMs?: number;
}

export class BackgroundTaskRegistry {
  private tasks = new Map<string, Task>();
  private readonly killGraceMs: number;
  constructor(private readonly deps: BgDeps) { this.killGraceMs = deps.killGraceMs ?? 2000; }

  private own(sessionId: string, taskId: string): Task {
    const t = this.tasks.get(taskId);
    if (!t || t.sessionId !== sessionId) throw new Error(`unknown background task: ${taskId}`);
    return t;
  }

  has(sessionId: string, taskId: string): boolean {
    const t = this.tasks.get(taskId);
    return !!t && t.sessionId === sessionId;
  }

  start(sessionId: string, command: string): string {
    if (!sandboxAvailable()) throw new Error("background bash unavailable: macOS sandbox-exec not found");
    const { cwd, roots, tmpDir } = this.deps.spawnCtx(sessionId);
    const realCwd = realpathSync(cwd);
    const scratch = realpathSync(tmpDir);
    const writable = [...new Set([realCwd, ...roots.map((r) => realpathSync(r)), scratch])];
    const profile = buildSeatbeltProfile({ cwd: realCwd, writableRoots: writable.filter((r) => r !== realCwd), allowNetwork: false });
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], {
      cwd: realCwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, TMPDIR: scratch },
    });
    const taskId = `bg_${randomBytes(6).toString("hex")}`;
    const coalescer = new OutputCoalescer((chunk) =>
      this.deps.emit(sessionId, { type: "bg_task_output", sessionId, threadId: "main", taskId, chunk } as unknown as NewSessionEvent));
    const task: Task = { taskId, sessionId, command, child, status: "running", exitCode: null, ring: "", cursor: 0, ringDropped: false, startedAt: Date.now(), coalescer };
    this.tasks.set(taskId, task);

    const onData = (d: Buffer) => {
      const s = d.toString("utf8").replace(DEPRECATION_RE, "");
      if (s.length === 0) return;
      task.ring += s;
      if (task.ring.length > RING_CAP) {
        task.ring = task.ring.slice(task.ring.length - RING_CAP);
        task.cursor = Math.max(0, task.cursor - (task.ring.length)); // clamp; recomputed on read
        if (!task.ringDropped) { task.ringDropped = true; task.ring = "[background output ring full — oldest output dropped]\n" + task.ring; }
      }
      task.coalescer.push(s);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("close", (code) => {
      task.coalescer.dispose();
      if (task.status !== "killed") task.status = "exited";
      task.exitCode = code;
      this.deps.emit(sessionId, { type: "bg_task_exited", sessionId, threadId: "main", taskId, exitCode: code, killed: task.status === "killed" } as unknown as NewSessionEvent);
    });
    child.on("error", () => { task.coalescer.dispose(); task.status = "exited"; task.exitCode = -1;
      this.deps.emit(sessionId, { type: "bg_task_exited", sessionId, threadId: "main", taskId, exitCode: -1, killed: false } as unknown as NewSessionEvent); });

    this.deps.emit(sessionId, { type: "bg_task_started", sessionId, threadId: "main", taskId, command } as unknown as NewSessionEvent);
    return taskId;
  }

  read(sessionId: string, taskId: string): { chunk: string; status: string; exitCode: number | null } {
    const t = this.own(sessionId, taskId);
    const start = Math.min(t.cursor, t.ring.length);
    const chunk = t.ring.slice(start);
    t.cursor = t.ring.length;
    return { chunk, status: t.status, exitCode: t.exitCode };
  }

  kill(sessionId: string, taskId: string): void {
    const t = this.own(sessionId, taskId);
    if (t.status !== "running") return;
    t.status = "killed";
    try { process.kill(-t.child.pid!, "SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-t.child.pid!, "SIGKILL"); } catch { /* gone */ } }, this.killGraceMs);
  }

  list(sessionId: string) {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId)
      .map((t) => ({ taskId: t.taskId, command: t.command, status: t.status, exitCode: t.exitCode, startedAt: t.startedAt }));
  }

  killAllForSession(sessionId: string): void {
    for (const t of this.tasks.values()) if (t.sessionId === sessionId && t.status === "running") this.kill(sessionId, t.taskId);
  }
  killAll(): void { for (const t of this.tasks.values()) if (t.status === "running") this.kill(t.sessionId, t.taskId); }
}
