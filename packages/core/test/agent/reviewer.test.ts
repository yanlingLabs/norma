import { describe, expect, test } from "bun:test";
import { bashLooksSafe, BashReviewer } from "../../src/agent/reviewer";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";

describe("bashLooksSafe", () => {
  test("read-only argv0, no metachars → bypass", () => {
    for (const c of ["ls -la", "pwd", "grep foo .", "cat README.md", "echo hi"]) expect(bashLooksSafe(c)).toBe(true);
  });
  test("git is NOT in the default safe set", () => {
    expect(bashLooksSafe("git status")).toBe(false);
  });
  test("any metachar forces review (no chaining bypass)", () => {
    for (const c of ["ls; rm -rf /", "cat x | sh", "echo $(whoami)", "echo `id`", "echo hi > f", "ls\nrm -rf ~", "a && b"])
      expect(bashLooksSafe(c)).toBe(false);
  });
  test("non-safe argv0 → review", () => {
    expect(bashLooksSafe("rm -rf x")).toBe(false);
    expect(bashLooksSafe("curl http://x")).toBe(false);
  });
  test("user allow list adds a command", () => {
    expect(bashLooksSafe("git status", ["git status"])).toBe(true);
    expect(bashLooksSafe("mytool", ["mytool"])).toBe(true);
  });
  test("command-runner / destructive argv0 are NOT bypassed (must be reviewed)", () => {
    expect(bashLooksSafe("env rm -rf .")).toBe(false);   // env defeats the allowlist
    expect(bashLooksSafe("env FOO=1 ls")).toBe(false);
    expect(bashLooksSafe("find . -delete")).toBe(false);
    expect(bashLooksSafe("find . -name x")).toBe(false);
  });
});

describe("BashReviewer", () => {
  // BashReviewer's ctor takes { provider: <the provider handle {provider, model}>, model?, timeoutMs? } —
  // same nested-handle convention as Compactor's deps.provider and EngineConfig.provider.
  const handle = (script: any) => ({ provider: { provider: new FakeProvider(script), model: "fake" } });
  const verdict = (v: string, reason: string): ProviderEvent[][] => [
    [{ type: "text_delta", delta: JSON.stringify({ verdict: v, reason }) }, { type: "done", stopReason: "end_turn" }],
  ];

  test("parses safe/unsafe verdicts", async () => {
    expect(await new BashReviewer(handle(verdict("safe", "benign")) as any).review({ command: "ls" })).toEqual({
      verdict: "safe",
      reason: "benign",
    });
    expect(
      await new BashReviewer(handle(verdict("unsafe", "recursive delete")) as any).review({ command: "rm -rf /" }),
    ).toEqual({ verdict: "unsafe", reason: "recursive delete" });
  });

  test("tools:[] and the justification reaches the provider input", async () => {
    const p = new FakeProvider(verdict("safe", "ok"));
    await new BashReviewer({ provider: { provider: p, model: "fake" } } as any).review({
      command: "rm x",
      justification: "cleaning a temp file JUSTIF_SENTINEL",
    });
    expect(p.requests[0]!.tools).toEqual([]);
    expect(JSON.stringify(p.requests[0]!.input)).toContain("JUSTIF_SENTINEL");
  });

  test("unparseable/empty output → throws", async () => {
    await expect(
      new BashReviewer(
        handle([[{ type: "text_delta", delta: "not json at all" }, { type: "done", stopReason: "end_turn" }]]) as any,
      ).review({ command: "ls" }),
    ).rejects.toThrow();
  });

  test("aborted → throws", async () => {
    const { AbortAwaitProvider } = await import("../../src/agent/test-providers");
    const ac = new AbortController();
    const p = new BashReviewer({ provider: { provider: new AbortAwaitProvider(), model: "fake" } } as any).review(
      { command: "ls" },
      ac.signal,
    );
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
