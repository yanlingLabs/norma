import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { sandboxAvailable } from "../../src/agent/sandbox";
import { sessionTmpDir } from "../../src/agent/session-tmp";

function proj(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-bash-"))); }
function reg(): ToolRegistry { const r = new ToolRegistry(); registerBashTool(r); return r; }

const darwin = sandboxAvailable();
const d = darwin ? describe : describe.skip;

d("bash tool (sandboxed)", () => {
  test("runs a command and reports stdout + exit 0", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo hello-norma" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hello-norma");
    expect(res.output).toContain("[exit 0]");
  });

  test("can write inside the session cwd", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo in-cwd > made.txt && cat made.txt" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(existsSync(join(cwd, "made.txt"))).toBe(true);
    expect(res.output).toContain("in-cwd");
  });

  test("CANNOT write outside the session cwd (sandbox denies)", async () => {
    const cwd = proj();
    const sibling = proj(); // a different temp dir, not a writable root of `cwd`'s sandbox
    const target = join(sibling, "escaped.txt");
    const res = await reg().execute("bash", { command: `echo pwned > ${target}` }, { cwd, roots: [cwd], sessionId: "s1" });
    // command runs but the write is denied → nonzero exit, file absent
    expect(existsSync(target)).toBe(false);
    expect(res.output).not.toContain("[exit 0]");
  });

  test("kills a command that exceeds the timeout", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "sleep 5", timeoutMs: 300 }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.output).toMatch(/timed out/);
  });

  test("bad args are a tool error, not a throw", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(true);
  });

  test("a backgrounded child does not hang the call past the timeout", async () => {
    const cwd = proj();
    const started = Date.now();
    const res = await reg().execute(
      "bash",
      { command: "(sleep 30 && touch survived.txt) & echo backgrounded", timeoutMs: 400 },
      { cwd, roots: [cwd], sessionId: "s1" },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4000); // MUST NOT block for the child's 30s lifetime
    expect(res.output).toMatch(/timed out/);
    // the killed background job never gets to create the file:
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(cwd, "survived.txt"))).toBe(false);
  });

  test("bash can write to $TMPDIR (session temp) but not system /tmp", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: 'echo scratch > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"' }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("scratch");
    expect(res.output).toContain("[exit 0]");
    const outside = await reg().execute("bash", { command: "echo x > /tmp/norma-should-fail.txt", timeoutMs: 5000 }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(existsSync("/tmp/norma-should-fail.txt")).toBe(false);
    expect(outside.output).not.toContain("[exit 0]");
  });

  test("bash can write to an extra allowed root", async () => {
    const cwd = proj();
    const extra = realpathSync(mkdtempSync(join(tmpdir(), "norma-bash-extra-")));
    const res = await reg().execute("bash", { command: `echo hi > ${extra}/in-extra.txt` }, { cwd, roots: [cwd, extra], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(existsSync(join(extra, "in-extra.txt"))).toBe(true);
  });

  test("git runs through the sandbox with clean output (no spurious permission errors)", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", {
      command: `git init -q && git -c user.email=a@b.c -c user.name=n commit --allow-empty -q -m init && echo COMMIT_OK && git --version`,
      timeoutMs: 20000,
    }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.output).toContain("COMMIT_OK");
    expect(res.output).toContain("[exit 0]");
    // these DVT/confstr(3) lines appear iff com.apple.bsd.dirhelper is missing from the sandbox mach allowlist — real regression guard
    expect(res.output).not.toMatch(/DVT/);
    expect(res.output).not.toMatch(/from confstr\(3\)/);
    expect(res.output).not.toMatch(/Failed to start fs event stream/);
  });

  test("bash aborts its child when the context signal fires", async () => {
    const cwd = proj();
    const ac = new AbortController();
    const started = Date.now();
    const p = reg().execute("bash", { command: "sleep 30" }, { cwd, roots: [cwd], tmpDir: sessionTmpDir("s_ab"), sessionId: "s1", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const res = await p;
    expect(Date.now() - started).toBeLessThan(5000); // returned promptly, not after 30s
    expect(res.output).toMatch(/abort|killed/i);
    // no orphaned sleep (group-killed) — pgrep check as in 1b-ii-a:
    const { execSync } = await import("node:child_process");
    const orphans = (() => { try { return execSync("pgrep -f 'sleep 30'").toString().trim(); } catch { return ""; } })();
    expect(orphans).toBe("");
  });

  test("bash accepts an optional justification and ignores it for execution", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo hi", justification: "because the reviewer asked" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hi"); // command ran; justification did not affect execution
  });

  // Background bash tasks tee to <sessionTmpDir>/bash/<taskId>.log (bg-registry.ts) — the
  // FOREGROUND path never touches BackgroundTaskRegistry at all, so it must never create that
  // directory, and its result must never mention output_file (that's background-only).
  test("foreground bash creates no bg output file/dir and mentions no output_file", async () => {
    const cwd = proj();
    const tmpDir = sessionTmpDir("s_fg_only");
    const res = await reg().execute("bash", { command: "echo hi" }, { cwd, roots: [cwd], tmpDir, sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).not.toContain("output_file");
    expect(existsSync(join(tmpDir, "bash"))).toBe(false);
  });
});
