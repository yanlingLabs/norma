import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveNormaHome, KeychainSecretStore, startDaemon, TOKEN_NAMES } from "@norma/core";
import { METHODS, type ApprovalPolicy, type Task } from "@norma/protocol";
import { NormaClient } from "./client";
import { applyEvent, isStalled, type WatchdogState } from "./watchdog";
import { streamAction } from "./stream-state";
import { updateSubagents, type CliSubagent } from "./subagent-state";
import { decodeKey, footerKeyAction } from "./keys";
import {
  DIM,
  RESET,
  SPINNER_FRAMES,
  NONTTY_TASK_LINE,
  NONTTY_SPAWN_LINE,
  NONTTY_FINISH_LINE,
  agentFinishLines,
  agentSpawnLine,
  renderAgentsFooter,
  renderModeBar,
  renderStatusLine,
  renderTaskBlock,
  physicalRows,
  trackLineStart,
  truncateStatusLine,
  turnSummaryLine,
  upsertTask,
  type FooterSelection,
} from "./task-block";
import { installPlugin, removePluginDir, removePluginFromSettings, setPluginEnabled } from "./plugin-cli";
import { isOtherChoice, parseQuestionAnswer } from "./questions";
import { parsePlanResponse } from "./plan-response";

const AQUA = "\x1b[38;2;53;214;232m";

/** A raw-mode control-key listener (2e-iii-b Task 6) that owns stdin ONLY while a turn is running
 *  on a TTY (esc-interrupt, shift+tab policy cycle, ↑/↓/Enter footer selection — see §0/§4/§7).
 *  It yields cleanly to any COOKED-mode line reader (readLine/askYesNo, and the y/N approval read)
 *  via a suspend/resume counter: those need line-buffered stdin, so while any of them holds it the
 *  raw handler detaches and cooked mode is restored, then re-attaches when they're done (if a turn
 *  is still running). `activeKeyListener` is the module-level handle those readers reach for — null
 *  outside a turn and on non-TTY, so their suspend/resume calls are safe no-ops there (this is what
 *  keeps the non-TTY `-p` path byte-unchanged). */
interface KeyListener {
  beginTurn(): void; // a turn started → we want the raw handler on
  endTurn(): void; // the turn ended → detach (the composer read owns cooked stdin next)
  suspend(): void; // a cooked-mode reader is taking stdin — detach + restore cooked mode
  resume(): void; // that reader finished — re-attach iff a turn is still running and nobody else holds it
  destroy(): void; // final teardown — detach, restore cooked mode, pause stdin
}
let activeKeyListener: KeyListener | null = null;

