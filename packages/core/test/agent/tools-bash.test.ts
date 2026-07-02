import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { sandboxAvailable } from "../../src/agent/sandbox";

function proj(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-bash-"))); }
function reg(): ToolRegistry { const r = new ToolRegistry(); registerBashTool(r); return r; }

const darwin = sandboxAvailable();
const d = darwin ? describe : describe.skip;

d("bash tool (sandboxed)", () => {
  test("runs a command and reports stdout + exit 0", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo hello-norma" }, { cwd, roots: [cwd] });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hello-norma");
    expect(res.output).toContain("[exit 0]");
  });

  test("can write inside the session cwd", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo in-cwd > made.txt && cat made.txt" }, { cwd, roots: [cwd] });
    expect(res.isError).toBe(false);
    expect(existsSync(join(cwd, "made.txt"))).toBe(true);
    expect(res.output).toContain("in-cwd");
  });

  test("CANNOT write outside the session cwd (sandbox denies)", async () => {
    const cwd = proj();
    const sibling = proj(); // a different temp dir, not a writable root of `cwd`'s sandbox
    const target = join(sibling, "escaped.txt");
    const res = await reg().execute("bash", { command: `echo pwned > ${target}` }, { cwd, roots: [cwd] });
    // command runs but the write is denied → nonzero exit, file absent
    expect(existsSync(target)).toBe(false);
    expect(res.output).not.toContain("[exit 0]");
  });

  test("kills a command that exceeds the timeout", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "sleep 5", timeoutMs: 300 }, { cwd, roots: [cwd] });
    expect(res.output).toMatch(/timed out/);
  });

  test("bad args are a tool error, not a throw", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "" }, { cwd, roots: [cwd] });
    expect(res.isError).toBe(true);
  });

  test("a backgrounded child does not hang the call past the timeout", async () => {
    const cwd = proj();
    const started = Date.now();
    const res = await reg().execute(
      "bash",
      { command: "(sleep 30 && touch survived.txt) & echo backgrounded", timeoutMs: 400 },
      { cwd, roots: [cwd] },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4000); // MUST NOT block for the child's 30s lifetime
    expect(res.output).toMatch(/timed out/);
    // the killed background job never gets to create the file:
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(cwd, "survived.txt"))).toBe(false);
  });
});
