import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { HubClient } from "../../src/sessions/hub";
import type { ProviderEvent } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, stubReviewer, bashTurn, writeTurn } from "./engine-reviewer.test";

// Phase 5e Task 6: the closing e2e for reviewer maturity (T1 protocol, T2 emission, T3 fs/external
// coverage, T4 settings, T5 cards) — drives the REAL engine + a scripted reviewer end to end for
// the three beats the brief binds:
//  1. unsafe bash under auto: tool_review + reviewerReason persist on the wire, while the ONE
//     deliberate reviewer->model channel (the timeout denial's tool_result text — see events.ts's
//     own ToolReviewEvent doc comment) is byte-pinned and every OTHER reviewer-derived field is
//     proven absent from what the model is fed next, both within the same turn and across a
//     genuinely new turn's historyInput replay.
//  2. safe fs-unusual write under auto: reviewed, but silent — no card, the write proceeds.
//  3. replay parity, extended from engine-history.test.ts test (g)'s bash-only pin to the fs/
//     external classes T3 added (eventToInput's fallthrough is type-based, not name-based, but this
//     closes the loop explicitly rather than leaving it inferred).
//
// Harness: engine-reviewer.test.ts's own stubRegistry/stubReviewer/bashTurn/writeTurn + engine-
// steer.test.ts's setupEngine — the SAME fake-provider/real-engine idiom every reviewer test in
// this branch already uses, reused here (not re-derived) for the full-loop assembly.

