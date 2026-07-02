import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerRequestDirTool } from "../../src/agent/tools/request-dir";
import { ApprovalBroker } from "../../src/agent/approvals";
import { SessionDirectories } from "../../src/agent/dirs";

function setup(project: string | null) {
  const broker = new ApprovalBroker();
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-rd-cwd-")));
  const dirs = new SessionDirectories(() => [cwd]);
  const events: any[] = [];
  const r = new ToolRegistry();
  registerRequestDirTool(r, {
    broker, dirs,
    emit: (_sid, e) => events.push(e),
    projectDir: () => project,
    approvalTimeoutMs: 500,
  });
  return { r, broker, dirs, events, cwd, ctx: { cwd, roots: dirs.roots("s1"), sessionId: "s1" } };
}

describe("request_directory", () => {
  test("approval adds the dir to the live roots and emits directory_added", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "norma-rd-proj-")));
    const { r, broker, dirs, events, ctx } = setup(project);
    const target = realpathSync(mkdtempSync(join(tmpdir(), "norma-rd-target-")));
    const p = r.execute("request_directory", { path: target, persist: true }, ctx);
    // approve as soon as the request is observed:
    await new Promise((res) => setTimeout(res, 20));
    const ask = events.find((e) => e.type === "approval_requested");
    expect(ask).toBeTruthy();
    broker.resolve("s1", ask.callId, true, "user");
    const res = await p;
    expect(res.isError).toBe(false);
    expect(dirs.has("s1", target)).toBe(true);
    expect(events.some((e) => e.type === "directory_added" && e.persisted === true)).toBe(true);
    const local = JSON.parse(readFileSync(join(project, ".norma", "settings.local.json"), "utf8"));
    expect(local.permissions.additionalDirectories).toContain(target);
  });

  test("denial does not add the dir", async () => {
    const { r, broker, dirs, events, ctx } = setup(null);
    const target = realpathSync(mkdtempSync(join(tmpdir(), "norma-rd-t2-")));
    const p = r.execute("request_directory", { path: target }, ctx);
    await new Promise((res) => setTimeout(res, 20));
    const ask = events.find((e) => e.type === "approval_requested");
    broker.resolve("s1", ask.callId, false, "user");
    const res = await p;
    expect(res.isError).toBe(true);
    expect(dirs.has("s1", target)).toBe(false);
  });

  test("timeout denies", async () => {
    const { r, ctx } = setup(null);
    const target = realpathSync(mkdtempSync(join(tmpdir(), "norma-rd-t3-")));
    const res = await r.execute("request_directory", { path: target }, ctx);
    expect(res.isError).toBe(true);
  });

  test("persist:true with no project dir — adds to live roots, emits persisted:false, does not throw, does not persist", async () => {
    const { r, broker, dirs, events, ctx } = setup(null); // no project dir
    const target = realpathSync(mkdtempSync(join(tmpdir(), "norma-rd-noproj-")));
    const p = r.execute("request_directory", { path: target, persist: true }, ctx);
    await new Promise((res) => setTimeout(res, 20));
    const ask = events.find((e) => e.type === "approval_requested");
    broker.resolve("s1", ask.callId, true, "user");
    const res = await p;
    expect(res.isError).toBe(false); // did not throw
    expect(dirs.has("s1", target)).toBe(true); // added to LIVE roots
    const da = events.find((e) => e.type === "directory_added");
    expect(da).toBeTruthy();
    expect(da.persisted).toBe(false); // NOT persisted (no project dir)
  });
});
