import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stable, per-session scratch directory that is a sandbox writable root. */
export function sessionTmpDir(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid sessionId for temp dir: ${sessionId}`);
  }
  const dir = join(tmpdir(), `norma-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}