function makeKeyListener(onChunk: (chunk: Buffer) => void): KeyListener {
  let attached = false; // raw "data" handler currently on stdin
  let wantActive = false; // a turn is running → we WANT the raw handler on
  let suspendDepth = 0; // cooked-mode readers currently holding stdin (counter, not bool: readLine + a queued approval can both hold it)
  let destroyed = false;
  const handler = (chunk: Buffer) => onChunk(chunk);
  // Reconcile the desired attach state after any input to the four levers above. The raw handler
  // is on iff a turn wants it, no cooked reader holds stdin, we're not torn down, and we're a TTY.
  function sync(): void {
    const shouldAttach = wantActive && suspendDepth === 0 && !destroyed && process.stdin.isTTY;
    if (shouldAttach && !attached) {
      process.stdin.setRawMode(true);
      process.stdin.on("data", handler);
      process.stdin.resume();
      attached = true;
    } else if (!shouldAttach && attached) {
      process.stdin.off("data", handler);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      attached = false;
    }
  }
  return {
    beginTurn() { wantActive = true; sync(); },
    endTurn() { wantActive = false; sync(); },
    suspend() { suspendDepth++; sync(); },
    resume() { if (suspendDepth > 0) suspendDepth--; sync(); },
    destroy() {
      destroyed = true; wantActive = false; sync();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}

async function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  try {
    for await (const chunk of stdin) {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") { process.stdout.write("\n"); return buf; }
        if (ch === "") { process.stdout.write("\n"); process.exit(130); } // Ctrl-C
        if (ch === "" || ch === "\b") { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        buf += ch;
        process.stdout.write("*");
      }
    }
    return buf;
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  }
}

// Single y/N question on stdin, reusing the same non-raw "read a chunk, check for a leading y"
// pattern the approval_requested prompt below uses. TTY-guarded by callers; resolves false on EOF.
async function askYesNo(promptText: string): Promise<boolean> {
  activeKeyListener?.suspend(); // yield raw stdin → cooked, so the whole "y\n" line arrives as one chunk
  process.stdout.write(promptText);
  const stdin = process.stdin;
  return new Promise((resolvePromise) => {
    const onData = (d: Buffer) => { cleanup(); resolvePromise(String(d).trim().toLowerCase() === "y"); };
    const onEnd = () => { cleanup(); resolvePromise(false); };
    function cleanup() { stdin.off("data", onData); stdin.off("end", onEnd); activeKeyListener?.resume(); }
    stdin.once("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

// Reads one line of free-form text from stdin — same one-shot "data"/"end" pattern as askYesNo,
// but returns the raw trimmed text instead of parsing y/n. Used for ask_user question answers AND
// the chat composer. Suspends the raw control-key listener (Task 6) while it owns stdin so it gets
// a cooked, line-buffered read. TTY-guarded by callers. Returns the trimmed line, or `null` on EOF
// (ctrl+D / closed stdin) — the composer uses null to mean "exit", distinct from "" (empty line →
// re-prompt); the question-menu callers coalesce null to "" since EOF there is just an empty answer.
async function readLine(promptText: string): Promise<string | null> {
  activeKeyListener?.suspend();
  process.stdout.write(promptText);
  const stdin = process.stdin;
  return new Promise((resolvePromise) => {
    const done = (v: string | null) => { cleanup(); resolvePromise(v); };
    const onData = (d: Buffer) => done(String(d).trim());
    const onEnd = () => done(null);
    function cleanup() { stdin.off("data", onData); stdin.off("end", onEnd); activeKeyListener?.resume(); }
    stdin.once("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

async function getToken(): Promise<string> {
  const t = await new KeychainSecretStore().get(TOKEN_NAMES.harness);
  if (!t) throw new Error("no harness token — is the daemon installed? run: norma daemon run");
  return t;
}

function socketPath(): string {
  return join(resolveNormaHome(), "run", "core.sock");
}

async function connect(name: string, onEvent: (e: any) => void = () => {}): Promise<NormaClient> {
  return NormaClient.connect({ socketPath: socketPath(), token: await getToken(), clientName: name, onEvent });
}

// Canned prompt for `norma init`: surveys the project and writes/updates a NORMA.md at its root.
export const INIT_PROMPT =
  "Survey this project to understand it: read the README, the package manifest (package.json/pyproject/Cargo.toml/etc.), and skim the directory structure and a few key source files. Then write a concise NORMA.md at the project root capturing: what this project is, how to build/test/run it, and the key conventions a new contributor should follow. If a NORMA.md already exists, read it and UPDATE it rather than clobbering. Keep it tight and factual.";

// Turn-watching runner (2e-iii-b Task 6 — refactored from the former `runHeadlessAgent`). Wires
// the client, the pinned-block/event machinery, the raw control-key listener, and the stall
// watchdog ONCE, then either runs a SINGLE turn and exits (chat:false — `-p`, `resume id text`,
// `init`; byte-identical to before on the non-TTY path, incl. exit codes + the bg grace-kill) or
// LOOPS (chat:true — bare `norma`, `resume <id>` with no text): after each turn it erases the block
// and shows the `› ` composer, sends the next line, and watches again. ctrl+C / ctrl+D (EOF) tears
// down cleanly (timers cleared, terminal restored, client closed).
async function runTurnSession(opts: { promptOverride?: string; forceAuto?: boolean; existingSessionId?: string; chat: boolean }): Promise<void> {
  const { promptOverride, forceAuto = false, existingSessionId, chat } = opts;

  // -p teardown: mirrors Claude Code's headless grace-kill. Any bg tasks still running when the
  // turn completes get a grace period (NORMA_BG_PRINT_WAIT_MS, default 5000ms; 0 = poll until none
  // are running rather than racing a fixed timer) before we force-kill whatever remains. One-shot
  // (chat:false) only — chat mode leaves bg tasks running across turns and tears down via
  // teardownAndExit instead. Uses the enclosing closures (c/sessionId/wdTimer/spinnerTimer).
  async function endHeadlessTurn(exitCode: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    if (wdTimer) clearInterval(wdTimer); // normal completion — stop watching for a stall that didn't happen
    clearInterval(spinnerTimer); // stop the status-line spinner/elapsed tick — the turn is over
    const running = (await c.bgList(sessionId)).filter((t) => t.status === "running");
    if (running.length) {
      const waitMs = Number(process.env.NORMA_BG_PRINT_WAIT_MS ?? 5000);
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        while ((await c.bgList(sessionId)).some((t) => t.status === "running")) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      await c.bgKillAll(sessionId);
    }
    eraseBlockIfPinned(); // clear the pinned chrome (status/tasks/footer/mode bar) before exit — the transcript above stays
    keyListener.destroy(); // restore cooked mode / pause stdin (no-op on non-TTY, so byte-unchanged there)
    c.close();
    process.exit(exitCode);
  }

  // One-shot needs a prompt up front (argv[3] for `-p`, else the promptOverride); chat starts from
  // the composer, so it never reads argv[3] (in `resume <id>` chat, argv[3] is the SESSION id).
  const oneShotPrompt = promptOverride ?? process.argv[3];
  if (!chat && !oneShotPrompt) {
    console.error('usage: norma -p "<prompt>" [--auto|--plan]');
    process.exit(1);
  }
  const auto = forceAuto || process.argv.includes("--auto");
  const plan = process.argv.includes("--plan"); // plan mode: agent must present a plan before editing; ignored if --auto also set
  let policy: ApprovalPolicy = auto ? "auto" : plan ? "plan" : "ask"; // seeds the mode bar; shift+tab cycles it live
  let policyInFlight = false; // in-flight guard — one setPolicy RPC at a time (repeat shift+tab ignored until it settles)
  const pending: string[] = []; // callIds awaiting a y/n on stdin, oldest first
  let sessionId = ""; // set below, before send() — turn_completed can only fire after that
  const wd: WatchdogState = { turnRunning: false, toolsInFlight: 0, approvalsPending: 0, lastEventAt: Date.now() };
  let wdTimer: ReturnType<typeof setInterval> | undefined; // one session-long stall poll; cleared on teardown
  let exiting = false; // guard to ensure a single exit path wins (stall watchdog vs endHeadlessTurn vs ctrl+C)
  let streaming = false; // an assistant line is mid-stream on stdout (deltas printed, no newline yet)
  let resolveTurn: (() => void) | null = null; // chat: the main turn_completed resolves this to advance the loop

  // Pinned block (CC parity): TTY-only. `tasks` mirrors the session's current task list (upsert on
  // task_updated). `atLineStart` tracks whether the last byte written to stdout was a newline (the
  // ONLY safe moment to erase+redraw — never mid a streamed delta or bg-task-output chunk, both of
  // which can end without one). `pinnedLineLengths` (Task 6, replacing the old plain `pinnedLines`
  // counter) stores each currently-painted block line's VISIBLE length, so the erase step can
  // compute how many PHYSICAL rows the block occupies at the CURRENT terminal width — correct even
  // after a resize re-wraps already-drawn lines (§8). Non-TTY (piped/-p) is untouched:
  // eraseBlockIfPinned/repaintBlockIfSafe are no-ops there (isTTY gate), so `emit()` degenerates to
  // a plain write and the non-TTY branches keep their exact one-line-per-update output.
  let tasks: Task[] = [];
  let subagents: CliSubagent[] = []; // live child threads of the current turn (2e-ii)
  const selection: FooterSelection = { selectedThreadId: "main", focusIndex: null }; // Task 6 thread selector (footer)
  let atLineStart = true;
  let pinnedLineLengths: number[] = [];

  // Live turn status (Task 4): drives the "⠋ Working… (14s · ↑ 1.2k ↓ 842 tokens)" line printed
  // above the task rows while a turn is running — Claude Code parity. turnRunning/turnStartMs
  // reset on turn_started; streamedChars is a rough token-count proxy while a turn is in flight
  // (the provider's real outputTokens is only known once turn_completed reports it); spinnerIdx is
  // advanced independently by the tick timer below.
  let turnRunning = false;
  let turnStartMs = 0;
  let streamedChars = 0;
  let lastInTokens = 0;
  let lastOutTokens = 0;
  let spinnerIdx = 0;

  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, ""); // visible length = ANSI-stripped length

  function eraseBlockIfPinned(): void {
    if (pinnedLineLengths.length > 0) {
      // §8: count the PHYSICAL rows the painted block occupies at the CURRENT width (a resize may
      // have re-wrapped it since it was drawn) from each line's stored visible length — not the
      // logical line count, which would cursor-up too few rows and strand wrapped fragments.
      const rows = physicalRows(pinnedLineLengths, process.stdout.columns);
      process.stdout.write(`\x1b[${rows}A\x1b[0J`);
      pinnedLineLengths = [];
    }
  }
  function repaintBlockIfSafe(): void {
    if (!process.stdout.isTTY || !atLineStart) return;
    // Width passed per-repaint (not cached): terminal resizes between repaints pick up the new
    // width; truncation keeps 1 logical line == 1 physical row so the erase count stays exact.
    const columns = process.stdout.columns;
    const lines: string[] = [];
    if (turnRunning) {
      const activeForm = tasks.find((t) => t.status === "in_progress")?.activeForm ?? "Working";
      const statusLine = renderStatusLine({
        activeForm,
        elapsedMs: Date.now() - turnStartMs,
        inTokens: lastInTokens,
        outTokens: turnRunning ? Math.ceil(streamedChars / 4) : lastOutTokens,
        spinnerFrame: SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]!,
      });
      lines.push(truncateStatusLine(statusLine, columns));
    }
    // Task 6 composition (design §1): [status line][task tree][agents footer][mode bar]. The 2e-ii
    // subagent block is gone (absorbed into the footer). The footer renders itself only while a
    // turn runs OR a subagent is alive; the mode bar always renders in interactive TTY (this whole
    // function is isTTY-gated). Each renderer already truncates every row to one physical line at
    // this width and colors its own spans — no outer wrap here.
    lines.push(...renderTaskBlock(tasks, columns));
    lines.push(...renderAgentsFooter(subagents, selection, turnRunning, Date.now(), columns));
    lines.push(renderModeBar(policy, columns));
    if (lines.length === 0) return;
    for (const l of lines) process.stdout.write(`${l}\n`);
    // Store each line's VISIBLE (ANSI-stripped) length so eraseBlockIfPinned's physical-row math is
    // width-exact regardless of how the terminal is later resized.
    pinnedLineLengths = lines.map((l) => stripAnsi(l).length);
  }
  function refreshBlock(): void { eraseBlockIfPinned(); repaintBlockIfSafe(); }
  // Spinner/elapsed tick: advances the animation frame and, only while a turn is actually running
  // on a TTY, asks for a repaint. refreshBlock() itself only ever erases+redraws at a safe stream
  // boundary (atLineStart) via repaintBlockIfSafe, so a tick landing mid-delta is a harmless no-op
  // — this timer never needs to know about streaming state. unref() so a live process never keeps
  // running just because this timer is still armed; cleared explicitly wherever the CLI tears down
  // (see endHeadlessTurn and the stall-watchdog exit path below).
  const spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    if (turnRunning && process.stdout.isTTY) refreshBlock();
  }, 120);
  spinnerTimer.unref?.();
  // Every stdout write in this event loop funnels through here so the block is always erased
  // before new content lands and (if we're at a safe fresh-line boundary afterwards) redrawn
  // below it — this is what keeps it "pinned" without ever tearing a partial line.
  function emit(text: string): void {
    eraseBlockIfPinned();
    process.stdout.write(text);
    atLineStart = trackLineStart(atLineStart, text);
    repaintBlockIfSafe();
  }

  // --- interactive controls (Task 6) ---

  // shift+tab cycles ask→auto→plan→ask via the session.setPolicy RPC; the mode bar updates only on
  // success (repaint). An in-flight guard drops repeat presses until the RPC settles; a failure
  // prints a dim one-line notice and leaves the bar unchanged.
  async function cyclePolicy(): Promise<void> {
    if (policyInFlight) return;
    policyInFlight = true;
    const order: ApprovalPolicy[] = ["ask", "auto", "plan"];
    const next = order[(order.indexOf(policy) + 1) % order.length]!;
    try {
      await c.setPolicy(sessionId, next);
      policy = next;
      refreshBlock();
    } catch {
      emit(`${DIM}couldn't switch to ${next} mode${RESET}\n`);
    } finally {
      policyInFlight = false;
    }
  }

  // The footer's row order — main first, then LIVE subagents in first-seen order — kept in exact
  // lockstep with renderAgentsFooter's filtered rows (both drop "done" rows) so footerKeyAction's
  // index math and the enter→select thread-id resolution line up with what's actually on screen.
  const currentRowThreadIds = (): string[] =>
    ["main", ...subagents.filter((s) => s.status !== "done").map((s) => s.threadId)];

  // Apply a thread switch (enter in footer focus): select the thread, CLEAR focus (caller-must-
  // remember invariant), print the dim context line via emit(), repaint.
  function switchThread(threadId: string): void {
    selection.selectedThreadId = threadId;
    selection.focusIndex = null;
    if (threadId === "main") emit(`${DIM}→ viewing main${RESET}\n`);
    else {
      const item = subagents.find((s) => s.threadId === threadId);
      emit(`${DIM}→ viewing ${item?.agentType ?? ""}: ${item?.label ?? ""}${RESET}\n`);
    }
    refreshBlock();
  }

  // Dispatch one decoded control key through the pure footerKeyAction decision table, then apply
  // the resulting KeyAction against the live FooterSelection / policy / session (the effectful half
  // keys.ts deliberately leaves to the caller).
  function onKey(key: ReturnType<typeof decodeKey>): void {
    const rowThreadIds = currentRowThreadIds();
    const action = footerKeyAction(key, selection, rowThreadIds);
    switch (action.kind) {
      case "focusFooter": {
        // Seed focus on the currently-selected row; −1 (selection isn't a live row) → 0 (main).
        const idx = rowThreadIds.indexOf(selection.selectedThreadId);
        selection.focusIndex = idx === -1 ? 0 : idx;
        refreshBlock();
        break;
      }
      case "moveFocus":
        selection.focusIndex = action.index;
        refreshBlock();
        break;
      case "exitFocus":
        selection.focusIndex = null;
        refreshBlock();
        break;
      case "select":
        switchThread(action.threadId);
        break;
      case "interrupt":
        void c.interrupt(sessionId); // wires the mode bar's "esc to interrupt" for real
        break;
      case "cyclePolicy":
        void cyclePolicy();
        break;
      case "none":
        break;
    }
  }

  // The raw control-key listener (owns stdin only while a turn runs — see makeKeyListener). ctrl+C
  // is handled here because raw mode swallows the terminal's SIGINT: chat → clean exit 0, one-shot
  // → 130 (the conventional interrupted-process code).
  const keyListener = makeKeyListener((chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString();
    if (s === "\x03") { void teardownAndExit(chat ? 0 : 130); return; }
    onKey(decodeKey(chunk));
  });
  activeKeyListener = keyListener;

  // Clean shutdown for ctrl+C / ctrl+D (EOF) and any other non-turn-completion exit: stop the
  // timers, wipe the pinned chrome, restore the terminal, close the socket. `exiting` makes the
  // first caller win over a racing watchdog/turn-completion.
  async function teardownAndExit(code: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    clearInterval(spinnerTimer);
    if (wdTimer) clearInterval(wdTimer);
    eraseBlockIfPinned();
    keyListener.destroy();
    c.close();
    process.exit(code);
  }

  // Resize (design §8, hard requirement): erase-then-repaint immediately so aggressive mid-turn
  // resizing leaves no stranded fragments. eraseBlockIfPinned reads the CURRENT columns against the
  // stored visible lengths (a width shrink that re-wrapped the block is cleared exactly); the
  // repaint re-truncates to the new width. Gated on turnRunning — between turns the block is erased
  // and the `› ` composer owns the screen, so a resize there must NOT paint chrome under it.
  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => { if (process.stdout.isTTY && turnRunning) refreshBlock(); });
  }

  const c = await connect(chat ? "cli-chat" : "cli-p", (e) => {
    const sa = streamAction(streaming, e as { type: string; threadId?: string }, selection.selectedThreadId);
    streaming = sa.streaming;
    // ↓ out-tokens proxy stays keyed to the MAIN thread (the status line describes the main turn),
    // NOT to write_delta — a selected SUBAGENT's deltas stream to the transcript but must not grow
    // the main turn's estimate; and the main turn keeps counting even while a subagent is selected.
    if (e.type === "assistant_delta" && (e as { threadId?: string }).threadId === "main") {
      streamedChars += (e as { delta: string }).delta.length;
    }
    if (sa.action === "write_delta") {
      emit(`${AQUA}${(e as { delta: string }).delta}${RESET}`);
    } else if (sa.action === "close_line") emit("\n");
    applyEvent(wd, e, Date.now());
    const nextSubagents = updateSubagents(subagents, e as { type: string; threadId?: string });
    if (nextSubagents !== subagents) {
      subagents = nextSubagents;
      // Child turn_started/turn_completed hit no emit() branch below (their branches are
      // main-guarded), so repaint here; delta-driven token growth rides the 120ms spinner tick.
      if ((e.type === "turn_started" || e.type === "turn_completed") && process.stdout.isTTY) refreshBlock();
    }
    if (e.type === "turn_started" && e.threadId === "main") {
      // Task-4 review fix: MAIN-thread only. runThread() emits turn_started/turn_completed for
      // every spawned subagent CHILD thread too (broadcast to all harnesses with a non-"main"
      // threadId — same reason stream-state.ts guards deltas on "main"). Without this guard a
      // child's turn_started reset the parent's clock/token estimate and a child's turn_completed
      // flipped turnRunning off mid-parent-turn — the status line flickered/vanished while the
      // real turn was still running.
      turnRunning = true;
      turnStartMs = Date.now();
      streamedChars = 0;
      refreshBlock(); // show the status line immediately rather than waiting up to 120ms for the first tick
    } else if (e.type === "assistant_message") {
      if (sa.action === "close_then_print_full") { emit("\n"); emit(`${AQUA}${e.text}${RESET}\n`); }
      else if (sa.action === "print_full") emit(`${AQUA}${e.text}${RESET}\n`);
      else emit("\n");
    }
    else if (e.type === "tool_call") emit(`${DIM}⚙ ${e.name} ${e.argsJson.slice(0, 120)}${RESET}\n`);
    else if (e.type === "tool_result") emit(`${DIM}  ↳ ${e.isError ? "ERROR: " : ""}${e.output.split("\n")[0]?.slice(0, 120) ?? ""}${RESET}\n`);
    else if (e.type === "approval_requested") {
      emit(`approve ${e.toolName}? ${DIM}${e.summary}${RESET} [y/N] `);
      const wasEmpty = pending.length === 0;
      pending.push(e.callId);
      // Yield raw stdin → cooked so the whole "y\n" line reaches the approval reader (only on the
      // first of a batch; the reader resumes the key listener once the batch fully drains).
      if (wasEmpty) activeKeyListener?.suspend();
    } else if (e.type === "directory_added") emit(`${DIM}+ dir ${e.path}${e.persisted ? " (remembered)" : ""}${RESET}\n`);
    else if (e.type === "bg_task_started") emit(`${DIM}▶ bg ${e.taskId} started: ${e.command.slice(0, 80)}${RESET}\n`);
    else if (e.type === "bg_task_output") emit(`${DIM}${e.chunk}${RESET}`);
    else if (e.type === "bg_task_exited") emit(`${DIM}■ bg ${e.taskId} exited (${e.killed ? "killed" : "exit " + e.exitCode})${RESET}\n`);
    else if (e.type === "question_asked") {
      // No TTY → skip rendering entirely (do NOT block reading stdin); the QuestionBroker
      // times out server-side and the engine proceeds with its "best judgment" fallback.
      if (process.stdin.isTTY) {
        void (async () => {
          const answers: Record<string, string> = {};
          for (const q of e.questions) {
            emit(`\n${AQUA}${q.header}${RESET} — ${q.question}\n`);
            q.options.forEach((o: { label: string; description?: string }, i: number) => {
              emit(`  ${i + 1}) ${o.label}${o.description ? ` ${DIM}${o.description}${RESET}` : ""}\n`);
            });
            emit(`  ${q.options.length + 1}) Other (type your answer)\n`);
            // The prompt text is written via emit() (so the block's erase/reprint bookkeeping
            // stays accurate) and readLine() itself is given "" — it still does its own raw,
            // un-tracked stdout write for whatever text it's passed, which would desync
            // atLineStart if we let it print the real prompt.
            const promptText = q.multiSelect ? "choose (comma-separated numbers or text): " : "choose (number or text): ";
            emit(promptText);
            const input = (await readLine("")) ?? ""; // readLine now returns null on EOF; "" here (empty answer)
            if (isOtherChoice(input, q.options.length)) {
              // M1: choosing "Other" BY ITS MENU NUMBER isn't itself an answer — that digit is a
              // selection, not free text. Re-prompt for the real answer so the model never sees
              // the literal number as if the user had typed it as their response.
              emit("your answer: ");
              answers[q.question] = ((await readLine("")) ?? "").trim();
            } else {
              answers[q.question] = parseQuestionAnswer(input, q.options.map((o: { label: string }) => o.label), q.multiSelect);
            }
          }
          await c.askUserRespond({ sessionId, callId: e.callId, answers });
        })();
      }
    } else if (e.type === "plan_presented") {
      // No TTY → skip rendering entirely (do NOT block reading stdin); the server-side timeout
      // resolves the plan and the engine proceeds, same guard as question_asked above.
      if (process.stdin.isTTY) {
        void (async () => {
          emit(`\n${AQUA}Plan${RESET}\n${e.plan}\n\n`);
          emit(`  1) approve — I'll approve each edit\n  2) approve + auto-accept edits\n  3) reject (type: 3 <reason>)\n`);
          emit("choose (number or text): ");
          const input = (await readLine("")) ?? "";
          const r = parsePlanResponse(input);
          await c.planRespond({ sessionId, callId: e.callId, ...r });
        })();
      }
    } else if (e.type === "plan_resolved") {
      emit(`${DIM}${e.approved ? `plan approved${e.autoAccept ? " (auto-accept edits)" : ""}` : "plan rejected"}${RESET}\n`);
    } else if (e.type === "task_updated") {
      tasks = upsertTask(tasks, e.task);
      // TTY: the per-line print is replaced by the pinned block (upserted above); non-TTY
      // (headless consumers parse this) keeps the exact original one-line-per-update output.
      if (process.stdout.isTTY) refreshBlock();
      else emit(NONTTY_TASK_LINE(e.task.status, e.task.subject));
    } else if (e.type === "worktree_entered") {
      emit(`${DIM}⛿ entered worktree ${e.name} (branch ${e.branch})${RESET}\n`);
    } else if (e.type === "worktree_exited") {
      emit(`${DIM}⟲ left worktree ${e.name}${e.removed ? " (removed)" : ""}${RESET}\n`);
    } else if (e.type === "thread_started") {
      // Task 5 (2e-iii-b): TTY gets the CC-style "Agent(label) agentType" line (subagents was
      // just updated above, so the freshly-pushed CliSubagent's label is already there); non-TTY
      // keeps the exact original literal (headless consumers parse this).
      const label = subagents.find((s) => s.threadId === e.threadId)?.label ?? "";
      emit(process.stdout.isTTY
        ? `${agentSpawnLine(label, e.agentType)}\n`
        : NONTTY_SPAWN_LINE(e.agentType));
    } else if (e.type === "thread_completed") {
      // Task 5: read finish stats from `subagents` BEFORE they're pruned — updateSubagents (run
      // earlier in this handler) only flips this entry to "done" here; the prune to [] happens
      // later, on the MAIN thread's own turn_completed — so the item is still present.
      const item = subagents.find((s) => s.threadId === e.threadId);
      emit(process.stdout.isTTY
        ? `${agentFinishLines(item?.label ?? "", item?.activeMs ?? 0, item?.toolCalls ?? 0).join("\n")}\n`
        : NONTTY_FINISH_LINE(e.stopReason));
      // §4 snap-back: if the just-finished subagent was the one being viewed, selection returns to
      // main (and a live focus highlight follows to the main row). The dim context line goes through
      // emit() so the block bookkeeping stays correct.
      if (selection.selectedThreadId === e.threadId) {
        selection.selectedThreadId = "main";
        if (selection.focusIndex !== null) selection.focusIndex = 0;
        emit(`${DIM}→ viewing main${RESET}\n`);
      }
    } else if (e.type === "agent_error") {
      console.error(`agent error: ${e.message}`);
    } else if (e.type === "turn_completed" && e.threadId === "main") {
      // Task-4 review fix (MAIN-thread only — see turn_started above). This ALSO fixes a
      // pre-existing latent bug the review surfaced: a subagent CHILD's turn_completed always
      // fires BEFORE the main thread's own (children are awaited inside the main tool loop), so an
      // unguarded endHeadlessTurn() would c.close()/exit the CLI the instant the FIRST subagent
      // finished — while the main turn was still running. The threadId guard closes both.
      if (process.stdout.isTTY) {
        // Task 5: printed BEFORE the bookkeeping below so it lands above the final block teardown.
        // Non-TTY prints nothing extra here (unchanged).
        const activeForm = tasks.filter((t) => t.status === "in_progress").at(-1)?.activeForm ?? "Worked";
        emit(`${turnSummaryLine(activeForm, Date.now() - turnStartMs, e.inputTokens, e.outputTokens)}\n`);
      }
      turnRunning = false;
      lastInTokens = e.inputTokens;
      lastOutTokens = e.outputTokens;
      refreshBlock(); // safety net: status line gone (turn over), task rows reflect final state (and disappear if all done)
      if (chat) {
        // Chat: don't exit — disarm the key listener (the composer read owns cooked stdin next) and
        // hand control back to the loop, which erases the block and shows the `› ` composer.
        keyListener.endTurn();
        resolveTurn?.();
        resolveTurn = null;
      } else {
        void endHeadlessTurn(e.stopReason === "end_turn" ? 0 : 1);
      }
    }
  });

  const cwd = process.cwd();
  if (existingSessionId) {
    sessionId = existingSessionId;
    const info = (await c.listSessions()).sessions.find((r: any) => r.sessionId === existingSessionId);
    if (!info) { console.error(`no such session: ${existingSessionId}`); c.close(); process.exit(1); }
    console.log(`${DIM}↻ resuming ${existingSessionId} — ${info.scope}, ${info.lastSeq} events${RESET}`);
    // Attach from the tip (info.lastSeq), not seq 0: attaching from 0 would replay every
    // historical turn_completed event on this session, tripping endHeadlessTurn immediately.
    await c.attach(sessionId, info.lastSeq);
  } else {
    const created = await c.createSession("global", { cwd, approvalPolicy: auto ? "auto" : plan ? "plan" : "ask" });
    sessionId = created.sessionId;
    if (!created.trusted) {
      const wantTrust = process.argv.includes("--trust")
        || (process.stdout.isTTY && !process.argv.includes("--no-trust") && (await askYesNo(`Do you trust the files in ${cwd}? Norma may grant directory access declared there. [y/N] `)));
      if (wantTrust) { await c.trustDir(cwd); console.log(`${DIM}trusted ${cwd}${RESET}`); }
    }
    await c.attach(sessionId);
  }

  // Persistent y/N approval reader. Installed whenever approvals are possible: one-shot keeps its
  // exact `!auto` condition (byte-unchanged); chat always installs it, since shift+tab can cycle
  // the policy INTO "ask" mid-session. When no approval is pending it early-returns — so during a
  // running turn it coexists harmlessly with the raw key listener (a keystroke just no-ops here),
  // and during the composer read it ignores the typed message. When an approval IS pending the raw
  // key listener is suspended (below), so this cooked handler reads the whole "y\n" line; on the
  // last pending approval it hands stdin back to the key listener.
  if (chat || !auto) {
    process.stdin.on("data", async (d) => {
      if (pending.length === 0) return;
      const yes = String(d).trim().toLowerCase() === "y";
      const callId = pending.shift();
      if (callId) await c.request(METHODS.approvalRespond, { sessionId, callId, approved: yes });
      if (pending.length === 0) activeKeyListener?.resume();
    });
  }

  // Stall watchdog: one session-long poll. If the turn is running with nothing in flight (no tool
  // executing, no approval awaiting a human) and no event has landed for thresholdMs, assume the
  // turn is wedged and abort. Between turns (chat) wd.turnRunning is false, so it never false-fires.
  const thresholdMs = Number(process.env.NORMA_TURN_STALL_MS ?? 180000);
  wdTimer = setInterval(() => {
    if (isStalled(wd, Date.now(), thresholdMs)) {
      if (exiting) return;
      exiting = true;
      clearInterval(wdTimer);
      clearInterval(spinnerTimer);
      eraseBlockIfPinned();
      keyListener.destroy();
      console.error(`\n[stalled: no progress for ${Math.round((Date.now() - wd.lastEventAt) / 1000)}s — aborting]`);
      void c.interrupt(sessionId).finally(() => process.exit(2));
    }
  }, 5000);
  wdTimer.unref?.(); // don't let the poll tick keep the process alive after normal completion

  // Sends one prompt and waits for the MAIN turn_completed. In chat the handler resolves this so
  // the loop continues; in one-shot the handler calls endHeadlessTurn → process.exit, so this
  // await never returns (the process is gone). The key listener is armed for the turn's duration.
  async function runOneTurn(text: string): Promise<void> {
    keyListener.beginTurn();
    const done = new Promise<void>((resolve) => { resolveTurn = resolve; });
    await c.send(sessionId, text);
    await done;
  }

  if (chat) {
    // ctrl+C during the COOKED composer read raises SIGINT (raw mode is off there) → clean exit;
    // during a turn raw mode swallows SIGINT and the \x03 key handler covers it.
    process.on("SIGINT", () => { void teardownAndExit(0); });
    for (;;) {
      eraseBlockIfPinned(); // drop any lingering chrome before the composer
      atLineStart = true;
      const line = await readLine("› ");
      if (line === null) { await teardownAndExit(0); return; } // ctrl+D / EOF → exit
      if (line === "") continue; // empty line → re-prompt (no send)
      await runOneTurn(line);
    }
  }

  await runOneTurn(oneShotPrompt!); // one-shot: never returns — exits via the turn_completed branch above
  await new Promise(() => {}); // safety net if runOneTurn ever resolves unexpectedly
}

// Guarded so `main.ts` can be imported (e.g. by tests, for INIT_PROMPT/runTurnSession) without
// executing the CLI — import.meta.main is true only when this file is the entry point.
if (import.meta.main) {
  if (process.argv[2] === "-p") {
    await runTurnSession({ chat: false }); // one-shot; never resolves normally — exits via process.exit()
  }
  if (process.argv[2] === undefined) {
    await runTurnSession({ chat: true }); // bare `norma` → persistent chat mode on a fresh session (loops until ctrl+C/ctrl+D)
  }

  const argv = process.argv.slice(2);
  const [cmd, sub] = argv;

  // Two-word subcommands use "cmd sub"; single-word commands match on cmd alone.
  const cmdKey = cmd === "daemon" ? `daemon ${sub ?? ""}`.trim() : (cmd ?? "");

  switch (cmdKey) {
  case "daemon run": {
    await startDaemon();
    break; // keeps running; SIGINT/SIGTERM handled in daemon.ts
  }
  case "ping": {
    const c = await connect("cli-ping");
    console.log(`${AQUA}◍ norma-core is up${RESET} ${DIM}(${socketPath()})${RESET}`);
    c.close();
    break;
  }
  case "sessions": {
    const c = await connect("cli-sessions");
    const { sessions } = (await c.listSessions()) as any;
    for (const s of sessions) console.log(`${AQUA}${s.sessionId}${RESET} ${DIM}${s.scope} · ${s.lastSeq} events${process.stdout.isTTY && s.title ? ` — ${s.title}` : ""}${RESET}`);
    c.close();
    break;
  }
  case "send": {
    // usage: norma send <sessionId|new> <text...>
    const args = process.argv.slice(3);
    const target = args[0];
    const text = args.slice(1).join(" ");
    if (!target || !text) { console.error("usage: norma send <sessionId|new> <text…>"); process.exit(1); }
    const c = await connect("cli-send");
    const sessionId = target === "new" ? (await c.createSession("global")).sessionId : target;
    await c.attach(sessionId);
    await c.send(sessionId, text);
    console.log(`${AQUA}sent to ${sessionId}${RESET}`);
    c.close();
    break;
  }
  case "add-dir": {
    const sessionId = process.argv[3];
    const path = process.argv[4];
    if (!sessionId || !path) { console.error("usage: norma add-dir <sessionId> <path> [--persist]"); process.exit(1); }
    const c = await connect("cli-add-dir");
    const roots = await c.addDir(sessionId, path, process.argv.includes("--persist"));
    console.log(`${AQUA}+ dir ${path} → ${roots.length} roots${RESET}`);
    c.close();
    break;
  }
  case "trust": {
    const arg = process.argv[3];
    if (arg === "--list") {
      // Protocol has no daemon.trustList method (kept minimal) — read ~/.norma/trust.json directly.
      const trustPath = join(resolveNormaHome(), "trust.json");
      let dirs: string[] = [];
      if (existsSync(trustPath)) {
        try {
          const raw = JSON.parse(readFileSync(trustPath, "utf8"));
          dirs = Array.isArray(raw?.trustedDirs) ? raw.trustedDirs.map(String) : [];
        } catch { /* corrupt/unreadable file — treat as empty */ }
      }
      if (dirs.length === 0) console.log("(none)");
      else for (const d of dirs) console.log(d);
    } else if (arg) {
      const c = await connect("cli-trust");
      await c.trustDir(resolve(arg));
      console.log(`${AQUA}trusted ${resolve(arg)}${RESET}`);
      c.close();
    } else {
      console.error("usage: norma trust <dir> | norma trust --list");
      process.exit(1);
    }
    break;
  }
  case "cd": {
    const sessionId = process.argv[3];
    const cwd = process.argv[4];
    if (!sessionId || !cwd) { console.error("usage: norma cd <sessionId> <path>"); process.exit(1); }
    const c = await connect("cli-cd");
    const newCwd = await c.setCwd(sessionId, cwd);
    console.log(`${AQUA}cwd → ${newCwd}${RESET}`);
    c.close();
    break;
  }
  case "steer": {
    const sessionId = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    if (!sessionId || !text) { console.error("usage: norma steer <sessionId> <text…>"); process.exit(1); }
    const c = await connect("cli-steer");
    const result = await c.steer(sessionId, text);
    console.log(`${AQUA}steered${RESET} ${result.injected ? "(injected)" : "(queued for next turn)"}`);
    c.close();
    break;
  }
  case "interrupt": {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error("usage: norma interrupt <sessionId>"); process.exit(1); }
    const c = await connect("cli-interrupt");
    const result = await c.interrupt(sessionId);
    console.log(`${AQUA}interrupted${RESET} ${result.wasRunning ? "(was running)" : "(nothing running)"}`);
    c.close();
    break;
  }
  case "compact": {
    const sid = process.argv[3];
    if (!sid) { console.error("usage: norma compact <sessionId>"); process.exit(1); }
    const c = await connect("cli-compact");
    const r = await c.compact(sid);
    console.log(r.compacted ? `${AQUA}compacted${RESET} (through seq ${r.uptoSeq}, ${r.summaryChars} char summary)` : "nothing to compact yet");
    c.close();
    process.exit(0);
  }
  case "skills": {
    const c = await connect("cli-skills");
    const rows = await c.listSkills(process.cwd());
    if (!rows.length) console.log("no skills installed");
    for (const s of rows) console.log(`${AQUA}${s.name}${RESET}  ${DIM}(${s.source})${RESET}  — ${s.description}`);
    c.close();
    process.exit(0);
  }
  case "mcp": {
    const c = await connect("cli-mcp");
    const servers = await c.listMcp(process.cwd());
    if (!servers.length) console.log("no MCP servers configured");
    for (const s of servers) {
      console.log(`${AQUA}${s.name}${RESET}  ${DIM}(${s.source}, ${s.status})${RESET}  ${s.toolNames.map((t) => `mcp__${s.name}__${t}`).join(", ")}`);
    }
    c.close();
    process.exit(0);
  }
  case "plugin": {
    const sub = process.argv[3];
    const home = resolveNormaHome();
    const settingsPath = join(home, "settings.json");
    const pluginsRoot = join(home, "plugins");

    if (sub === "list") {
      const c = await connect("cli-plugin-list");
      const res = await c.pluginsList();
      for (const p of res.plugins) {
        const mcp = !p.hasMcp ? "no mcp" : p.mcpEnabled ? "mcp: enabled" : `mcp: DISABLED (norma plugin enable ${p.name} to allow — code execution)`;
        const flags = p.disabled ? " [disabled]" : "";
        console.log(`${AQUA}${p.name}${RESET}${p.version ? ` ${DIM}v${p.version}${RESET}` : ""}${flags}  skills: ${p.skills.join(", ") || "(none)"}  ${DIM}${mcp}${RESET}`);
      }
      if (res.plugins.length === 0) console.log("no plugins installed");
      c.close();
      process.exit(0);
    }

    if (sub === "install") {
      const url = process.argv[4];
      if (!url) { console.error("usage: norma plugin install <git-url> [name]"); process.exit(1); }
      let installed: { name: string; target: string };
      try {
        installed = installPlugin({ url, name: process.argv[5], pluginsRoot });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const { PluginStore } = await import("@norma/core");
      const info = new PluginStore({ normaHome: home }).list().find((p) => p.name === installed.name);
      console.log(`${AQUA}installed ${installed.name}${RESET}  skills: ${info?.skills.join(", ") || "(none)"}`);
      if (info?.hasMcp) console.log(`this plugin bundles MCP servers (code execution) — run ${AQUA}norma plugin enable ${installed.name}${RESET} to allow them`);
      break; // NEVER touches settings
    }

    if (sub === "enable" || sub === "disable") {
      const name = process.argv[4];
      if (!name) { console.error(`usage: norma plugin ${sub} <name>`); process.exit(1); }
      if (!existsSync(join(pluginsRoot, name))) { console.error(`no such plugin: ${name}`); process.exit(1); }
      const { loadSettings, saveSettings } = await import("@norma/core");
      saveSettings(settingsPath, setPluginEnabled(loadSettings(settingsPath), name, sub === "enable"));
      console.log(`${AQUA}${name} ${sub}d${RESET} — restart the daemon to apply`);
      break;
    }

    if (sub === "remove") {
      const name = process.argv[4];
      if (!name) { console.error("usage: norma plugin remove <name>"); process.exit(1); }
      try {
        removePluginDir(pluginsRoot, name);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const { loadSettings, saveSettings } = await import("@norma/core");
      saveSettings(settingsPath, removePluginFromSettings(loadSettings(settingsPath), name));
      console.log(`${AQUA}removed ${name}${RESET}`);
      break;
    }

    console.error("usage: norma plugin list | install <git-url> [name] | enable <name> | disable <name> | remove <name>");
    process.exit(1);
  }
  case "bg": {
    const bgSub = process.argv[3];
    const bgSessionId = process.argv[4];
    const bgTaskId = process.argv[5];
    if (!bgSessionId || (bgSub !== "list" && !bgTaskId)) {
      console.error("usage: norma bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>");
      process.exit(1);
    }
    const c = await connect("cli-bg");
    if (bgSub === "list") {
      const tasks = await c.bgList(bgSessionId);
      for (const t of tasks) console.log(`${AQUA}${t.taskId}${RESET} ${DIM}${t.status} · ${t.command.slice(0, 80)}${RESET}`);
      if (tasks.length === 0) console.log(`${DIM}(no bg tasks)${RESET}`);
    } else if (bgSub === "peek") {
      const r = await c.bgPeek(bgSessionId, bgTaskId!);
      console.log(`${AQUA}${r.status}${RESET} ${DIM}exit=${r.exitCode ?? "-"}${RESET}`);
      if (r.chunk) process.stdout.write(r.chunk);
    } else if (bgSub === "kill") {
      await c.bgKill(bgSessionId, bgTaskId!);
      console.log(`${AQUA}killed ${bgTaskId}${RESET}`);
    } else {
      console.error("usage: norma bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>");
      c.close();
      process.exit(1);
    }
    c.close();
    break;
  }
  case "watch": {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error("usage: norma watch <sessionId>"); process.exit(1); }
    const c = await connect("cli-watch", (e) => {
      if (e.type === "user_message") console.log(`${AQUA}❯${RESET} [${e.clientName}] ${e.text}`);
      else console.log(`${DIM}· ${e.type}${"clientName" in e ? ` (${e.clientName})` : ""}${RESET}`);
    });
    await c.attach(sessionId, 0);
    console.log(`${DIM}watching ${sessionId} — ctrl-c to stop${RESET}`);
    await new Promise(() => {}); // run until interrupted
    break; // unreachable, but keeps the switch uniform
  }
  case "daemon install": {
    const { installDaemon } = await import("./launchd");
    // process.execPath = the bun binary in dev, the compiled `norma` binary in production.
    const binary = process.execPath;
    if (binary.endsWith("/bun")) {
      console.error("daemon install requires the compiled norma binary (Task 16); in dev use: norma daemon run");
      process.exit(1);
    }
    await installDaemon(binary, resolveNormaHome());
    console.log(`${AQUA}installed launchd agent${RESET} — daemon starts at login and stays alive`);
    break;
  }
  case "daemon uninstall": {
    const { uninstallDaemon } = await import("./launchd");
    await uninstallDaemon();
    console.log("launchd agent removed");
    break;
  }
  case "daemon status": {
    const { daemonStatus } = await import("./launchd");
    console.log(await daemonStatus());
    break;
  }
  case "login": {
    const { KeychainSecretStore, CodexAuthStore, runLoginFlow, CODEX, OPENAI_API_KEY_SECRET } = await import("@norma/core");
    const secrets = new KeychainSecretStore();
    if (process.argv.includes("--api-key")) {
      const key = (await readSecret("Paste your OpenAI API key: ")).trim();
      if (!key.startsWith("sk-")) { console.error("that does not look like an API key"); process.exit(1); }
      await secrets.set(OPENAI_API_KEY_SECRET, key);
      console.log(`${AQUA}API key stored in Keychain${RESET} — set provider type in ~/.norma/settings.json (openai-compatible)`);
      break;
    }
    const tokens = await runLoginFlow({
      clientId: CODEX.clientId,
      authorizeUrl: CODEX.authorizeUrl,
      tokenUrl: CODEX.tokenUrl,
      callbackPort: CODEX.callbackPort,
      scope: CODEX.scope,
      openBrowser: async (url) => { Bun.spawn(["open", url]); },
    });
    await new CodexAuthStore(secrets).save(tokens);
    console.log(`${AQUA}◍ signed in with ChatGPT${RESET} ${DIM}(account ${tokens.accountId ?? "unknown"})${RESET}`);
    break;
  }
  case "logout": {
    const { KeychainSecretStore, CODEX_SECRET_NAMES } = await import("@norma/core");
    const secrets = new KeychainSecretStore();
    // Phase 1a simplification: SecretStore gains delete() in 1b — empty value de-authorizes everywhere today.
    for (const name of Object.values(CODEX_SECRET_NAMES)) {
      await secrets.set(name, "");
    }
    console.log("signed out");
    break;
  }
  case "provider": {
    const { loadSettings, resolveNormaHome } = await import("@norma/core");
    const s = loadSettings(join(resolveNormaHome(), "settings.json"));
    console.log(`${AQUA}${s.provider.type}${RESET} ${DIM}model ${s.provider.model}${RESET}`);
    break;
  }
  case "init": {
    await runTurnSession({ promptOverride: INIT_PROMPT, forceAuto: true, chat: false }); // force auto: writes NORMA.md without approval prompts
    break;
  }
  case "resume": {
    const sid = process.argv[3];
    if (!sid) { // picker: list resumable sessions
      const c = await connect("cli-resume");
      const rows = (await c.listSessions()).sessions;
      if (!rows.length) console.log("no sessions yet");
      for (const r of rows) console.log(`${r.sessionId}  ${DIM}${r.scope}  ${r.lastSeq} events${process.stdout.isTTY && r.title ? ` — ${r.title}` : ""}${RESET}`);
      c.close(); process.exit(0);
    }
    const text = process.argv.slice(4).join(" ");
    if (!text) {
      // No message → resume INTO chat mode on this session (§0). runTurnSession does its own
      // existence check + "↻ resuming …" line; policy seeds from flags (default ask).
      await runTurnSession({ existingSessionId: sid, chat: true });
    }
    await runTurnSession({ promptOverride: text, forceAuto: true, existingSessionId: sid, chat: false }); // continue the existing session (auto, one-shot)
    break;
  }
  case "provider-smoke": {
    const { loadSettings, resolveNormaHome, createProvider, KeychainSecretStore } = await import("@norma/core");
    const s = loadSettings(join(resolveNormaHome(), "settings.json"));
    const active = await createProvider(s, new KeychainSecretStore());
    const promptIdx = process.argv.indexOf("--prompt");
    const prompt = promptIdx > 0 ? process.argv[promptIdx + 1]! : "Reply with exactly: norma provider smoke OK";
    console.log(`${DIM}provider=${active.provider.id} model=${active.model}${RESET}`);
    let text = "";
    for await (const e of active.provider.streamTurn({
      model: active.model,
      input: [{ type: "message", role: "user", content: prompt }],
    })) {
      if (e.type === "text_delta") { text += e.delta; process.stdout.write(e.delta); }
      else if (e.type === "error") { console.error(`\n${e.code}: ${e.message}`); process.exit(1); }
      else if (e.type === "usage") console.log(`\n${DIM}usage: ${e.inputTokens} in / ${e.outputTokens} out${RESET}`);
    }
    process.exit(text.length > 0 ? 0 : 1);
  }
  default:
    console.log(`norma (Phase 1b-ii-d) — commands:
  daemon run | daemon install | daemon uninstall | daemon status
  ping | sessions | send <sessionId|new> <text> | watch <sessionId> | add-dir <sessionId> <path> [--persist] | cd <sessionId> <path>
  steer <sessionId> <text> | interrupt <sessionId> | compact <sessionId>
  resume [id] [msg]   list sessions, or continue an existing one
  trust <dir> [--list]
  skills                                          list discovered skills for this directory
  mcp                                              list configured MCP servers and their tools
  plugin list | install <git-url> [name] | enable <name> | disable <name> | remove <name>
  bg list <session> | bg peek <session> <taskId> | bg kill <session> <taskId>
  login [--api-key] | logout | provider | provider-smoke [--prompt <text>]
  init                                            generate/update NORMA.md by surveying the project
  -p "<prompt>" [--auto|--plan] [--trust|--no-trust]   headless agent turn (asks for tool approval unless --auto/--plan)`);
  }
}
