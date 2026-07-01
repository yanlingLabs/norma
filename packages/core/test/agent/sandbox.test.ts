import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeatbeltProfile } from "../../src/agent/sandbox";

function realTmp(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-sb-"))); }

describe("buildSeatbeltProfile", () => {
  test("denies by default, allows read everywhere, writes only under writable roots", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd });
    expect(p).toContain("(deny default)");
    expect(p).toContain("(allow file-read*)");
    expect(p).toContain(`(subpath "${cwd}")`); // cwd is a writable root
    expect(p).toContain("(allow process-exec)");
    expect(p).toContain("(deny network*)"); // network denied by default
  });

  test("network can be explicitly allowed", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: true });
    expect(p).toContain("(allow network*)");
    expect(p).not.toContain("(deny network*)");
  });

  test("extra writable roots are included and realpath-canonicalized", () => {
    const cwd = realTmp();
    const extra = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra] });
    expect(p).toContain(`(subpath "${cwd}")`);
    expect(p).toContain(`(subpath "${extra}")`);
  });

  test("paths with quotes/backslashes are escaped in the profile", () => {
    // craft a fake path string with a quote — builder must escape it, not break the SBPL
    const p = buildSeatbeltProfile({ cwd: "/tmp/a", writableRoots: ['/tmp/we"ird', "/tmp/back\\slash"] });
    expect(p).toContain('(subpath "/tmp/we\\"ird")');
    expect(p).toContain('(subpath "/tmp/back\\\\slash")');
  });

  test("empty writableRoots yields exactly cwd as the sole writable root (bash tool's call shape)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [] });
    // exactly one subpath rule, and it is cwd (the ?? [tmpdir()] default must NOT fire on [])
    const subpaths = [...p.matchAll(/\(subpath "([^"]*)"\)/g)].map((m) => m[1]);
    expect(subpaths).toEqual([cwd]);
    expect(subpaths).toHaveLength(1);
  });

  test("sandboxAvailable reflects the platform", () => {
    const { sandboxAvailable } = require("../../src/agent/sandbox");
    expect(sandboxAvailable()).toBe(process.platform === "darwin");
  });
});
