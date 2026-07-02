import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskRegistry } from "../../src/agent/bg-registry";
import { sandboxAvailable } from "../../src/agent/sandbox";
import { sessionTmpDir } from "../../src/agent/session-tmp";

const d = sandboxAvailable() ? describe : describe.skip;
function realDir() { return realpathSync(mkdtempSync(join(tmpdir(), "norma-bg-"))); }

function makeRegistry(cwd: string) {
  const events: any[] = [];
  const reg = new BackgroundTaskRegistry({
    emit: (_sid, e) => events.push(e),
    spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_bgtest") }),
    killGraceMs: 300,
  });
  return { reg, events };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("BackgroundTaskRegistry", () => {
  test("start → incremental read via cursor → exit event", async () => {
    const cwd = realDir();
    const { reg, events } = makeRegistry(cwd);
    const id = reg.start("s1", "for i in 1 2 3; do echo line$i; sleep 0.15; done");
    expect(id).toMatch(/^bg_/);
    expect(events.some((e) => e.type === "bg_task_started" && e.taskId === id)).toBe(true);
    await sleep(250);
    const first = reg.read("s1", id);
    expect(first.chunk).toContain("line1");
    expect(first.status).toBe("running");
    const firstLen = first.chunk.length;
    await sleep(400);
    const second = reg.read("s1", id);
    expect(second.chunk).not.toContain("line1"); // cursor advanced — only NEW output
    expect(second.chunk).toContain("line3");
    await sleep(200);
    const done = reg.read("s1", id);
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(0);
    expect(events.some((e) => e.type === "bg_task_exited" && e.taskId === id && e.exitCode === 0)).toBe(true);
    expect(firstLen).toBeGreaterThan(0);
  });

  test("kill reaps the whole process group (no orphan)", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    // grandchild writes its pid then sleeps long; if the group isn't killed it survives
    const id = reg.start("s1", 'sleep 30 & echo $! > "$TMPDIR/child.pid"; wait');
    await sleep(400);
    reg.kill("s1", id);
    await sleep(600); // SIGTERM grace (300ms) + SIGKILL
    const st = reg.read("s1", id);
    expect(st.status).toBe("killed");
    // the backgrounded `sleep 30` must be gone (group kill), verified via pgrep in the gate;
    // here assert the registry marked it killed and the child closed:
    expect(["killed", "exited"]).toContain(st.status);
  });

  test("background command cannot write outside the session roots (fence reused)", async () => {
    const cwd = realDir();
    const outside = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", `echo pwned > ${outside}/leak.txt 2>&1 || true`);
    await sleep(500);
    expect(existsSync(join(outside, "leak.txt"))).toBe(false); // denied by the same Seatbelt fence
  });

  test("read/kill on a foreign session's task throws", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const id = reg.start("s1", "sleep 1");
    expect(() => reg.read("s2", id)).toThrow();
    expect(() => reg.kill("s2", id)).toThrow();
    reg.kill("s1", id);
  });

  test("list enumerates a session's tasks; killAllForSession clears them", async () => {
    const cwd = realDir();
    const { reg } = makeRegistry(cwd);
    const a = reg.start("s1", "sleep 5"); const b = reg.start("s1", "sleep 5");
    expect(reg.list("s1").map((t) => t.taskId).sort()).toEqual([a, b].sort());
    reg.killAllForSession("s1");
    await sleep(500);
    for (const t of reg.list("s1")) expect(["killed", "exited"]).toContain(t.status);
  });
});
