import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { sessionTmpDir } from "../../src/agent/session-tmp";

describe("sessionTmpDir", () => {
  test("creates a stable realpath'd dir per session id", () => {
    const a = sessionTmpDir("s_abc");
    const a2 = sessionTmpDir("s_abc");
    const b = sessionTmpDir("s_def");
    expect(existsSync(a)).toBe(true);
    expect(a).toBe(a2);          // stable
    expect(a).toBe(realpathSync(a)); // canonical
    expect(a).not.toBe(b);
  });

  test("rejects a sessionId with path-traversal characters", () => {
    expect(() => sessionTmpDir("a/../../etc-poc")).toThrow(/invalid sessionId/);
    expect(() => sessionTmpDir("../evil")).toThrow(/invalid sessionId/);
    expect(() => sessionTmpDir("s_ok123")).not.toThrow(); // real session-id shape passes
  });
});
