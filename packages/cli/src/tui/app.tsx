/** `<App>` (Phase 3a Task 6; re-laid-out Phase 3b Task 7) — the assembled Ink TUI. It folds the
 *  client's event stream (via the `EventBridge`) through the pure `reduce` reducer into one
 *  `TuiState`, renders the Claude-Code transcript grammar + turn chrome, and wires the
 *  composer/card callbacks back to the client (send/steer/interrupt/setPolicy/approval/ask/plan).
 *
 *  CC LAYOUT (Task 7), top to bottom:
 *    <CommittedTranscript>  — the <Static> scrollback. Its FIRST item is the welcome banner (passed
 *                             as `header`), so the banner lands once at the top and never re-emits.
 *                             ALWAYS MOUNTED (never remounted / never conditionally unmounted) so the
 *                             Static flush pointer survives a pager toggle (HARD CONSTRAINT 2).
 *    then, when the pager is CLOSED:
 *      <ActiveTurn>         — streaming assistant text + in-flight tool lines (nowMs → blinking dot).
 *      <Spinner>            — animated in-progress indicator (verbs/elapsed/tokens).
 *      [<TaskList>]         — shown only while `tasksVisible` (ctrl+t toggles it).
 *      <PendingCards|Composer> — the card takes over input when `state.pending` is set.
 *      [<AgentList>]        — the subagent tree rows, only while any agent is live.
 *      <Footer>             — policy/interrupt/agents hint line.
 *    when the pager is OPEN (ctrl+o): the <Pager> renders in place of that whole block, as a SIBLING
 *      of the still-mounted <CommittedTranscript>, on the terminal's alternate screen buffer.
 *
 *  KEY ROUTING: a single App-level `useInput` (active while `!state.pending`) owns ctrl+o (pager
 *  toggle), ctrl+t (task view toggle), and — WHILE THE PAGER IS OPEN — the pager's ↑/↓ · PgUp/PgDn ·
 *  esc navigation, swallowing everything else. The composer is `disabled` (its listener detached)
 *  whenever a card or the pager owns input, so exactly one live consumer sees each keystroke.
 *
 *  Clock discipline unchanged from 3a: the reducer is fed an INJECTED clock (`now()` at event time);
 *  a ~100ms `setInterval` ticks `nowMs` in state for live chrome; `reduce` itself never calls
 *  Date.now. Policy cycle keeps the one-RPC-in-flight guard; idle-Esc stays inert. */

import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { METHODS, type ApprovalPolicy, type SessionEvent } from "@norma/protocol";
import { initialState, reduce, type TuiState } from "./state";
import { CommittedTranscript, settledCount } from "./transcript";
import { ActiveTurn } from "./active-turn";
import { Spinner } from "./spinner";
import { TaskList } from "./task-list";
import { AgentList } from "./agent-list";
import { Footer } from "./footer";
import { Composer } from "./composer";
import { PendingCards, type AnswerPayload } from "./pending-cards";
import { Pager, pagerLines, pagerWindowRows } from "./pager";
import { enterAltScreen, leaveAltScreen } from "./alt-screen";
import { theme } from "./theme";
import { loadSafeHighlighter } from "./highlight-guard";
import type { Highlighter } from "./markdown";
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
  /** Welcome-banner data (main.ts threads these through mountTui). */
  version: string;
  model: string;
  /** Injectable clock (tests). Defaults to Date.now — this is the ONLY place Date.now enters; it is
   *  passed to `reduce` strictly as the injected `nowMs`, keeping the reducer pure. */
  now?: () => number;
  /** Injectable raw-stdout writer for the alt-screen enter/leave escapes (tests inject a sink so no
   *  real escape bytes reach the test terminal). Production writes straight to `process.stdout`. */
  write?: (s: string) => void;
}

const POLICY_ORDER: ApprovalPolicy[] = ["ask", "auto", "plan"];

/** The welcome banner: bold-accent `Norma` + dim version, then a dim `model · cwd` line. Rendered as
 *  the FIRST <Static> item (via CommittedTranscript's `header`) so it paints once at the top. */
function Welcome({ version, model, cwd }: { version: string; model: string; cwd: string }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={theme.accent}>Norma</Text>
        <Text dimColor>{` v${version}`}</Text>
      </Text>
      <Text dimColor>{`${model} · ${cwd}`}</Text>
    </Box>
  );
}

