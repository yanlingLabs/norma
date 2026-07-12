/** `<App>` (Phase 3a Task 6) — the assembled Ink TUI: it folds the client's event stream (via the
 *  `EventBridge`) through the pure `reduce` reducer into one `TuiState`, renders the five
 *  presentational components + the composer/pending-card live region, and wires the composer/card
 *  callbacks back to the client (send/steer/interrupt/setPolicy/approval/ask/plan).
 *
 *  DESIGN (task brief §2-3):
 *   - State: `useReducer` seeded by `initialState()`; each event is reduced with an INJECTED clock
 *     (`now()` at event time — the pure reducer never calls Date.now itself). A separate ~100ms
 *     `setInterval` ticks `nowMs` in state so the live elapsed/spinner chrome advances between
 *     events; it is passed to the presentational components (NOT into `reduce`, which only needs the
 *     event-time clock for `turnStartMs`).
 *   - Events: subscribed in a `useEffect` via `bridge.subscribe(dispatch)`; the bridge flushes any
 *     pre-subscribe (attach-replay) backlog on subscribe, so nothing is lost between connect and
 *     mount. The effect returns the unsubscribe for clean unmount.
 *   - Live region: the pending card renders IN PLACE OF the composer (exactly one live `useInput` at
 *     a time). Layout order: Static transcript (above) → active turn → status → tasks →
 *     [composer | card] → agents.
 *   - Callbacks: `onInterrupt` is GATED on `turnRunning` (idle-Esc parity — legacy suspended its key
 *     listener during the idle readLine, so an idle Esc was inert; the composer now fires Esc
 *     unconditionally, so the no-op-when-idle decision lives here). Policy cycle mirrors main.ts's
 *     one-RPC-in-flight guard and only advances local state on RPC success. */

import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box } from "ink";
import { METHODS, type ApprovalPolicy, type SessionEvent } from "@norma/protocol";
import { initialState, reduce, type TuiState } from "./state";
import { CommittedTranscript } from "./transcript";
import { ActiveTurn } from "./active-turn";
import { StatusLine } from "./status-line";
import { TaskList } from "./task-list";
import { AgentList } from "./agent-list";
import { Composer } from "./composer";
import { PendingCards, type AnswerPayload } from "./pending-cards";
import type { EventBridge } from "./event-bridge";
import type { parsePlanResponse } from "../plan-response";

/** The subset of `NormaClient` `<App>` actually calls — declared structurally so tests can pass a
 *  fake that only records these callbacks (the real `NormaClient` satisfies it field-for-field). */
export interface AppClient {
  send(sessionId: string, text: string): unknown;
  steer(sessionId: string, text: string): unknown;
  interrupt(sessionId: string): unknown;
  setPolicy(sessionId: string, policy: ApprovalPolicy): unknown;
  askUserRespond(params: { sessionId: string; callId: string; answers: Record<string, string>; notes?: Record<string, string> }): unknown;
  planRespond(params: { sessionId: string; callId: string; approved: boolean; autoAccept?: boolean; feedback?: string }): unknown;
  request(method: string, params?: unknown): unknown;
}

export interface AppProps {
  client: AppClient;
  bridge: EventBridge;
  sessionId: string;
  cwd: string;
  initialPolicy: ApprovalPolicy;
  /** Injectable clock (tests). Defaults to Date.now — this is the ONLY place Date.now enters; it is
   *  passed to `reduce` strictly as the injected `nowMs`, keeping the reducer pure. */
  now?: () => number;
}

const POLICY_ORDER: ApprovalPolicy[] = ["ask", "auto", "plan"];

export function App({ client, bridge, sessionId, cwd, initialPolicy, now = Date.now }: AppProps) {
  void cwd; // reserved (cwd-scoped chrome is a Phase 3b concern); part of the mandated prop shape
  const [state, dispatch] = useReducer(
    (s: TuiState, e: SessionEvent) => reduce(s, e, now()),
    undefined,
    initialState,
  );
  const [nowMs, setNowMs] = useState(() => now());
  const [policy, setPolicy] = useState<ApprovalPolicy>(initialPolicy);
  const policyInFlight = useRef(false);

  // Subscribe to the bridge; flush its pre-subscribe (attach-replay) backlog then forward live.
  useEffect(() => bridge.subscribe(dispatch), [bridge]);

  // Ticking clock so elapsed/spinner chrome advances between real events (legacy 120ms tick twin).
  useEffect(() => {
    const id = setInterval(() => setNowMs(now()), 100);
    return () => clearInterval(id);
  }, [now]);

  const onSubmit = (text: string) => { void client.send(sessionId, text); };
  const onSteer = (text: string) => { void client.steer(sessionId, text); };
  // idle-Esc parity: no-op while nothing is running (legacy's idle readLine swallowed Esc).
  const onInterrupt = () => { if (state.turnRunning) void client.interrupt(sessionId); };
  const onCyclePolicy = () => {
    if (policyInFlight.current) return; // one setPolicy RPC at a time (repeat presses dropped)
    policyInFlight.current = true;
    const next = POLICY_ORDER[(POLICY_ORDER.indexOf(policy) + 1) % POLICY_ORDER.length]!;
    Promise.resolve(client.setPolicy(sessionId, next))
      .then(() => { setPolicy(next); }) // advance the bar only on success (mirror main.ts:392)
      .catch(() => { /* failure: leave the bar unchanged, same as legacy */ })
      .finally(() => { policyInFlight.current = false; });
  };
  const onApprove = (callId: string, yes: boolean) => {
    void client.request(METHODS.approvalRespond, { sessionId, callId, approved: yes });
  };
  const onAnswer = (callId: string, payload: AnswerPayload) => {
    void client.askUserRespond({
      sessionId, callId, answers: payload.answers,
      ...(payload.notes ? { notes: payload.notes } : {}),
    });
  };
  const onPlan = (callId: string, resp: ReturnType<typeof parsePlanResponse>) => {
    void client.planRespond({ sessionId, callId, ...resp });
  };

  return (
    <Box flexDirection="column">
      <CommittedTranscript items={state.committed} />
      <ActiveTurn assistant={state.activeAssistant} tools={state.activeTools} />
      <StatusLine
        running={state.turnRunning}
        turnStartMs={state.turnStartMs}
        inTokens={state.inTokens}
        outTokens={state.outTokens}
        nowMs={nowMs}
      />
      <TaskList tasks={state.tasks} nowMs={nowMs} />
      {state.pending ? (
        <PendingCards pending={state.pending} onApprove={onApprove} onAnswer={onAnswer} onPlan={onPlan} />
      ) : (
        <Composer
          running={state.turnRunning}
          policy={policy}
          disabled={false}
          onSubmit={onSubmit}
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onCyclePolicy={onCyclePolicy}
        />
      )}
      <AgentList agents={state.agents} nowMs={nowMs} />
    </Box>
  );
}
