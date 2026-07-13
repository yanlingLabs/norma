import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { HubClient } from "../../src/sessions/hub";
import type { ProviderEvent } from "../../src/providers/types";
import { registerMemoryTools } from "../../src/agent/tools/memory";
import { MemoryStore } from "../../src/agent/memory";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { setup } from "./engine-spawn.test";

// Phase 5b Task 6: the closing e2e for the USER pin (design doc's "Status" 2026-07-08 sketch §5b,
// riden by gate.ts's MUTATING classification for memory_write/memory_delete): under `auto` policy
// a model-driven memory_write proceeds with NO approval card, only an audit line; under `ask` the
// SAME write rides the ordinary approval flow first (gate.ts does not special-case memory tools —
// this proves it end to end through the real engine, not just gate.ts's unit-level classification).
// Also proves the write→read loop closes across T1 (MemoryStore), T2 (tools), and the pre-existing
// 1c-i ContextAssembler recall path: a FRESH ContextAssembler (sharing only `normaHome` with the
// engine's own, never the same in-memory instance) sees the fact via MEMORY.md the moment the store
// commits it — recall never depends on anything the engine itself cached mid-session.
//
// Harness: bg-default-e2e.test.ts's own precedent — reuse engine-spawn.test.ts's `setup` (fake
// provider + real engine + registry), then register the tools under test directly onto that
// registry with a temp-home MemoryStore, exactly as bg-default-e2e registers agent-query tools
// onto the same shared registry after setup() returns.

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-mem-e2e-")));
}

type ToolResult = Extract<SessionEvent, { type: "tool_result" }>;

describe("auto-memory e2e (phase 5b Task 6)", () => {
  test("auto policy: memory_write lands with no approval card, audits source:'tool'; a fresh ContextAssembler recalls it via MEMORY.md; memory_read returns the body", async () => {
    const normaHome = realDir();
    const memory = new MemoryStore({ normaHome, trust: { isTrusted: () => true } });

    const { engine, sessionId, registry, cwd, events } = setup(
      [
        [{ type: "tool_call", callId: "w1", name: "memory_write", argsJson: JSON.stringify({ name: "coffee-pref", description: "Likes oat milk lattes", body: "User prefers oat milk lattes over regular." }) }, done("tool_calls")],
        text("saved it"), // turn 1's own wrap-up round
        [{ type: "tool_call", callId: "r1", name: "memory_read", argsJson: JSON.stringify({ name: "coffee-pref" }) }, done("tool_calls")],
        text("recalled it"), // turn 2's own wrap-up round
      ],
      { approvalPolicy: "auto" },
    );
    registerMemoryTools(registry, { memory, cwdOf: () => cwd });

    // turn 1: the model writes a user-scope fact.
    await engine.runTurn(sessionId);

    // THE PIN: no approval card anywhere in the stream under `auto` — a silent write.
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.some((e) => e.type === "approval_resolved")).toBe(false);

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
    expect(writeResult).toMatchObject({ isError: false, output: 'saved memory fact "coffee-pref" (user scope)' });

    // the audit line IS the record (no card to observe instead) — source:"tool", this session's id.
    const tail = memory.auditTail();
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ source: "tool", sessionId, action: "write", scope: "user", name: "coffee-pref" });

    // A brand-new ContextAssembler instance (own TrustStore/SkillStore, never touched by the
    // engine's own assembler) sharing only `normaHome` — stands in for what a NEW session's system
    // prompt would contain, proving the read side consumes the store-written index, not an
    // in-process cache.
    const freshTrust = new TrustStore(join(normaHome, "trust.json"));
    const freshAssembler = new ContextAssembler({ normaHome, trust: freshTrust, skills: new SkillStore({ normaHome, trust: freshTrust }) });
    const assembled = freshAssembler.assemble({ cwd: null });
    expect(assembled).toContain("### User memory");
    expect(assembled).toContain("- [coffee-pref](coffee-pref.md) — Likes oat milk lattes");

    // turn 2: the model reads the fact back — the full body comes through the tool result.
    await engine.runTurn(sessionId);
    const readResult = events.find((e) => e.type === "tool_result" && e.callId === "r1") as ToolResult;
    expect(readResult.isError).toBe(false);
    expect(readResult.output).toContain("coffee-pref (user)");
    expect(readResult.output).toContain("Likes oat milk lattes");
    expect(readResult.output).toContain("User prefers oat milk lattes over regular.");
  });

  test("ask policy: the same write rides the ordinary approval flow first (existing approval-flow idiom — engine-worktree.test.ts's approve variant), then lands and audits", async () => {
    const normaHome = realDir();
    const memory = new MemoryStore({ normaHome, trust: { isTrusted: () => true } });

    const { engine, sessionId, registry, cwd, events, hub, broker } = setup(
      [
        [{ type: "tool_call", callId: "w1", name: "memory_write", argsJson: JSON.stringify({ name: "coffee-pref", description: "Likes oat milk lattes", body: "User prefers oat milk lattes over regular." }) }, done("tool_calls")],
        text("saved it"),
      ],
      { approvalPolicy: "ask" },
    );
    registerMemoryTools(registry, { memory, cwdOf: () => cwd });

    // watcher approves the card as soon as it sees it (must attach before runTurn — same ordering
    // constraint as engine.test.ts/engine-worktree.test.ts's own approval watchers).
    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);

    // THE CONTRAST: under `ask`, the exact same write is carded first...
    expect(events.find((e) => e.type === "approval_requested")).toBeDefined();
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: true, by: "auto-approver" });
    // ...and only THEN lands, same as the auto case.
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1") as ToolResult;
    expect(writeResult).toMatchObject({ isError: false, output: 'saved memory fact "coffee-pref" (user scope)' });

    const tail = memory.auditTail();
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ source: "tool", sessionId, action: "write", scope: "user", name: "coffee-pref" });
  });
});
