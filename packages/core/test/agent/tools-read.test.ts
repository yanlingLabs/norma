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
    const ok = await r.execute("read", { path: "a.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(ok).toEqual({ output: "alpha\nbeta\ngamma\n", isError: false });
    const missing = await r.execute("read", { path: "nope.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("nope.txt");
  });

  test("glob lists matches as absolute paths under the root", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("glob", { pattern: "**/*.md" }, { cwd: d, roots: [d], sessionId: "s1" });
    // glob now scans per-root (to support multiple roots) and returns full paths, not cwd-relative names.
    expect(res).toEqual({ output: join(d, "sub", "b.md"), isError: false });
  });

  test("glob cannot list outside the root via .. patterns", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("glob", { pattern: "../*" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError === true || res.output === "").toBe(true);
    expect(res.output).not.toContain("norma-tools-"); // sibling temp dirs must not leak
  });

  test("glob cannot list absolute paths outside the root", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("glob", { pattern: "/etc/h*" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError === true || res.output === "").toBe(true);
    expect(res.output).not.toContain("hosts");
  });

  test("grep finds matches with file:line prefixes", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("grep", { pattern: "alpha", glob: "**/*" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("a.txt:1:alpha");
    expect(res.output).toContain("sub/b.md:2:contains alpha too");
  });

  test("path escape is refused as a tool error", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("read", { path: "../../etc/hosts" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/outside/);
  });

  test("unknown tool and bad args are tool errors", async () => {
    const d = proj();
    const r = makeRegistry(d);
    expect((await r.execute("teleport", {}, { cwd: d, roots: [d], sessionId: "s1" })).isError).toBe(true);
    expect((await r.execute("read", { wrongField: 1 }, { cwd: d, roots: [d], sessionId: "s1" })).isError).toBe(true);
  });

  test("grep rejects patterns longer than 256 chars (ReDoS bound)", async () => {
    const d = proj();
    const res = await makeRegistry(d).execute("grep", { pattern: "a".repeat(300), glob: "**/*" }, { cwd: d, roots: [d], sessionId: "s1" });
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
    const res = await r.execute("grep", { pattern: "(a+)+$", glob: "**/*", budgetMs: 100 }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[scan time budget reached]");
  });

  test("read/glob/grep span multiple allowed roots", async () => {
    const a = proj(); // has a.txt, sub/b.md
    const b = realpathSync(mkdtempSync(join(tmpdir(), "norma-read2-")));
    writeFileSync(join(b, "extra.txt"), "alpha in b\n");
    const r = makeRegistry(a); // registers read tools
    const ctx = { cwd: a, roots: [a, b], sessionId: "s1" };
    expect((await r.execute("read", { path: join(b, "extra.txt") }, ctx)).output).toContain("alpha in b");
    const g = await r.execute("grep", { pattern: "alpha", glob: "**/*" }, ctx);
    expect(g.output).toContain("a.txt:1:"); // from root a
    // reading outside all roots still denied:
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-read3-")));
    writeFileSync(join(outside, "secret.txt"), "x");
    expect((await r.execute("read", { path: join(outside, "secret.txt") }, ctx)).isError).toBe(true);
  });

  test("glob does not leak OS paths from an absolute recursive pattern outside roots", async () => {
    const d = proj();
    const r = makeRegistry(d);
    const res = await r.execute("glob", { pattern: "/etc/**", budgetMs: 1500 }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.output).not.toContain("/etc/"); // no out-of-root OS path leaks (match or error)
    // and it does not hang: (the await returning is itself the proof)
  });

  test("grep does not leak OS error paths from an absolute recursive glob outside roots", async () => {
    const d = proj();
    const r = makeRegistry(d);
    const res = await r.execute("grep", { pattern: ".", glob: "/etc/**", budgetMs: 1500 }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.output).not.toMatch(/\/etc\//);
  });
});

describe("ls tool", () => {
  function makeRegistry(): ToolRegistry {
    const r = new ToolRegistry();
    registerReadTools(r);
    return r;
  }

  test("lists entries sorted, dirs first then files, dirs suffixed with /", async () => {
    const d = proj(); // a.txt (file), sub/ (dir)
    const res = await makeRegistry().execute("ls", { path: d }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res).toEqual({ output: "sub/\na.txt", isError: false });
  });

  test("ignore globs filter entries by name (dirs and files alike)", async () => {
    const d = proj();
    writeFileSync(join(d, "z.log"), "noise\n");
    mkdirSync(join(d, "node_modules"));
    const res = await makeRegistry().execute(
      "ls",
      { path: d, ignore: ["*.log", "node_modules"] },
      { cwd: d, roots: [d], sessionId: "s1" },
    );
    expect(res.isError).toBe(false);
    expect(res.output).toBe("sub/\na.txt");
    expect(res.output).not.toContain("z.log");
    expect(res.output).not.toContain("node_modules");
  });

  test("path that is a file, not a directory, is a tool error", async () => {
    const d = proj();
    const res = await makeRegistry().execute("ls", { path: join(d, "a.txt") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/not a directory/);
  });

  test("path that does not exist is a tool error", async () => {
    const d = proj();
    const res = await makeRegistry().execute("ls", { path: join(d, "nope") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/does not exist/);
  });

  test("relative path is refused (absolute path required, CC LS parity)", async () => {
    const d = proj();
    const res = await makeRegistry().execute("ls", { path: "sub" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/absolute/);
  });

  test("path outside the allowed roots is refused (same fence as read/glob)", async () => {
    const d = proj();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-ls-outside-")));
    const res = await makeRegistry().execute("ls", { path: outside }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/outside/);
  });

  test("caps at 1000 entries with a trailing truncation line", async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "norma-ls-big-")));
    for (let i = 0; i < 1005; i++) writeFileSync(join(d, `f${String(i).padStart(4, "0")}.txt`), "");
    const res = await makeRegistry().execute("ls", { path: d }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    const lines = res.output.split("\n");
    expect(lines).toHaveLength(1001); // 1000 entries + the truncation line
    expect(lines[1000]).toBe("… (+5 more truncated)");
  });

  test("ls is registered alongside read/glob/grep", () => {
    const names = makeRegistry().specs().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["read", "glob", "grep", "ls"]));
  });
});
