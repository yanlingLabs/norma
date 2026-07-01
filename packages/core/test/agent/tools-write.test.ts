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
    const res = await r.execute("write", { path: "new/dir/hello.txt", content: "norma was here" }, { cwd: d });
    expect(res.isError).toBe(false);
    expect(readFileSync(join(d, "new/dir/hello.txt"), "utf8")).toBe("norma was here");
  });

  test("write reports true UTF-8 byte count, not char count", async () => {
    const { r, d } = setup();
    const res = await r.execute("write", { path: "u.txt", content: "héllo 🌍" }, { cwd: d });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("11 bytes"); // 8 chars, 11 utf-8 bytes
  });

  test("edit replaces a unique occurrence; ambiguous or missing old_string errors", async () => {
    const { r, d } = setup();
    writeFileSync(join(d, "f.txt"), "one two two three");
    const bad = await r.execute("edit", { path: "f.txt", old_string: "two", new_string: "2" }, { cwd: d });
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/2 occurrences/);
    const missing = await r.execute("edit", { path: "f.txt", old_string: "zzz", new_string: "x" }, { cwd: d });
    expect(missing.isError).toBe(true);
    const ok = await r.execute("edit", { path: "f.txt", old_string: "one", new_string: "1" }, { cwd: d });
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(d, "f.txt"), "utf8")).toBe("1 two two three");
  });

  test("writes outside cwd are refused", async () => {
    const { r, d } = setup();
    rmSync("/tmp/evil.txt", { force: true });
    const res = await r.execute("write", { path: "/tmp/evil.txt", content: "x" }, { cwd: d });
    expect(res.isError).toBe(true);
    expect(existsSync("/tmp/evil.txt")).toBe(false);
  });

  test("edit outside cwd is refused", async () => {
    const { r, d } = setup();
    const res = await r.execute("edit", { path: "/etc/hosts", old_string: "localhost", new_string: "x" }, { cwd: d });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/outside the session directory/);
  });
});
