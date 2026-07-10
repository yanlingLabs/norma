import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/agent/tools/registry";
import type { ToolContext } from "../../src/agent/tools/registry";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/", roots: ["/"], sessionId: "s", ...overrides };
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerAskUserTool(r);
  return r;
}

const Q = (over: Record<string, unknown> = {}) => ({
  question: "Pick one",
  header: "Pick",
  options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }],
  multiSelect: false,
  ...over,
});

describe("ask_user tool", () => {
  test("zod bounds: 0 and 5 questions, 1 and 5 options, 13-char header all rejected", async () => {
    const r = buildRegistry();
    const badArgs = [
      { questions: [] },
      { questions: Array(5).fill(Q()) },
      { questions: [Q({ options: [{ label: "A" }] })] },
      { questions: [Q({ options: Array(5).fill({ label: "x" }) })] },
      { questions: [Q({ header: "ThirteenChars!" })] },
    ];
    for (const bad of badArgs) {
      const out = await r.execute("ask_user", bad, ctx());
      expect(out.isError).toBe(true);
    }
  });

  // 4g-ii (CC parity): option description is now REQUIRED — a label without one is invalid args,
  // distinct from the count-bounds cases above (this option list is otherwise well-formed).
  test("option missing description → invalid args", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ options: [{ label: "A", description: "Option A" }, { label: "B" }] })] },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(out.output).toContain("description");
  });

  test("formats answers by header, keyed by question text", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ answers: { "Pick one": "B" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Pick: B");
  });

  test("multiSelect + missing answers render", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      {
        questions: [
          Q({ question: "Q1", header: "First", options: [{ label: "A", description: "Option A" }, { label: "C", description: "Option C" }], multiSelect: true }),
          Q({ question: "Q2", header: "Second" }),
        ],
      },
      ctx({ ask: async () => ({ answers: { Q1: "A, C" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("First: A, C");
    expect(out.output).toContain("Second: (no answer)");
  });

  test("timeout → non-error proceed message", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ timedOut: true }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Proceed with your best judgment");
  });

  test("no ctx.ask → immediate proceed message", async () => {
    const r = buildRegistry();
    const out = await r.execute("ask_user", { questions: [Q()] }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Proceed with your best judgment");
  });

  // CC AskUserQuestion parity (Task 2): option preview, single-select only.
  test("option preview accepted on a single-select question", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ options: [{ label: "A", description: "Option A", preview: "diff A" }, { label: "B", description: "Option B" }] })] },
      ctx({ ask: async () => ({ answers: { "Pick one": "A" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Pick: A");
  });

  test("option preview + multiSelect:true → invalid args", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q({ multiSelect: true, options: [{ label: "A", description: "Option A", preview: "diff A" }, { label: "B", description: "Option B" }] })] },
      ctx(),
    );
    expect(out.isError).toBe(true);
  });

  test("ask outcome with notes → tool result includes the note text verbatim", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ answers: { "Pick one": "B" }, notes: { "Pick one": "prefer B for perf" }, by: "cli" }) }),
    );
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Pick: B");
    expect(out.output).toContain('[user note on "Pick one": prefer B for perf]');
  });

  // (d) no-preview/no-notes path unchanged — locks the exact byte shape of the pre-existing
  // "formats answers by header" output so the notes-folding addition never perturbs it.
  test("no-notes path is byte-identical to the pre-notes output", async () => {
    const r = buildRegistry();
    const out = await r.execute(
      "ask_user",
      { questions: [Q()] },
      ctx({ ask: async () => ({ answers: { "Pick one": "B" }, by: "cli" }) }),
    );
    expect(out.output).toBe("User answered:\n- Pick: B");
  });
});
