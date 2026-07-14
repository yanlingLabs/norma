import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// task-10: a fixture standing in for Norma's own ~/.norma/run — NEVER the real ~/.norma. Mirrors
// daemon.ts's wiring (registerReadTools(registry, { deniedPrefixes: [dirs.runDir] })) with a
// throwaway temp "normaHome" instead of the real one.
function denyFixture(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-deny-home-")));
  const runDir = join(home, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "core.lock"), JSON.stringify({ pid: 123 }));
  writeFileSync(join(runDir, "harness-token.secret"), "topsecrettoken");
  return runDir;
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

describe("read tools — unrestricted reads (task-10, user rule)", () => {
  function makeRegistry(): ToolRegistry {
    const r = new ToolRegistry();
    registerReadTools(r);
    return r;
  }

  // web_fetch (4g) saves full pages into the session tmp dir, which is NOT in the write-fence
  // `roots`; the read-only fs tools can read/grep/glob what landed there regardless — read doesn't
  // even need tmpDir listed anymore (an absolute path is unrestricted on its own), while grep's
  // RELATIVE scanning still needs tmpDir as a scan root to find it via a relative pattern.
  test("read reaches an absolute path in the session tmp dir with or without tmpDir in ctx", async () => {
    const d = proj();
    const t = realpathSync(mkdtempSync(join(tmpdir(), "norma-session-")));
    writeFileSync(join(t, "webfetch-1-example.com.md"), "# Example Domain\nThis domain is for use in examples.\n");
    const r = makeRegistry();
    const withTmp = await r.execute("read", { path: join(t, "webfetch-1-example.com.md") }, { cwd: d, roots: [d], tmpDir: t, sessionId: "s1" });
    expect(withTmp.isError).toBe(false);
    expect(withTmp.output).toContain("# Example Domain");
    // no fence at all now — the same absolute path reads fine even without tmpDir in ctx
    const withoutTmp = await r.execute("read", { path: join(t, "webfetch-1-example.com.md") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(withoutTmp.isError).toBe(false);
    expect(withoutTmp.output).toContain("# Example Domain");
  });

  test("grep's relative-pattern scanning still reaches tmpDir when ctx supplies it", async () => {
    const d = proj();
    const t = realpathSync(mkdtempSync(join(tmpdir(), "norma-session-")));
    writeFileSync(join(t, "webfetch-1-example.com.md"), "# Example Domain\nThis domain is for use in examples.\n");
    const r = makeRegistry();
    const grep = await r.execute("grep", { pattern: "Example Domain", glob: "**/*" }, { cwd: d, roots: [d], tmpDir: t, sessionId: "s1" });
    expect(grep.isError).toBe(false);
    expect(grep.output).toContain("Example Domain");
  });

  test("specs are exposed for the provider", () => {
    const r = makeRegistry();
    const names = r.specs().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["read", "glob", "grep"]));
  });

  test("read returns file contents; missing file is a tool error not a throw", async () => {
    const d = proj();
    const r = makeRegistry();
    const ok = await r.execute("read", { path: "a.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(ok).toEqual({ output: "alpha\nbeta\ngamma\n", isError: false });
    const missing = await r.execute("read", { path: "nope.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("nope.txt");
  });

  test("read: relative path resolves against roots[0] (session cwd)", async () => {
    const d = proj();
    const r = makeRegistry();
    const res = await r.execute("read", { path: "sub/b.md" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res).toEqual({ output: "# beta doc\ncontains alpha too\n", isError: false });
  });

  test("read: absolute path outside every session root succeeds (no fence at all)", async () => {
    const d = proj();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-read-outside-")));
    writeFileSync(join(outside, "secret.txt"), "biggest-files-scan needs this");
    const res = await makeRegistry().execute("read", { path: join(outside, "secret.txt") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res).toEqual({ output: "biggest-files-scan needs this", isError: false });
  });

  test("ls: absolute path outside every session root succeeds (no fence at all)", async () => {
    const d = proj();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-ls-outside-")));
    writeFileSync(join(outside, "f.txt"), "");
    const res = await makeRegistry().execute("ls", { path: outside }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("f.txt");
  });

  test("read: a relative path that escapes via .. now succeeds (no fence for read, unlike glob/grep)", async () => {
    const w = realpathSync(mkdtempSync(join(tmpdir(), "norma-escape-")));
    const d = join(w, "cwd");
    mkdirSync(d);
    writeFileSync(join(w, "sibling.txt"), "sibling content");
    const res = await makeRegistry().execute("read", { path: "../sibling.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res).toEqual({ output: "sibling content", isError: false });
  });

  test("glob lists matches as absolute paths under the root", async () => {
    const d = proj();
    const res = await makeRegistry().execute("glob", { pattern: "**/*.md" }, { cwd: d, roots: [d], sessionId: "s1" });
    // glob now scans per-root (to support multiple roots) and returns full paths, not cwd-relative names.
    expect(res).toEqual({ output: join(d, "sub", "b.md"), isError: false });
  });

  test("glob: relative pattern still cannot escape the session roots via .. (unchanged)", async () => {
    const d = proj();
    const res = await makeRegistry().execute("glob", { pattern: "../*" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError === true || res.output === "").toBe(true);
    expect(res.output).not.toContain("norma-tools-"); // sibling temp dirs must not leak via a RELATIVE pattern
  });

  test("glob: an absolute pattern may target anywhere on disk", async () => {
    const d = proj();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-glob-outside-")));
    writeFileSync(join(outside, "anywhere.log"), "");
    const res = await makeRegistry().execute("glob", { pattern: join(outside, "*.log") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res).toEqual({ output: join(outside, "anywhere.log"), isError: false });
  });

  test("grep finds matches with file:line prefixes", async () => {
    const d = proj();
    const res = await makeRegistry().execute("grep", { pattern: "alpha", glob: "**/*" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("a.txt:1:alpha");
    expect(res.output).toContain("sub/b.md:2:contains alpha too");
  });

  test("grep: an absolute glob base may target anywhere on disk", async () => {
    const d = proj();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-grep-outside-")));
    writeFileSync(join(outside, "note.txt"), "findme here\n");
    const res = await makeRegistry().execute("grep", { pattern: "findme", glob: join(outside, "**/*") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("findme here");
  });

  test("unknown tool and bad args are tool errors", async () => {
    const d = proj();
    const r = makeRegistry();
    expect((await r.execute("teleport", {}, { cwd: d, roots: [d], sessionId: "s1" })).isError).toBe(true);
    expect((await r.execute("read", { wrongField: 1 }, { cwd: d, roots: [d], sessionId: "s1" })).isError).toBe(true);
  });

  test("grep rejects patterns longer than 256 chars (ReDoS bound)", async () => {
    const d = proj();
    const res = await makeRegistry().execute("grep", { pattern: "a".repeat(300), glob: "**/*" }, { cwd: d, roots: [d], sessionId: "s1" });
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

  test("read/glob/grep span multiple allowed roots, and reading beyond ALL of them now also succeeds", async () => {
    const a = proj(); // has a.txt, sub/b.md
    const b = realpathSync(mkdtempSync(join(tmpdir(), "norma-read2-")));
    writeFileSync(join(b, "extra.txt"), "alpha in b\n");
    const r = makeRegistry();
    const ctx = { cwd: a, roots: [a, b], sessionId: "s1" };
    expect((await r.execute("read", { path: join(b, "extra.txt") }, ctx)).output).toContain("alpha in b");
    const g = await r.execute("grep", { pattern: "alpha", glob: "**/*" }, ctx);
    expect(g.output).toContain("a.txt:1:"); // from root a
    // reading outside all roots now succeeds too (unrestricted reads, task-10):
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-read3-")));
    writeFileSync(join(outside, "secret.txt"), "x");
    const res = await r.execute("read", { path: join(outside, "secret.txt") }, ctx);
    expect(res).toEqual({ output: "x", isError: false });
  });

  test("read: offset/limit select a line window, cat-n style guidance honored", async () => {
    const d = proj();
    writeFileSync(join(d, "lines.txt"), "l1\nl2\nl3\nl4\nl5");
    const r = makeRegistry();
    // offset is 1-based line number
    const res1 = await r.execute("read", { path: "lines.txt", offset: 2, limit: 2 }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res1).toEqual({ output: "l2\nl3", isError: false });
    // default offset is 1
    const res2 = await r.execute("read", { path: "lines.txt", limit: 2 }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res2).toEqual({ output: "l1\nl2", isError: false });
    // no offset/limit returns all
    const res3 = await r.execute("read", { path: "lines.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res3).toEqual({ output: "l1\nl2\nl3\nl4\nl5", isError: false });
  });

  test("64KB read truncation cap still enforced (token protection, not sandboxing)", async () => {
    const d = proj();
    writeFileSync(join(d, "big.txt"), "x".repeat(200_000));
    const res = await makeRegistry().execute("read", { path: "big.txt" }, { cwd: d, roots: [d], sessionId: "s1" });
    // registry.execute caps tool OUTPUT at 64KB regardless of tool; content itself isn't tool-side
    // truncated by fs-read.ts, but the overall outcome must still be capped before reaching the model.
    expect(res.isError).toBe(false);
    expect(res.output).toContain(`[truncated at ${64 * 1024} bytes]`);
  });

  test("grep 200-match cap still enforced", async () => {
    const d = proj();
    const lines = Array.from({ length: 250 }, () => "needle").join("\n");
    writeFileSync(join(d, "many.txt"), lines);
    const res = await makeRegistry().execute("grep", { pattern: "needle", glob: "**/*" }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[match cap reached]");
    const matchLines = res.output.split("\n").filter((l) => l.includes("needle"));
    expect(matchLines.length).toBe(200);
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

describe("read-only denylist — Norma's own credential/runtime dir (task-10)", () => {
  test("read of a denylisted path is refused with the exact message", async () => {
    const d = proj();
    const runDir = denyFixture();
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("read", { path: join(runDir, "harness-token.secret") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("this path is Norma's own credential store and is never readable");
  });

  test("ls of a denylisted directory is refused with the exact message", async () => {
    const d = proj();
    const runDir = denyFixture();
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("ls", { path: runDir }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("this path is Norma's own credential store and is never readable");
  });

  test("a denylisted subpath (not just the exact dir) is refused too", async () => {
    const d = proj();
    const runDir = denyFixture();
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("read", { path: join(runDir, "sub", "deeper.txt") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("this path is Norma's own credential store and is never readable");
  });

  test("glob traversing into a denylisted dir silently skips it rather than erroring the whole scan", async () => {
    const d = proj();
    const runDir = denyFixture();
    const home = dirname(runDir);
    writeFileSync(join(home, "visible.txt"), "not a secret");
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("glob", { pattern: join(home, "**/*") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("visible.txt");
    expect(res.output).not.toContain("harness-token.secret");
    expect(res.output).not.toContain("core.lock");
  });

  test("grep traversing into a denylisted dir silently skips it rather than erroring the whole scan", async () => {
    const d = proj();
    const runDir = denyFixture();
    const home = dirname(runDir);
    writeFileSync(join(home, "visible.txt"), "topsecrettoken elsewhere too");
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("grep", { pattern: "topsecrettoken", glob: join(home, "**/*") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("visible.txt");
    // the file living INSIDE the denylisted dir must never be read/matched, even though its
    // content also matches the pattern:
    expect(res.output).not.toContain("harness-token.secret");
  });

  test("a symlink into the denylisted dir is also refused (prefix match is realpath-hardened)", async () => {
    const d = proj();
    const runDir = denyFixture();
    const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-deny-link-")));
    const link = join(linkDir, "sneaky");
    require("node:fs").symlinkSync(runDir, link, "dir");
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("read", { path: join(link, "harness-token.secret") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("this path is Norma's own credential store and is never readable");
  });

  test("ls of the denied dir's PARENT omits the denied entry name; other entries still listed", async () => {
    const d = proj();
    const runDir = denyFixture();
    const home = dirname(runDir);
    writeFileSync(join(home, "visible.txt"), "x");
    mkdirSync(join(home, "runfoo")); // prefix-sibling of the denied name — must survive the filter
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("ls", { path: home }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
    // dirs first then files; `run/` (the denied entry) simply doesn't appear
    expect(res.output).toBe("runfoo/\nvisible.txt");
  });

  test("prefix boundary: a sibling dir sharing the denied name as a prefix (runfoo vs run) is NOT denied", async () => {
    const d = proj();
    const runDir = denyFixture(); // denies <home>/run
    const sibling = join(dirname(runDir), "runfoo");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "ok.txt"), "prefix boundary holds");
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    // pins the `+ sep` anchor in isDenied: "<home>/runfoo" must not match prefix "<home>/run"
    const read = await r.execute("read", { path: join(sibling, "ok.txt") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(read).toEqual({ output: "prefix boundary holds", isError: false });
    const ls = await r.execute("ls", { path: sibling }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(ls).toEqual({ output: "ok.txt", isError: false });
  });

  test("an uppercased spelling of the denied dir is still denied on a case-insensitive volume (realpath canonicalization)", async () => {
    const d = proj();
    const runDir = denyFixture(); // real casing: <home>/run
    const upper = join(dirname(runDir), "RUN", "harness-token.secret");
    const r = new ToolRegistry();
    registerReadTools(r, { deniedPrefixes: [runDir] });
    const res = await r.execute("read", { path: upper }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(true);
    if (res.output !== "this path is Norma's own credential store and is never readable") {
      // case-SENSITIVE test volume: the uppercase spelling doesn't resolve to anything at all —
      // the fs itself refuses (ENOENT), so no case-aliased route into the denied dir exists to pin.
      // On the default case-insensitive APFS volume the branch above is what actually runs: the
      // denylist's canonAncestor realpaths "RUN" to the on-disk "run" casing and refuses.
      expect(res.output).toMatch(/no such file|ENOENT/i);
    }
  });

  test("with no denylist configured, nothing is refused (existing callers unaffected)", async () => {
    const d = proj();
    const r = new ToolRegistry();
    registerReadTools(r); // no opts — same as every pre-task-10 caller
    const res = await r.execute("read", { path: join(d, "a.txt") }, { cwd: d, roots: [d], sessionId: "s1" });
    expect(res.isError).toBe(false);
  });
});
