import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithin } from "../../src/agent/paths";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";

function proj(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "norma-tools-")));
  writeFileSync(join(d, "a.txt"), "alpha\nbeta\ngamma\n");
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "b.md"), "# beta doc\ncontains alpha too\n");
  return d;
}

describe("resolveWithin", () => {
  test("allows inside paths, rejects escapes", () => {
    const d = proj();
    expect(resolveWithin(d, "a.txt")).toBe(join(d, "a.txt"));
    expect(resolveWithin(d, "./sub/b.md")).toBe(join(d, "sub", "b.md"));
    expect(() => resolveWithin(d, "../outside.txt")).toThrow(/outside/);
    expect(() => resolveWithin(d, "/etc/passwd")).toThrow(/outside/);
  });
});

describe("read tools", () => {
  function makeRegistry(cwd: string): ToolRegistry {
    const r = new ToolRegistry();
    registerReadTools(r);
    return r;
  }

  test("specs are exposed for the provider", () => {
    const r = makeRegistry(proj());
    const names = r.specs().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["read", "glob", "grep"]));
  });

  test("read returns file contents; missing file is a tool error not a throw", async () => {
    const d = proj();
    const r = makeRegistry(d);
    const ok = await r.execute("read", { path: "a.txt" }, { cwd: d });
    expect(ok).toEqual({ output: "alpha\nbeta\ngamma\n", isError: false });
    const missing = await r.execute("read", { path: "nope.txt" }, { cwd: d });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("nope.txt");
  });

  test("glob lists matches relative to cwd", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("glob", { pattern: "**/*.md" }, { cwd: d });
    expect(res).toEqual({ output: "sub/b.md", isError: false });
  });

  test("glob cannot list outside the root via .. patterns", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("glob", { pattern: "../*" }, { cwd: d });
    expect(res.isError === true || res.output === "").toBe(true);
    expect(res.output).not.toContain("norma-tools-"); // sibling temp dirs must not leak
  });

  test("glob cannot list absolute paths outside the root", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("glob", { pattern: "/etc/h*" }, { cwd: d });
    expect(res.isError === true || res.output === "").toBe(true);
    expect(res.output).not.toContain("hosts");
  });

  test("grep finds matches with file:line prefixes", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("grep", { pattern: "alpha", glob: "**/*" }, { cwd: d });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("a.txt:1:alpha");
    expect(res.output).toContain("sub/b.md:2:contains alpha too");
  });

  test("path escape is refused as a tool error", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("read", { path: "../../etc/hosts" }, { cwd: d });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/outside/);
  });

  test("unknown tool and bad args are tool errors", async () => {
    const d = proj();
    const r = makeRegistry(d);
    expect((await r.execute("teleport", {}, { cwd: d })).isError).toBe(true);
    expect((await r.execute("read", { wrongField: 1 }, { cwd: d })).isError).toBe(true);
  });

  test("grep rejects patterns longer than 256 chars (ReDoS bound)", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("grep", { pattern: "a".repeat(300), glob: "**/*" }, { cwd: d });
    expect(res.isError).toBe(true);
  });

  test("grep returns a partial result under a wall-clock budget instead of hanging", async () => {
    const d = proj();
    const { writeFileSync } = require("node:fs");
    // A line that makes (a+)+$ backtrack ~forever:
    // Create it early in alphabetical order to be scanned soon
    writeFileSync(join(d, "0-evil.txt"), "a".repeat(40) + "!\n");
    // Create a large file to slow down the scan
    writeFileSync(join(d, "zzz-large.txt"), "test line\n".repeat(10000));
    const r = new ToolRegistry();
    registerReadTools(r);
    const res = await r.execute("grep", { pattern: "(a+)+$", glob: "**/*", budgetMs: 100 }, { cwd: d });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[scan time budget reached]");
  });
});
