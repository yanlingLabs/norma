import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildSeatbeltProfile, sandboxAvailable } from "./sandbox";
import { OutputCoalescer } from "./bg-coalescer";
import type { NewSessionEvent } from "@norma/protocol";

const RING_CAP = 1024 * 1024; // 1 MiB in-memory ring per task
const DEPRECATION_RE = /^sandbox-exec: .*deprecated.*$/gim;

interface Task {
  taskId: string; sessionId: string; command: string;
  child: ChildProcess; status: "running" | "exited" | "killed"; exitCode: number | null;
  ring: string; cursor: number; ringDropped: boolean; dropNoted: boolean; startedAt: number;
  coalescer: OutputCoalescer;
  // CC parity (TaskOutput deprecated in favor of Read on the task's output file): the FULL,
  // untruncated combined stdout+stderr for this task, teed alongside `ring` (which is capped/
  // evicted for the in-memory bash_output view). Lazily created — the `bash/` subdir under the
  // session tmp dir is mkdir'd only when a background task actually starts, not for every session.
  outFile: string;
}

export interface BgDeps {
  emit: (sessionId: string, event: NewSessionEvent) => void;
  spawnCtx: (sessionId: string) => { cwd: string; roots: string[]; tmpDir: string };
  killGraceMs?: number;
  ringCap?: number;
}

export class BackgroundTaskRegistry {
  private tasks = new Map<string, Task>();
  private readonly killGraceMs: number;
  private readonly ringCap: number;
  // Set by killAll() (whole-daemon shutdown only — never by killAllForSession). Child processes
  // report their exit asynchronously, often after the caller (daemon.stop()) has already closed
  // the SessionStore; emitting into a torn-down hub at that point would throw "closed database"
  // from an unrelated event-loop tick. Once shutting down, nobody is listening anyway, so drop
  // further events instead of forwarding them.
  private stopped = false;
  constructor(private readonly deps: BgDeps) {
    this.killGraceMs = deps.killGraceMs ?? 2000;
    this.ringCap = deps.ringCap ?? RING_CAP;
  }

  private emit(sessionId: string, event: NewSessionEvent): void {
    if (this.stopped) return;
    this.deps.emit(sessionId, event);
  }

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
    // CC parity (TaskOutput deprecated in favor of Read on the task's output file): lazily create
    // <sessionTmpDir>/bash/ (only when a bg task actually starts — every OTHER session never gets
    // one) and tee this task's full, untruncated output there under <taskId>.log.
    const bashDir = join(scratch, "bash");
    mkdirSync(bashDir, { recursive: true });
    const outFile = join(bashDir, `${taskId}.log`);
    const coalescer = new OutputCoalescer((chunk) =>
      this.emit(sessionId, { type: "bg_task_output", sessionId, threadId: "main", taskId, chunk }));
    const task: Task = { taskId, sessionId, command, child, status: "running", exitCode: null, ring: "", cursor: 0, ringDropped: false, dropNoted: false, startedAt: Date.now(), coalescer, outFile };
    this.tasks.set(taskId, task);

    const onData = (d: Buffer) => {
      const s = d.toString("utf8").replace(DEPRECATION_RE, "");
      if (s.length === 0) return;
      try { appendFileSync(task.outFile, s); } catch { /* best-effort — a disk error here must never break bg output/ring delivery */ }
      task.ring += s;
      if (task.ring.length > this.ringCap) {
        const trimmed = task.ring.length - this.ringCap; // bytes actually dropped from the front
        task.ring = task.ring.slice(trimmed);
        task.cursor = Math.max(0, task.cursor - trimmed);
        task.ringDropped = true; // note surfaced once in read(), not stored in the ring (keeps cursor math clean)
      }
      task.coalescer.push(s);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("close", (code) => {
      task.coalescer.dispose();
      if (task.status !== "killed") task.status = "exited";
      task.exitCode = code;
      this.emit(sessionId, { type: "bg_task_exited", sessionId, threadId: "main", taskId, exitCode: code, killed: task.status === "killed" });
    });
    child.on("error", () => { task.coalescer.dispose(); task.status = "exited"; task.exitCode = -1;
      this.emit(sessionId, { type: "bg_task_exited", sessionId, threadId: "main", taskId, exitCode: -1, killed: false }); });

    this.emit(sessionId, { type: "bg_task_started", sessionId, threadId: "main", taskId, command });
    return taskId;
  }

  read(sessionId: string, taskId: string): { chunk: string; status: string; exitCode: number | null } {
    const t = this.own(sessionId, taskId);
    const start = Math.min(t.cursor, t.ring.length);
    let chunk = t.ring.slice(start);
    t.cursor = t.ring.length;
    if (t.ringDropped && !t.dropNoted) { t.dropNoted = true; chunk = "[background output ring full — oldest output dropped]\n" + chunk; }
    return { chunk, status: t.status, exitCode: t.exitCode };
  }

  /** The full-output log path this task tees to (CC parity — `bash`'s background-spawn result
   *  surfaces this so the model can Read/grep it directly instead of polling bash_output).
   *  Throws for an unknown/foreign task, same as read()/kill(). */
  outputFile(sessionId: string, taskId: string): string {
    return this.own(sessionId, taskId).outFile;
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
  killAll(): void {
    this.stopped = true;
    for (const t of this.tasks.values()) if (t.status === "running") this.kill(t.sessionId, t.taskId);
  }
}
