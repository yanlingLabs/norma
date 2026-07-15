import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerBackgroundTools } from "../../src/agent/tools/background";
import { registerTaskStopTool } from "../../src/agent/tools/task-stop";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { BackgroundTaskRegistry } from "../../src/agent/bg-registry";
import { sandboxAvailable } from "../../src/agent/sandbox";
import { sessionTmpDir } from "../../src/agent/session-tmp";

const d = sandboxAvailable() ? describe : describe.skip;
function realDir() { return realpathSync(mkdtempSync(join(tmpdir(), "norma-bgtool-"))); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("background tools", () => {
  function setup() {
    const cwd = realDir();
    const bg = new BackgroundTaskRegistry({ emit: () => {}, spawnCtx: () => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_bgt") }), killGraceMs: 300 });
    const r = new ToolRegistry();
    registerBashTool(r, { bgRegistry: bg });
    registerBackgroundTools(r, { bgRegistry: bg });
    registerTaskStopTool(r, { bgRegistry: bg }); // the sole way to kill a bg bash task (bash_kill removed, CC parity)
    return { r, cwd };
  }
  const ctx = (cwd: string) => ({ cwd, roots: [cwd], tmpDir: sessionTmpDir("s_bgt"), sessionId: "s1" });

  test("bash runInBackground returns a task id immediately, then bash_output reads it", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "echo hello; sleep 0.3; echo world", runInBackground: true }, ctx(cwd));
    expect(started.isError).toBe(false);
    const idMatch = started.output.match(/bg_[0-9a-f]+/);
    expect(idMatch).toBeTruthy();
    const taskId = idMatch![0];
    await sleep(600);
    const out = await r.execute("bash_output", { taskId }, ctx(cwd));
    expect(out.output).toContain("hello");
    expect(out.output).toContain("world");
    expect(out.output).toMatch(/\[status: exited, exit 0\]/);
  });

  // Standalone bash_kill was removed (CC parity: task_stop is the one generic stop tool) —
  // task_stop's bash-unify path is exercised end-to-end in task-stop.test.ts's own "(d)" test.
  test("task_stop stops a running background task (bash_kill's replacement)", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "sleep 30", runInBackground: true }, ctx(cwd));
    const taskId = started.output.match(/bg_[0-9a-f]+/)![0];
    await sleep(200);
    const killed = await r.execute("task_stop", { task_id: taskId }, ctx(cwd));
    expect(killed.isError).toBe(false);
    await sleep(600);
    const out = await r.execute("bash_output", { taskId }, ctx(cwd));
    expect(out.output).toMatch(/\[status: killed/);
  });

  test("bash_output on an unknown task is an error", async () => {
    const { r, cwd } = setup();
    const out = await r.execute("bash_output", { taskId: "bg_nope" }, ctx(cwd));
    expect(out.isError).toBe(true);
  });

  test("bash_output/task_stop on another session's task are errors (tool-layer session scoping)", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "sleep 5", runInBackground: true }, ctx(cwd)); // ctx = sessionId "s1"
    const taskId = started.output.match(/bg_[0-9a-f]+/)![0];
    const foreignCtx = { cwd, roots: [cwd], tmpDir: sessionTmpDir("s_bgt"), sessionId: "s2" };
    expect((await r.execute("bash_output", { taskId }, foreignCtx)).isError).toBe(true);
    expect((await r.execute("task_stop", { task_id: taskId }, foreignCtx)).isError).toBe(true);
    await r.execute("task_stop", { task_id: taskId }, ctx(cwd)); // clean up as the real owner (was bash_kill)
  });

  test("bash_output filter keeps only matching lines", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "echo apple; echo banana; echo apricot; sleep 0.2", runInBackground: true }, ctx(cwd));
    const taskId = started.output.match(/bg_[0-9a-f]+/)![0];
    await sleep(500);
    const out = await r.execute("bash_output", { taskId, filter: "^ap" }, ctx(cwd));
    expect(out.output).toContain("apple");
    expect(out.output).toContain("apricot");
    expect(out.output).not.toContain("banana"); // filtered out
  });

  // CC parity: bash's background-spawn RESULT carries the output file path (CC deprecated its
  // retrieval tool in favor of Read on the task's output file) — bash_output stays working too.
  test("background spawn result carries output_file: <path> + a read/grep pointer", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "echo hi", runInBackground: true }, ctx(cwd));
    expect(started.isError).toBe(false);
    expect(started.output).toContain("output_file: ");
    expect(started.output.toLowerCase()).toContain("read");
    const fileMatch = started.output.match(/output_file: (\S+)/);
    expect(fileMatch).toBeTruthy();
    expect(fileMatch![1]).toMatch(/\/bash\/bg_[0-9a-f]+\.log$/);
  });

  test("output_file is readable via the read tool and matches bash_output's view exactly", async () => {
    const { r, cwd } = setup();
    registerReadTools(r);
    const started = await r.execute("bash", { command: "echo alpha; echo beta; sleep 0.3; echo gamma", runInBackground: true }, ctx(cwd));
    const outputFile = started.output.match(/output_file: (\S+)/)![1]!;
    const taskId = started.output.match(/bg_[0-9a-f]+/)![0];
    await sleep(700);
    const viaBashOutput = await r.execute("bash_output", { taskId }, ctx(cwd));
    const viaRead = await r.execute("read", { path: outputFile }, ctx(cwd));
    expect(viaRead.isError).toBe(false);
    expect(viaRead.output).toContain("alpha");
    expect(viaRead.output).toContain("beta");
    expect(viaRead.output).toContain("gamma");
    // bash_output appends a one-line "[status: ...]" suffix the raw file never gets:
    const bashOutputBody = viaBashOutput.output.replace(/\n\[status:[^\]]*\]$/, "");
    expect(viaRead.output).toBe(bashOutputBody);
  });
});