describe("reviewer maturity e2e (phase 5e T6)", () => {
  describe("beat 1: unsafe bash under auto — byte-pinned reviewer channel + containment", () => {
    test("timeout denial: tool_review + reviewerReason persist, denial text byte-matches today's template, and no OTHER reviewer content reaches the model — same-turn round AND a genuinely new turn", async () => {
      const prev = process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
      // Short timeout, no watcher attached: the broker denies via timeout, NOT a human click — this
      // is the one path where the reviewer's own reason legitimately reaches the tool_result (see
      // requestApproval's doc comment: an explicit human deny uses a wholly generic message
      // instead, ignoring opts.denialMessage — pinned separately below so the two paths aren't
      // conflated).
      process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = "30";
      try {
        const { registry, calls } = stubRegistry();
        const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_E2E_SENTINEL" });
        const provider = new FakeProvider([
          ...bashTurn("rm -rf x"),
          [{ type: "text_delta", delta: "turn2 ack" }, { type: "done", stopReason: "end_turn" }] as ProviderEvent[],
        ]);
        const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });

        await engine.runTurn(sessionId);
        const events = store.read(sessionId);

        const review = events.find((e) => e.type === "tool_review") as any;
        expect(review).toMatchObject({ toolName: "bash", verdict: "unsafe", reason: "REASON_E2E_SENTINEL" });
        const requested = events.find((e) => e.type === "approval_requested") as any;
        expect(requested.reviewerReason).toBe("REASON_E2E_SENTINEL");
        expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "timeout" });

        const denyResult = events.find((e) => e.type === "tool_result") as any;
        // THE byte-pinned template — exact match (not toContain), so any accidental reshaping or
        // sanitization of this specific reviewer->model channel fails loudly, not silently. The
        // seconds figure is derived from this test's own 30ms override (whole-branch fix wave —
        // reviewAndDispatch no longer hardcodes "60s" regardless of the actual window used; see
        // its own doc comment), rounding to 0s here.
        expect(denyResult.output).toBe(
          'blocked by the safety reviewer: REASON_E2E_SENTINEL. No approval within 0s. If this command is genuinely necessary, call bash again with a "justification" explaining why — the reviewer will reconsider.',
        );
        expect(calls.length).toBe(0); // bash never ran

        // CONTAINMENT, same turn: round 1 ("turn2 ack") is the NEXT provider request in THIS turn.
        // The reason legitimately rides the tool_result item (denyResult.output, above) — nowhere else.
        const round1 = provider.requests[1]!.input;
        expect(round1.filter((i) => i.type === "tool_result").length).toBe(1);
        for (const item of round1) {
          if (item.type === "tool_result") continue;
          expect(JSON.stringify(item)).not.toContain("REASON_E2E_SENTINEL");
        }

        // CONTAINMENT, next TURN: a genuinely new user message starts a second turn — historyInput
        // rebuilds from the PERSISTED store (not anything the first turn cached in memory), so this
        // exercises the real cross-turn replay path (eventToInput's fallthrough), not a hand-built one.
        store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "what happened?", clientName: "test" });
        await engine.runTurn(sessionId);
        const round2 = provider.requests[2]!.input;
        const occurrences = round2.filter((i) => JSON.stringify(i).includes("REASON_E2E_SENTINEL"));
        // Exactly once, total — the replayed tool_result — never via a resurrected tool_review or
        // approval_requested/resolved item (those events contribute nothing to replay at all).
        expect(occurrences.length).toBe(1);
        expect(occurrences[0]!.type).toBe("tool_result");
      } finally {
        if (prev === undefined) delete process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS;
        else process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS = prev;
      }
    });

    test("explicit watcher deny (not a timeout): the human-deny template carries NO reviewer text at all — the disambiguation the sibling test above depends on", async () => {
      const { registry, calls } = stubRegistry();
      const reviewer = stubReviewer({ verdict: "unsafe", reason: "SHOULD_NEVER_LEAK" });
      const provider = new FakeProvider(bashTurn("rm -rf x"));
      const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });
      const watcher: HubClient = {
        clientName: "auto-denier",
        deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
      };
      hub.attach(watcher, sessionId, 0);

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      // The wire event still carries reviewerReason (clients render it) — but the tool_result the
      // MODEL sees is a wholly generic, byte-exact template that never echoes it (deniedByHuman
      // ignores opts.denialMessage entirely — see requestApproval's own doc comment on why a
      // retry-hint is withheld from a real human deny, not just a reviewer timeout).
      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested.reviewerReason).toBe("SHOULD_NEVER_LEAK");
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.output).toBe(
        "The user denied this bash action — it was NOT run. Stop here and wait for the user to tell you how to proceed. Do not retry it, rephrase it, or attempt a workaround; the user will give further instructions.",
      );
      expect(result.output).not.toContain("SHOULD_NEVER_LEAK");
      expect(calls.length).toBe(0);
    });
  });

  describe("beat 2: safe fs-unusual write under auto — reviewed but silent", () => {
    test("dotfile write in cwd: tool_review(safe) persists, write proceeds, no approval card at all", async () => {
      const reviewer = stubReviewer({ verdict: "safe", reason: "dotfile write looks fine" });
      const provider = new FakeProvider(writeTurn(".env", "SECRET=1"));
      const { engine, store, sessionId, cwd } = setupEngine(provider, { reviewer: reviewer as any });

      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      const review = events.find((e) => e.type === "tool_review") as any;
      expect(review).toMatchObject({ toolName: "write", verdict: "safe" });
      // "no card" is TWO events, not one — a resolved-without-a-request would be nonsensical, but
      // both are asserted absent so a future refactor can't emit one without the other unnoticed.
      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      expect(events.some((e) => e.type === "approval_resolved")).toBe(false);
      expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("SECRET=1");
    });
  });

  // Extends engine-history.test.ts test (g) — which already proves tool_review is invisible to
  // historyInput for bash — to the fs/edit/external toolNames T3 introduced. eventToInput's
  // fallthrough is type-based, not name-based, so this is a closure proof, not a new code path;
  // included explicitly per the brief rather than left inferred.
  describe("beat 3: replay parity — fs/external tool_review shapes are equally invisible to historyInput", () => {
    test("a history with one tool_review per class (fs write, fs edit, external) replays byte-identically to the same history without them", async () => {
      const okProvider = () => new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" as const }]]);

      const withReviews = okProvider();
      {
        const { engine, store, sessionId } = setupEngine(withReviews);
        store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
        store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a1" });
        // Précis-shaped summaries (fsWritePrecis/externalPrecis's own "<name> <target> (<n> chars)"
        // / "<name> <argsJson>" shapes), not arbitrary strings — this pin tracks the real payload.
        store.append(sessionId, { type: "tool_review", sessionId, threadId: "main", toolName: "write", verdict: "safe", reason: "fine", summary: "write /tmp/x/.env (9 chars)" });
        store.append(sessionId, { type: "tool_review", sessionId, threadId: "main", toolName: "edit", verdict: "unsafe", reason: "risky edit", summary: "edit /tmp/x/.ssh/config (5 chars)" });
        store.append(sessionId, { type: "tool_review", sessionId, threadId: "main", toolName: "mcp__test__thing", verdict: "error", reason: "reviewer unavailable — manual approval required", summary: 'mcp__test__thing {"action":"delete_all"}' });
        store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });

        await engine.runTurn(sessionId);
      }

      const withoutReviews = okProvider();
      {
        const { engine, store, sessionId } = setupEngine(withoutReviews);
        store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u1", clientName: "test" });
        store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a1" });
        store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "u2", clientName: "test" });

        await engine.runTurn(sessionId);
      }

      // THE pin: the two independently-built sessions' reconstructed inputs are byte-identical —
      // not just each matching a hand-typed literal separately (belt-and-braces below).
      expect(withReviews.requests[0]!.input).toEqual(withoutReviews.requests[0]!.input);
      expect(withReviews.requests[0]!.input).toEqual([
        { type: "message", role: "user", content: "u1" },
        { type: "message", role: "assistant", content: "a1" },
        { type: "message", role: "user", content: "u2" },
      ]);
    });
  });
});
