import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWriteTools } from "../../src/agent/tools/fs-write";

function setup(): { r: ToolRegistry; d: string } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "norma-wtools-")));
  const r = new ToolRegistry();
  registerWriteTools(r);
  return { r, d };
}

describe("write tools", () => {
  test("write creates a file (and parent dirs) inside cwd", async () => {
    const { r, d } = setup();
    const res = await r.execute("write", { path: "new/dir/hello.txt", content: "norma was here" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(readFileSync(join(d, "new/dir/hello.txt"), "utf8")).toBe("norma was here");
  });

  test("write reports true UTF-8 byte count, not char count", async () => {
    const { r, d } = setup();
    const res = await r.execute("write", { path: "u.txt", content: "héllo 🌍" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("11 bytes"); // 8 chars, 11 utf-8 bytes
  });

  test("edit replaces a unique occurrence; ambiguous or missing old_string errors", async () => {
    const { r, d } = setup();
    writeFileSync(join(d, "f.txt"), "one two two three");
    const bad = await r.execute("edit", { path: "f.txt", old_string: "two", new_string: "2" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/2 occurrences/);
    const missing = await r.execute("edit", { path: "f.txt", old_string: "zzz", new_string: "x" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(missing.isError).toBe(true);
    const ok = await r.execute("edit", { path: "f.txt", old_string: "one", new_string: "1" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(d, "f.txt"), "utf8")).toBe("1 two two three");
  });

  test("writes outside cwd are refused", async () => {
    const { r, d } = setup();
    rmSync("/tmp/evil.txt", { force: true });
    const res = await r.execute("write", { path: "/tmp/evil.txt", content: "x" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(existsSync("/tmp/evil.txt")).toBe(false);
  });

  test("edit outside cwd is refused", async () => {
    const { r, d } = setup();
    const res = await r.execute("edit", { path: "/etc/hosts", old_string: "localhost", new_string: "x" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/outside the allowed directories/);
  });

  test("edit: replace_all replaces every occurrence; default still requires uniqueness", async () => {
    const { r, d } = setup();
    writeFileSync(join(d, "multi.txt"), "a b a");
    // without replace_all, editing "a" (appears 2x) should error
    const noReplace = await r.execute("edit", { path: "multi.txt", old_string: "a", new_string: "x" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(noReplace.isError).toBe(true);
    expect(noReplace.output).toMatch(/2 occurrences/);
    // with replace_all: true, should replace both
    const withReplace = await r.execute("edit", { path: "multi.txt", old_string: "a", new_string: "x", replace_all: true }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(withReplace.isError).toBe(false);
    expect(readFileSync(join(d, "multi.txt"), "utf8")).toBe("x b x");
  });

  test("write succeeds in a non-cwd allowed root", async () => {
    const { r, d } = setup();
    const b = realpathSync(mkdtempSync(join(tmpdir(), "norma-w2-")));
    const res = await r.execute("write", { path: join(b, "made.txt"), content: "hi" }, { cwd: d, roots: [d, b], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(readFileSync(join(b, "made.txt"), "utf8")).toBe("hi");
  });

  // write-permission-flow (task 24, CC parity): request_directory is gone — a bare ToolRegistry
  // call (no engine wiring, as here) still hard-fails on an out-of-root target with the plain
  // fence message. The GRANT flow (session-scoped, out-of-root write/edit rides the approval seam
  // bash uses) lives in engine.ts's dispatch loop, which sees this fence throw and, under `ask`/
  // `auto` policy, grants the containing directory to SessionDirectories BEFORE ever calling this
  // tool — so by the time resolveWithinAny reads `roots` in production it already includes the
  // grant. See engine.test.ts for the end-to-end grant flow; this file only covers the tool's own
  // fence in isolation, unchanged.
  test("write outside all roots errors with the plain fence message (no request_directory mention)", async () => {
    const { r, d } = setup();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-w3-")));
    const res = await r.execute("write", { path: join(outside, "x.txt"), content: "y" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/outside the allowed directories/);
    expect(res.output).not.toMatch(/request_directory/);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });
});
