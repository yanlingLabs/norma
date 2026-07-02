import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDirectories } from "../../src/agent/dirs";

function realDir() { return realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-"))); }

describe("SessionDirectories", () => {
  test("roots = base + runtime-added, deduped/realpath'd", () => {
    const cwd = realDir(); const extra = realDir(); const added = realDir();
    const sd = new SessionDirectories(() => [cwd, extra]);
    expect(sd.roots("s1").sort()).toEqual([cwd, extra].sort());
    sd.add("s1", added);
    expect(sd.roots("s1")).toContain(added);
    expect(sd.has("s1", added)).toBe(true);
    // per-session isolation:
    expect(sd.roots("s2")).not.toContain(added);
    // dedup:
    sd.add("s1", extra);
    expect(sd.roots("s1").filter((r) => r === extra)).toHaveLength(1);
  });
});
