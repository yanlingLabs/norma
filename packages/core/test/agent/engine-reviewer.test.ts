import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import type { HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { setupEngine } from "./engine-steer.test";

// A stub bash tool (NOT the real sandboxed one): records every invocation to `calls` so tests
// can assert whether bash actually ran, without depending on macOS sandbox-exec.
function stubRegistry(): { registry: ToolRegistry; calls: Array<{ command: string; justification?: string }> } {
  const registry = new ToolRegistry();
  const calls: Array<{ command: string; justification?: string }> = [];
  registry.register({
    name: "bash",
    description: "stub bash",
    args: z.object({ command: z.string(), justification: z.string().optional() }),
    run({ command, justification }) {
      calls.push({ command, justification });
      return `ran: ${command}`;
    },
  });
  return { registry, calls };
}

// One round: model calls bash(command[, justification]) then stops with tool_calls; round 2 ends the turn.
function bashTurn(command: string, justification?: string): ProviderEvent[][] {
  const args: Record<string, string> = { command };
  if (justification !== undefined) args.justification = justification;
  return [
    [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

function types(events: SessionEvent[]): string[] { return events.map((e) => e.type); }

// Stub reviewer: scripted verdict/throw, records every input it was asked to review.
function stubReviewer(behavior: { verdict: "safe" | "unsafe"; reason: string } | "throw") {
  const seen: Array<{ command: string; justification?: string }> = [];
  return {
    seen,
    review: async (input: { command: string; justification?: string }) => {
      seen.push(input);
      if (behavior === "throw") throw new Error("reviewer boom");
      return behavior;
    },
  };
}

describe("engine + safety reviewer (auto-policy bash)", () => {
  test("unsafe verdict escalates: approval_requested (summary has reason), deny → tool_result has reason + retry hint, bash did NOT run, reviewer saw {command, justification}", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL" });
    const provider = new FakeProvider(bashTurn("rm -rf x", "cleaning up JUST_SENTINEL"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(types(events)).toEqual(expect.arrayContaining(["approval_requested", "approval_resolved", "tool_result"]));
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.summary).toContain("REASON_SENTINEL");

    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("REASON_SENTINEL");
    expect(result.output.toLowerCase()).toContain("justification");

    expect(calls.length).toBe(0); // bash did NOT run
    expect(reviewer.seen).toEqual([{ command: "rm -rf x", justification: "cleaning up JUST_SENTINEL" }]);
  });

  test("escalation timeout is read from NORMA_REVIEW_APPROVAL_TIMEOUT_MS (60s default), independent of the ask-path approvalTimeoutMs", async () => {
    const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
    process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30"; // short override so the test doesn't wait 60s
    try {
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_TIMEOUT" });
      const provider = new FakeProvider(bashTurn("rm -rf x"));
      // No watcher — nobody resolves the approval, so it must time out on its own via the broker.
      const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

      const started = Date.now();
      await engine.runTurn(sessionId);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2000); // nowhere near the 5-min ask-path default or the 60s reviewer default
      const events = store.read(sessionId);
      expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "timeout" });
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("REASON_TIMEOUT");
      expect(calls.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
    }
  });

  test("safe verdict → bash runs, no approval_requested", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "looks fine" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ command: "rm -rf x", justification: undefined }]);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false);
  });

  test("allowlisted `ls` → bash runs, reviewer.review NOT called, no approval", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("ls -la"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(reviewer.seen.length).toBe(0);
    expect(calls).toEqual([{ command: "ls -la", justification: undefined }]);
  });

  test("reviewer throws → escalates (approval_requested fires, summary notes manual approval)", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer("throw");
    const provider = new FakeProvider(bashTurn("curl http://example.com"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.summary.toLowerCase()).toContain("manual approval");
    expect(calls.length).toBe(0);
  });

  test("ASK policy bash → reviewer NOT consulted; normal (non-reviewer) approval path runs", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask" });

    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.summary).not.toContain("safety reviewer");
    expect(calls.length).toBe(1); // approved → ran
  });

  test("reviewer disabled (reviewerEnabled:false) → bash runs directly, no review", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "should never be asked" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, reviewerEnabled: false });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("injection containment: after a denied review, the NEXT provider request input does NOT contain the reviewer's reason text", async () => {
    const { registry } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_SENTINEL_INJECT" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);

    await engine.runTurn(sessionId);

    // Round 1 (index 1) is the NEXT provider request after the bash tool_call/tool_result round.
    const round1 = provider.requests[1];
    expect(round1).toBeDefined();
    // The denial message DOES legitimately carry the reason (it's the bash tool_result output) —
    // but it must be there exactly once, via the tool_result item, never duplicated as a raw
    // reviewer-verdict push into the turn context.
    const toolResultItems = round1!.input.filter((i) => i.type === "tool_result");
    expect(toolResultItems.length).toBe(1);
    expect((toolResultItems[0] as any).output).toContain("REASON_SENTINEL_INJECT");
    // No OTHER input item (message/function_call) carries the raw reason:
    const nonToolResult = round1!.input.filter((i) => i.type !== "tool_result");
    for (const item of nonToolResult) {
      expect(JSON.stringify(item)).not.toContain("REASON_SENTINEL_INJECT");
    }
  });
});
