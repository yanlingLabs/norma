import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { ProviderEvent } from "../../src/providers/types";
import { LspManager } from "../../src/agent/lsp/manager";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setup } from "./engine-spawn.test";

// lsp-consolidation T3 (design doc `2026-07-15-lsp-consolidation-design.md` §2): the ENGINE-level
// closing proof — the diagnostics block auto-diagnostics.test.ts unit-tests in isolation is
// actually part of the SAME model-visible tool_result a write/edit call produces through the real
// engine dispatch loop (executeCall), survives into the NEXT round's provider request (not just
// something that landed in the session store), applies to a spawned CHILD thread's own write call
// too (CC parity: "after each file edit" is universal, not main-thread-only), and respects every
// hot gate (lsp.enabled via cfg.lsp's live getter, lsp.autoDiagnostics via cfg.autoDiagnosticsEnabled)
// with zero daemon/engine reconstruction. Harness: engine-spawn.test.ts's own `setup` (same reuse
// precedent lsp-e2e.test.ts already established), extended (this task) with `lsp`/
// `autoDiagnosticsEnabled` opts.

const isMac = process.platform === "darwin";
const FIXTURE = join(import.meta.dir, "lsp/fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const writeCall = (callId: string, path: string, content: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "write", argsJson: JSON.stringify({ path, content }) });
const editCall = (callId: string, path: string, old_string: string, new_string: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "edit", argsJson: JSON.stringify({ path, old_string, new_string }) });
const spawnCall = (callId: string, prompt: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "test task", run_in_background: false }) });

// Same pattern as lsp-e2e.test.ts's own withEnv: awaits `fn` before restoring, since a full
// engine.runTurn crosses many real microtask turns before the tool's run()/clientFor() ever fires.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

type ToolResult = Extract<SessionEvent, { type: "tool_result" }>;