export function App({ client, bridge, sessionId, cwd, initialPolicy, version, model, now = Date.now, write }: AppProps) {
  const writeOut = write ?? ((s: string) => { process.stdout.write(s); });
  const [state, dispatch] = useReducer(
    (s: TuiState, e: SessionEvent) => reduce(s, e, now()),
    undefined,
    initialState,
  );
  const [nowMs, setNowMs] = useState(() => now());
  const [policy, setPolicy] = useState<ApprovalPolicy>(initialPolicy);
  const policyInFlight = useRef(false);
  const [tasksVisible, setTasksVisible] = useState(false);
  const [highlight, setHighlight] = useState<Highlighter | undefined>(undefined);

  // ctrl+o pager state. `pagerRows` is the terminal height captured at OPEN time (fallback 24) — the
  // pager reserves rows off it so its total painted height stays strictly under it (see pager.tsx).
  // `staticCap` (fix B, whole-branch review) freezes <Static>'s item feed while the pager holds the
  // alternate screen buffer: items flushed there would be discarded by `\x1b[?1049l` on close while
  // Static's flush index still advanced — permanently missing from scrollback. Captured at open
  // (= the settled count Static has already painted), lifted in the SAME state update as every
  // close path so the held items flush into the restored normal buffer.
  const [pagerOpen, setPagerOpen] = useState(false);
  const [pagerOffset, setPagerOffset] = useState(0);
  const [pagerRows, setPagerRows] = useState(24);
  const [staticCap, setStaticCap] = useState<number | null>(null);

  // Subscribe to the bridge; flush its pre-subscribe (attach-replay) backlog then forward live.
  useEffect(() => bridge.subscribe(dispatch), [bridge]);

  // Ticking clock so elapsed/spinner chrome advances between real events (legacy 120ms tick twin).
  useEffect(() => {
    const id = setInterval(() => setNowMs(now()), 100);
    return () => clearInterval(id);
  }, [now]);

  // Load the code-fence syntax highlighter once (best-effort, stderr-suppressed — HARD CONSTRAINT 4)
  // and thread it into the committed transcript's markdown render. Async: until it resolves, code
  // fences render as plain text (identical to pre-load), then newly-committed blocks get highlighted.
  useEffect(() => {
    let live = true;
    void loadSafeHighlighter().then((hl) => { if (live) setHighlight(() => hl); });
    return () => { live = false; };
  }, []);

  // Fix A (whole-branch review): a pending card arriving while the pager is open would soft-lock the
  // session — this component's useInput goes inactive (isActive: !pending) and <PendingCards> only
  // mounts on the non-pager branch, leaving an un-closeable pager over an invisible card (and a
  // Ctrl+C exit would strand the terminal on the alternate buffer, never writing leaveAltScreen).
  // Auto-close instead: leave the alt screen and drop the pager + Static freeze-cap in one batched
  // update; the card then mounts normally with its own input. The leave escape is written
  // synchronously here and React repaints after the effect, so the escape still precedes the
  // restored (card-bearing) frame — HARD CONSTRAINT 3's ordering holds on this close path too.
  // Guarded re-entry: after the first run flips pagerOpen to false, re-runs are no-ops.
  useEffect(() => {
    if (!pagerOpen || !state.pending) return;
    setPagerOpen(false);
    setStaticCap(null);
    leaveAltScreen(writeOut);
  }, [pagerOpen, state.pending, writeOut]);

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

  // --- pager open/close (HARD CONSTRAINT 3: enter BEFORE showing, leave AFTER hiding, via
  // alt-screen.ts). The escape write is synchronous; the React state flip is deferred — so the
  // enter escape always precedes the pager's first frame and the leave escape always precedes the
  // restored non-pager frame, regardless of statement order. ---
  const openPager = () => {
    enterAltScreen(writeOut);
    setPagerRows(typeof process.stdout.rows === "number" ? process.stdout.rows : 24);
    setPagerOffset(0);
    // Freeze Static at exactly what it has already painted (this render's settled count — the
    // useInput closure and Static's flush index both come from the same last commit), fix B.
    setStaticCap(settledCount(state.committed));
    setPagerOpen(true);
  };
  const closePager = () => {
    setPagerOpen(false);
    setStaticCap(null); // lift the freeze in the SAME update — held items flush into the restored buffer
    leaveAltScreen(writeOut);
  };
  const scrollPager = (delta: number) => {
    setPagerOffset((o) => {
      const max = Math.max(0, pagerLines(state.committed).length - pagerWindowRows(pagerRows));
      return Math.min(max, Math.max(0, o + delta));
    });
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "o") {
        if (pagerOpen) closePager();
        else openPager();
        return;
      }
      if (pagerOpen) {
        // While the pager owns the screen it consumes all navigation; every other key is swallowed
        // so nothing leaks to (the disabled) composer or mutates hidden state.
        const pageStep = Math.max(1, pagerRows - 2);
        if (key.escape) { closePager(); return; }
        if (key.upArrow) { scrollPager(-1); return; }
        if (key.downArrow) { scrollPager(1); return; }
        if (key.pageUp) { scrollPager(-pageStep); return; }
        if (key.pageDown) { scrollPager(pageStep); return; }
        return;
      }
      if (key.ctrl && input === "t") { setTasksVisible((v) => !v); return; }
    },
    { isActive: !state.pending },
  );

  return (
    <Box flexDirection="column">
      <CommittedTranscript
        items={state.committed}
        header={<Welcome version={version} model={model} cwd={cwd} />}
        highlight={highlight}
        staticCap={staticCap}
      />
      {pagerOpen ? (
        <Pager blocks={state.committed} rows={pagerRows} offset={pagerOffset} />
      ) : (
        <>
          <ActiveTurn assistant={state.activeAssistant} tools={state.activeTools} nowMs={nowMs} />
          <Spinner
            running={state.turnRunning}
            turnStartMs={state.turnStartMs}
            nowMs={nowMs}
            outTokens={state.outTokens}
            tasks={state.tasks}
          />
          {tasksVisible ? <TaskList tasks={state.tasks} nowMs={nowMs} /> : null}
          {state.pending ? (
            <PendingCards pending={state.pending} onApprove={onApprove} onAnswer={onAnswer} onPlan={onPlan} />
          ) : (
            <Composer
              running={state.turnRunning}
              policy={policy}
              disabled={!!state.pending || pagerOpen}
              onSubmit={onSubmit}
              onSteer={onSteer}
              onInterrupt={onInterrupt}
              onCyclePolicy={onCyclePolicy}
            />
          )}
          {state.agents.length > 0 ? <AgentList agents={state.agents} nowMs={nowMs} /> : null}
          <Footer policy={policy} running={state.turnRunning} agents={state.agents} />
        </>
      )}
    </Box>
  );
}
