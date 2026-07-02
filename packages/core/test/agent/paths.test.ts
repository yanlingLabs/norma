import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithinAny, resolveWithin } from "../../src/agent/paths";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-paths-"))); }

describe("resolveWithinAny", () => {
  test("allows a path inside any of the roots", () => {
    const a = realDir(); const b = realDir();
    writeFileSync(join(a, "x.txt"), ""); writeFileSync(join(b, "y.txt"), "");
    expect(resolveWithinAny([a, b], join(a, "x.txt"))).toBe(join(a, "x.txt"));
    expect(resolveWithinAny([a, b], join(b, "y.txt"))).toBe(join(b, "y.txt"));
    expect(resolveWithinAny([a, b], "x.txt")).toBe(join(a, "x.txt")); // relative → roots[0]
  });

  test("rejects a path outside every root", () => {
    const a = realDir(); const outside = realDir();
    expect(() => resolveWithinAny([a], join(outside, "z.txt"))).toThrow(/outside the allowed directories/);
    expect(() => resolveWithinAny([a], "/etc/passwd")).toThrow(/outside the allowed directories/);
  });

  test("prefix-collision roots are not confused (/tmp/foo vs /tmp/foobar)", () => {
    const base = realDir();
    mkdirSync(join(base, "foo")); mkdirSync(join(base, "foobar"));
    const foo = join(base, "foo");
    expect(() => resolveWithinAny([foo], join(base, "foobar", "f.txt"))).toThrow(/outside/);
  });

  test("resolveWithin remains a single-root wrapper", () => {
    const a = realDir();
    expect(resolveWithin(a, "q.txt")).toBe(join(a, "q.txt"));
    expect(() => resolveWithin(a, "/etc/hosts")).toThrow(/outside/);
  });
});