describe.if(isMac)("engine: auto-diagnostics after edit (lsp-consolidation T3)", () => {
  test("write with a diagnostics-producing fake server -> tool_result gets the block APPENDED, errors first, and it survives to round 2's model-visible request", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    const { engine, sessionId, events, provider } = setup(
      [
        [writeCall("w1", "app.ts", "let x = 1;\n"), done("tool_calls")],
        text("fixed it"),
      ],
      { lsp, autoDiagnosticsEnabled: () => true },
    );
    const diags = [
      { range: { start: { line: 3, character: 1 } }, severity: 2, message: "unused var", source: "tsserver" },
      { range: { start: { line: 0, character: 4 } }, severity: 1, message: "type mismatch", source: "tsserver" },
    ];
    try {
      await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () => engine.runTurn(sessionId));

      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
      expect(toolResult.isError).toBe(false);
      expect(toolResult.output).toBe(
        "wrote 11 bytes to app.ts\n\n" +
        "diagnostics (1 errors, 1 warnings):\n" +
        "app.ts:1:5 error type mismatch\n" +
        "app.ts:4:2 warn unused var",
      );

      // THE beat: the SAME text (write result + appended diagnostics) is exactly what round 2's
      // REQUEST carries as the tool_result item — proves it rode the engine's dispatch loop back
      // into TurnRequest.input, not just something that landed in the session store.
      const round2Input = (provider as FakeProvider).requests[1]!.input;
      expect(round2Input).toContainEqual({ type: "tool_result", callId: "w1", output: toolResult.output, isError: false });
    } finally {
      await lsp.stopAll();
    }
  });

  test("clean file (zero diagnostics) -> tool_result is the plain write message, nothing appended", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    const { engine, sessionId, events } = setup(
      [[writeCall("w1", "clean.ts", "const x = 1;\n"), done("tool_calls")], text("done")],
      { lsp, autoDiagnosticsEnabled: () => true },
    );
    try {
      await withEnv({ NORMA_LSP_FAKE_DIAGS: "[]" }, () => engine.runTurn(sessionId));
      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
      expect(toolResult.output).toBe("wrote 13 bytes to clean.ts");
    } finally {
      await lsp.stopAll();
    }
  });

  test("lsp not wired (mirrors lsp.enabled: false) -> tool_result unaffected", async () => {
    const { engine, sessionId, events } = setup(
      [[writeCall("w1", "app.ts", "let x = 1;\n"), done("tool_calls")], text("done")],
      {}, // no `lsp` opt at all — cfg.lsp is absent, same as daemon.ts's lspManager staying null
    );
    await engine.runTurn(sessionId);
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
    expect(toolResult.output).toBe("wrote 11 bytes to app.ts");
  });

  test("autoDiagnostics off while lsp IS wired -> tool_result unaffected (the two gates are independent)", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    const spy = spyOn(lsp, "clientFor");
    const { engine, sessionId, events } = setup(
      [[writeCall("w1", "app.ts", "let x = 1;\n"), done("tool_calls")], text("done")],
      { lsp, autoDiagnosticsEnabled: () => false },
    );
    try {
      await engine.runTurn(sessionId);
      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
      expect(toolResult.output).toBe("wrote 11 bytes to app.ts");
      expect(spy).not.toHaveBeenCalled(); // the gate short-circuits BEFORE ever touching the manager
    } finally {
      spy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("unmatched extension (no configured language server) -> tool_result unaffected, manager never touched", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    const spy = spyOn(lsp, "clientFor");
    const { engine, sessionId, events } = setup(
      [[writeCall("w1", "notes.md", "# hello\n"), done("tool_calls")], text("done")],
      { lsp, autoDiagnosticsEnabled: () => true },
    );
    try {
      await engine.runTurn(sessionId);
      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
      expect(toolResult.output).toBe("wrote 8 bytes to notes.md");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("server timeout/crash (client.diagnostics rejects) -> never-fail: tool_result unaffected", async () => {
    // Duck-typed double (cast, no real process) — same "any thrown error is equally never-fail"
    // posture as auto-diagnostics.test.ts's own timeoutLsp; a REAL 8s typescript DIAG_TUNING
    // timeout would be honest but needlessly slow this suite for no extra coverage.
    const timeoutLsp = {
      clientFor: async () => ({ diagnostics: async () => { throw new Error("diagnostics timed out"); } }),
    } as unknown as LspManager;
    const { engine, sessionId, events } = setup(
      [[writeCall("w1", "app.ts", "let x = 1;\n"), done("tool_calls")], text("done")],
      { lsp: timeoutLsp, autoDiagnosticsEnabled: () => true },
    );
    await engine.runTurn(sessionId);
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe("wrote 11 bytes to app.ts");
  });

  test("failed write (old_string not found) -> NO diagnostics run at all, manager never touched", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    const spy = spyOn(lsp, "clientFor");
    const { engine, sessionId, cwd, events } = setup(
      [[editCall("e1", "app.ts", "nonexistent-string", "y"), done("tool_calls")], text("noted")],
      { lsp, autoDiagnosticsEnabled: () => true },
    );
    writeFileSync(join(cwd, "app.ts"), "let x = 1;\n");
    try {
      await engine.runTurn(sessionId);
      const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "e1") as ToolResult;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.output).toBe("old_string not found in app.ts");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await lsp.stopAll();
    }
  });

  test("hot toggle: autoDiagnosticsEnabled flips LIVE between two edits in the same session, no engine reconstruction", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    let flag = false; // read live via a closure, exactly like daemon.ts's own settings-backed getter
    const { engine, sessionId, events } = setup(
      [
        [writeCall("w1", "a.ts", "let a = 1;\n"), done("tool_calls")],
        text("first"),
        [writeCall("w2", "b.ts", "let b = 1;\n"), done("tool_calls")],
        text("second"),
      ],
      { lsp, autoDiagnosticsEnabled: () => flag },
    );
    const diags = [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" }];
    try {
      await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () => engine.runTurn(sessionId));
      const first = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
      expect(first.output).toBe("wrote 11 bytes to a.ts"); // flag was false: nothing appended

      flag = true; // flip LIVE, same running engine/session — no rebuild
      await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () => engine.runTurn(sessionId));
      const second = events.find((e) => e.type === "tool_result" && e.callId === "w2") as ToolResult;
      expect(second.output).toBe("wrote 11 bytes to b.ts\n\ndiagnostics (1 errors, 0 warnings):\nb.ts:1:1 error boom");
    } finally {
      await lsp.stopAll();
    }
  });

  test("subagent (child thread): the SAME hook fires for a spawned child's own write call — CC parity is universal, not main-thread-only", async () => {
    const lsp = new LspManager({ serverCommands: { typescript: FAKE } });
    const { engine, sessionId, events } = setup(
      [
        [spawnCall("s1", "write a file"), done("tool_calls")], // parent round 0: spawn
        [writeCall("w1", "child.ts", "let x = 1;\n"), done("tool_calls")], // child round 0: write
        text("child wrote it"), // child round 1: ends the child's turn (and, clamped, the parent's continuation too)
      ],
      { lsp, autoDiagnosticsEnabled: () => true },
    );
    const diags = [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "child-thread error" }];
    try {
      await withEnv({ NORMA_LSP_FAKE_DIAGS: JSON.stringify(diags) }, () => engine.runTurn(sessionId));
      const started = events.find((e) => e.type === "thread_started");
      expect(started).toBeTruthy();
      const childToolResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
      expect(childToolResult.output).toBe(
        "wrote 11 bytes to child.ts\n\ndiagnostics (1 errors, 0 warnings):\nchild.ts:1:1 error child-thread error",
      );
    } finally {
      await lsp.stopAll();
    }
  });
});
