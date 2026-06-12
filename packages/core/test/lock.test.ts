import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, AlreadyRunningError } from "../src/lock";

function tmpRun(): { lockPath: string; socketPath: string } {
  const d = mkdtempSync(join(tmpdir(), "norma-lock-"));
  return { lockPath: join(d, "core.lock"), socketPath: join(d, "core.sock") };
}

describe("acquireLock", () => {
  test("acquires when no lock exists; writes own pid; release removes it", async () => {
    const p = tmpRun();
    const lock = await acquireLock(p.lockPath, p.socketPath);
    expect(JSON.parse(await Bun.file(p.lockPath).text()).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(p.lockPath)).toBe(false);
  });

  test("steals a stale lock (dead pid)", async () => {
    const p = tmpRun();
    writeFileSync(p.lockPath, JSON.stringify({ pid: 999999999 })); // not a real pid
    writeFileSync(p.socketPath, ""); // stale socket file
    const lock = await acquireLock(p.lockPath, p.socketPath);
    expect(JSON.parse(await Bun.file(p.lockPath).text()).pid).toBe(process.pid);
    expect(existsSync(p.socketPath)).toBe(false); // stale socket unlinked
    lock.release();
  });

  test("refuses when the holder is alive AND its socket answers", async () => {
    const p = tmpRun();
    const server = Bun.listen({ unix: p.socketPath, socket: { data() {} } });
    writeFileSync(p.lockPath, JSON.stringify({ pid: process.pid })); // alive (it's us)
    await expect(acquireLock(p.lockPath, p.socketPath)).rejects.toBeInstanceOf(AlreadyRunningError);
    server.stop(true);
  });

  test("steals when pid is alive but socket does not answer", async () => {
    const p = tmpRun();
    writeFileSync(p.lockPath, JSON.stringify({ pid: process.pid })); // alive pid, but no socket listening
    const lock = await acquireLock(p.lockPath, p.socketPath);
    expect(existsSync(p.lockPath)).toBe(true);
    lock.release();
  });
});
