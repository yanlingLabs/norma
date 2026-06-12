import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`norma-core already running (pid ${pid})`);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function socketAnswers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) { clearTimeout(timer); s.end(); resolve(true); },
        error() { clearTimeout(timer); resolve(false); },
        connectError() { clearTimeout(timer); resolve(false); },
        data() {},
      },
    }).catch(() => { clearTimeout(timer); resolve(false); });
  });
}

export interface Lock { release(): void }

export async function acquireLock(lockPath: string, socketPath: string): Promise<Lock> {
  if (existsSync(lockPath)) {
    let holderPid = -1;
    try { holderPid = JSON.parse(readFileSync(lockPath, "utf8")).pid; } catch { /* corrupt = stale */ }
    if (holderPid > 0 && pidAlive(holderPid) && (await socketAnswers(socketPath))) {
      throw new AlreadyRunningError(holderPid);
    }
    // Stale: dead pid, corrupt file, or unresponsive socket.
    try { unlinkSync(lockPath); } catch {}
  }
  if (existsSync(socketPath)) { try { unlinkSync(socketPath); } catch {} }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return {
    release() {
      try { unlinkSync(lockPath); } catch {}
      try { unlinkSync(socketPath); } catch {}
    },
  };
}
