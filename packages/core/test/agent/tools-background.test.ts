import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerBackgroundTools } from "../../src/agent/tools/background";
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

  test("bash_kill stops a running background task", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "sleep 30", runInBackground: true }, ctx(cwd));
    const taskId = started.output.match(/bg_[0-9a-f]+/)![0];
    await sleep(200);
    const killed = await r.execute("bash_kill", { taskId }, ctx(cwd));
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

  test("bash_output/bash_kill on another session's task are errors (tool-layer session scoping)", async () => {
    const { r, cwd } = setup();
    const started = await r.execute("bash", { command: "sleep 5", runInBackground: true }, ctx(cwd)); // ctx = sessionId "s1"
    const taskId = started.output.match(/bg_[0-9a-f]+/)![0];
    const foreignCtx = { cwd, roots: [cwd], tmpDir: sessionTmpDir("s_bgt"), sessionId: "s2" };
    expect((await r.execute("bash_output", { taskId }, foreignCtx)).isError).toBe(true);
    expect((await r.execute("bash_kill", { taskId }, foreignCtx)).isError).toBe(true);
    await r.execute("bash_kill", { taskId }, ctx(cwd)); // clean up as the real owner
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
});
