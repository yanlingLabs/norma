/** `<Composer>` (Phase 3a Task 4; re-skinned Phase 3b Task 5; Phase 3c Task 3 — real cursor/editing
 *  model + disk-backed prompt history + double-esc clear). The interactive input line: cursor
 *  navigation and mid-text editing, ↑/↓ prompt-history recall, submit/steer, esc-interrupt (or
 *  double-esc-clear), shift+tab policy-cycle. Presentational only, per 3a's ambiguity resolution
 *  #4 — it renders the given `policy` and forwards key decisions via callbacks; the parent owns the
 *  actual policy value, the setPolicy RPC, and the one-RPC-at-a-time in-flight guard.
 *
 *  Ink's `useInput` hands the handler an already-parsed `key` object, never keys.ts's raw
 *  escape-sequence strings — so `decodeKey` isn't directly reusable here. Ambiguity resolution #1:
 *  a tiny adapter maps Ink's `key` to `decodeKey`'s return enum, then feeds that into
 *  `footerKeyAction` with a constant `focusIndex: null` selection, keeping shiftTab→cyclePolicy in
 *  lockstep with the legacy raw-stdin decision table instead of hardcoding it here. (Footer focus
 *  navigation — up/down/select — is a later task; this component never has footer focus, hence the
 *  fixed `focusIndex: null` / empty `rowThreadIds`. Esc no longer routes through `footerKeyAction`'s
 *  "interrupt" branch unconditionally — see the T3 esc-precedence note below.)
 *
 *  T3 ambiguity — Home/End/Backspace/Forward-Delete: Ink v5's `Key` type has NO field at all for
 *  Home/End (only up/down/left/right/pageUp/pageDown/return/escape/tab/backspace/delete/ctrl/
 *  shift/meta exist — see ink/build/hooks/use-input.js), and `nonAlphanumericKeys` clears `input` to
 *  "" for them too, so they're entirely invisible through the normal `(input, key)` callback. Worse,
 *  the real Backspace key (sends `\x7f` in raw mode on effectively every modern terminal) and the
 *  real Forward-Delete key (`\x1b[3~`) BOTH parse to `key.name === "delete"` — parse-keypress.js
 *  folds them onto the same `key.delete` flag, so that flag alone can't tell them apart either. We
 *  read the exact same raw chunk Ink's own `useInput` consumes — via `useStdin().internal_eventEmitter`,
 *  the "input" event `useInput` itself subscribes to — purely to disambiguate these four keys by
 *  their literal byte sequence. Every other key (insert, arrows, enter, esc, ctrl+a/e, word-jumps,
 *  history ↑/↓) stays on the ordinary `useInput` path below; the two listeners never double-fire on
 *  the same keystroke because Ink clears `input` and leaves every `key.*` flag unhelpful for these
 *  four cases anyway (nothing in the ordinary path reacts to them).
 *
 *  Phase 3b T5 render note (cc-ui-study-chrome.md §1) still holds: an "open" prompt (bare top+bottom
 *  rounded rules, no side walls), a `❯ ` prompt glyph dimmed while a turn runs (glyph ONLY — the
 *  user's typed text never dims). T3 replaces the old trailing block-cursor glyph with a real
 *  cursor position: `❯ ` + `before` + inverse(`at` or a space) + `after`, per `renderWithCursor`
 *  (see `input-model.ts`) — all as ONE root `<Text>`, with the glyph's dim expressed as raw ANSI
 *  codes INSIDE the root string (see the render comment below for why an Ink layout bug forces
 *  that shape). */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { homedir } from "node:os";
import { join } from "node:path";
import { Box, Text, useInput, useStdin } from "ink";
import { Chalk } from "chalk";
import type { ApprovalPolicy } from "@norma/protocol";
import { footerKeyAction } from "../keys";
import type { FooterSelection } from "../task-block";
import { theme } from "./theme";
import {
  backspace,
  del,
  end,
  home,
  insert,
  left,
  right,
  renderWithCursor,
  wordLeft,
  wordRight,
  type InputState,
} from "./input-model";
import { appendHistory, loadHistory, makeHistoryNav } from "./history-store";
import { COMMANDS, filterCommands, parseSlashInput } from "./commands";
import { CompletionMenu } from "./completion-menu";

// The composer never has footer keyboard focus (that's a later task) — this is the one constant
// FooterSelection it ever passes to footerKeyAction, selecting the "no footer focus" branch of its
// decision table (down/esc/shiftTab only; rowThreadIds is irrelevant on that branch, hence []).
const NO_FOOTER_FOCUS: FooterSelection = { selectedThreadId: "main", focusIndex: null };

const DOUBLE_ESC_WINDOW_MS = 800;

// See the T3 doc-comment above: raw ANSI sequences for the four keys Ink's `key` object can't (or
// can't unambiguously) represent. Sets, not a single string each, to cover the handful of common
// terminal variants (xterm/vt220/rxvt) for each logical key.
const HOME_SEQS = new Set(["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"]);
const END_SEQS = new Set(["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]);
const BACKSPACE_SEQS = new Set(["\x7f", "\b", "\x1b\x7f", "\x1b\b"]);
const DELETE_SEQS = new Set(["\x1b[3~", "\x1b[3^", "\x1b[3$"]);

// Fixed-level truecolor Chalk instance — same convention (and reason) as flatten-blocks.ts /
// markdown.ts: the ambient default export downgrades to level 0 under a non-TTY (tests), which
// would silently strip the dim codes the render below bakes into its string.
const ansi = new Chalk({ level: 3 });

function defaultHistoryPath(): string {
  return join(homedir(), ".norma", "history.jsonl");
}

/** Phase 3d T2 — pure predicate: is the `/`-slash-command menu open for this `InputState`, and if
 *  so what's the in-progress query? Slash mode is active exactly when the text starts with "/" AND
 *  the cursor sits inside the first whitespace-delimited token — so typing a space, or moving the
 *  cursor past it, closes the menu automatically with NO separate flag to keep in sync (the "open"
 *  state is entirely a function of `state`). `null` means "not in slash mode". Exported (not baked
 *  into the component) so T3's analogous "@"-file predicate can share this shape, and so it's
 *  independently testable. */
export function computeSlashQuery(state: InputState): string | null {
  const { text, cursor } = state;
  if (!text.startsWith("/")) return null;
  const firstWs = text.search(/\s/);
  const tokenEnd = firstWs === -1 ? text.length : firstWs;
  if (cursor < 1 || cursor > tokenEnd) return null;
  return text.slice(1, cursor);
}

export interface ComposerProps {
  running: boolean;
  policy: ApprovalPolicy;
  onSubmit: (text: string) => void;
  onSteer: (text: string) => void;
  onInterrupt: () => void;
  onCyclePolicy: () => void;
  disabled?: boolean;
  /** Injected clock (App's ticking `nowMs`) — the ONLY time source the double-esc-clear window
   *  uses; this component never calls `Date.now` itself. */
  nowMs: number;
  /** Scopes prompt history — "this session's entries first" (see `history-store.ts`). Optional;
   *  defaults to "" (the App threads through its real sessionId; tests may omit it entirely since
   *  the priority behavior itself is covered at the history-store level). */
  sessionId?: string;
  /** Injectable history file location (tests pass a temp path); defaults to `~/.norma/history.jsonl`. */
  historyPath?: string;
  /** Fires on the FIRST esc press against non-empty text ("Esc again to clear"); a later task wires
   *  this into the footer's hint line. Optional so existing call sites need no changes. */
  onHint?: (hint: string) => void;
  /** T5: fires on mount and every text/cursor edit, mirroring the internal `InputState` up to the
   *  parent — NOT a controlled-component wire (the parent never feeds a value back in). App.tsx
   *  uses this to (a) compute `bottomBarRows`' wrap-aware composer height from the SAME state Ink
   *  is about to lay out, on the SAME render pass, and (b) decide ctrl+D exit-eligibility ("only
   *  when the composer is empty"). Optional so every existing call site is unaffected. */
  onStateChange?: (state: InputState) => void;
  /** 3c whole-branch review item 2 (spec §5): Home/End pressed while the text is EMPTY call these
   *  (App wires them to transcript scroll-to-top / scroll-to-bottom) INSTEAD of the cursor ops the
   *  raw side-channel otherwise runs — the side-channel is the single consumer of those byte
   *  sequences, so routing here (not a second listener) keeps one owner per key. With any text in
   *  the buffer, Home/End keep their cursor semantics and these never fire. Optional: when omitted
   *  (legacy call sites/tests), empty-text Home/End fall through to the cursor ops as before
   *  (harmless no-ops on empty text). */
  onScrollTop?: () => void;
  onScrollBottom?: () => void;
  /** Phase 3d T2: the composer's Enter handler consults `parseSlashInput`/`COMMANDS` FIRST — a
   *  buffer that parses as a slash command NEVER reaches `onSubmit`/`onSteer` (it never goes to the
   *  model). App wires this to `runCommand(ctx, text)` (fire-and-forget; the runner's own note
   *  lands in the transcript asynchronously via `CommandCtx.appendNote`). Optional so legacy call
   *  sites without command support are unaffected (a slash-shaped buffer with no `onRunCommand`
   *  wired still clears/is "handled" — it just runs nothing). */
  onRunCommand?: (text: string) => void;
  /** Phase 3d T2: fires on mount and every time the completion menu's VISIBLE row count changes —
   *  `min(6, filteredCount)` while open, `0` while closed — mirroring the same "push derived UI
   *  state up to the parent" convention `onStateChange` (T5) already uses. App.tsx needs this
   *  (rather than deriving it from the mirrored `InputState` alone) because Esc-dismissing the menu
   *  closes it WITHOUT changing `text`/`cursor` — a state.ts fact App can't observe any other way. */
  onMenuRowsChange?: (n: number) => void;
  /** Terminal width — feeds the completion menu's hard JS truncation (`completion-menu.tsx`'s file
   *  doc: never Yoga-wrap, so `bottomBarRows`' per-row budget stays exact). Defaults to 80, the same
   *  fallback `app.tsx`'s own `readCols` uses. */
  columns?: number;
}

export function Composer({
  running,
  policy,
  onSubmit,
  onSteer,
  onInterrupt,
  onCyclePolicy,
  disabled,
  nowMs,
  sessionId = "",
  historyPath,
  onHint,
  onStateChange,
  onScrollTop,
  onScrollBottom,
  onRunCommand,
  onMenuRowsChange,
  columns = 80,
}: ComposerProps) {
  // `policy` stays a prop (callers/tests still pass it; `<Footer>`, a sibling, is the one that
  // renders it) — this component no longer renders it directly, matching `task-list.tsx`'s
  // `void nowMs;` convention for an intentionally-unused-here prop.
  void policy;
  const [state, setState] = useState<InputState>({ text: "", cursor: 0 });
  const [lastEscMs, setLastEscMs] = useState<number | null>(null);
  const effectiveHistoryPath = historyPath ?? defaultHistoryPath();

  // T5: mirror state up to the parent on mount + every edit (see the prop doc comment above).
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);

  // Load prompt history once per mount (the App never remounts a live composer, so "once" here
  // really does mean "for this composer's whole lifetime") — a lazy useState initializer, not an
  // effect, since there's no cleanup and no need to re-run on every render.
  const [historyEntries] = useState(() => loadHistory(effectiveHistoryPath, sessionId));
  const historyNav = useMemo(() => makeHistoryNav(historyEntries), [historyEntries]);

  // ---- Phase 3d T2: slash-command completion menu state ---------------------------------------
  // `rawQuery` is a PURE function of `state` (see `computeSlashQuery`'s doc) — the menu's "open"
  // condition needs no separate flag to track in the common case. Esc, though, must be able to
  // dismiss the menu WITHOUT touching `text`/`cursor` (so text editing keeps working normally while
  // it stays shut) — `dismissedQuery` records exactly which query string was last Esc-dismissed;
  // the moment `rawQuery` changes to anything else (a new keystroke), the "adjusting state during
  // render" block below clears it, reopening the menu automatically.
  const rawQuery = useMemo(() => computeSlashQuery(state), [state.text, state.cursor]);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const lastRawQueryRef = useRef<string | null>(null);
  if (rawQuery !== lastRawQueryRef.current) {
    // React's sanctioned "adjust state during render when a derived value changes" pattern (guarded
    // so it only ever fires once per actual change, never loops): resets BOTH the Esc-dismissal and
    // the selection the instant the underlying query changes, so the very next keystroke/keypress
    // already sees the corrected value — no extra render tick, unlike an effect.
    lastRawQueryRef.current = rawQuery;
    if (dismissedQuery !== null) setDismissedQuery(null);
    if (selected !== 0) setSelected(0);
  }
  const filtered = useMemo(() => (rawQuery !== null ? filterCommands(rawQuery) : []), [rawQuery]);
  const slashOpen = rawQuery !== null && dismissedQuery !== rawQuery;
  const boundedSelected = filtered.length > 0 ? Math.min(selected, filtered.length - 1) : 0;
  const menuItems = useMemo(
    () => filtered.map((c) => ({ label: `/${c.name}${c.args ? ` ${c.args}` : ""}`, hint: c.description })),
    [filtered],
  );

  // Mirrors the menu's visible row count up to the parent (see the `onMenuRowsChange` prop doc) —
  // fires on mount too (same "T5" convention as the `onStateChange` effect above), including the
  // Esc-dismissed transition (which changes no `InputState` field app.tsx could otherwise observe).
  useEffect(() => {
    onMenuRowsChange?.(slashOpen ? Math.min(6, filtered.length) : 0);
  }, [slashOpen, filtered.length, onMenuRowsChange]);

  // Tab AND the "enter completes a partial" case share this: fill the buffer with the selected
  // command's full name (`/name args` gets a trailing space so the cursor lands ready to type an
  // arg; a no-arg command doesn't — the cursor sitting right after the name with no space keeps the
  // menu OPEN, since `computeSlashQuery` still sees the cursor inside the first token). A no-op
  // when there's nothing filtered to complete to.
  function completeSelected(): void {
    const cmd = filtered[boundedSelected];
    if (!cmd) return;
    const newText = `/${cmd.name}${cmd.args ? " " : ""}`;
    setState({ text: newText, cursor: newText.length });
  }

  // Whole-branch review item 2: the raw side-channel handler below runs from a closure created when
  // its effect last wired (its deps deliberately exclude `state`), so it reads text-emptiness at
  // EVENT time through a render-updated ref — the same event-time-read pattern app.tsx uses for its
  // viewport refs — rather than a stale closure snapshot.
  const textEmptyRef = useRef(state.text.length === 0);
  textEmptyRef.current = state.text.length === 0;

  // T3 raw side-channel (see the file-top doc comment) — Home/End/Backspace/Forward-Delete only.
  // Home/End route to the App's transcript scroll callbacks when the text is EMPTY (spec §5; see the
  // onScrollTop/onScrollBottom prop doc), and to their cursor ops otherwise.
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    if (disabled || !internal_eventEmitter) return;
    const onRawInput = (chunk: Buffer | string) => {
      const seq = typeof chunk === "string" ? chunk : chunk.toString();
      if (HOME_SEQS.has(seq)) {
        if (textEmptyRef.current && onScrollTop) { onScrollTop(); return; }
        setState(home);
        return;
      }
      if (END_SEQS.has(seq)) {
        if (textEmptyRef.current && onScrollBottom) { onScrollBottom(); return; }
        setState(end);
        return;
      }
      if (BACKSPACE_SEQS.has(seq)) { setState(backspace); return; }
      if (DELETE_SEQS.has(seq)) { setState(del); return; }
    };
    internal_eventEmitter.on("input", onRawInput);
    return () => { internal_eventEmitter.off("input", onRawInput); };
  }, [disabled, internal_eventEmitter, onScrollTop, onScrollBottom]);

  useInput(
    (input, key) => {
      // Ink-key → decodeKey's enum adapter (ambiguity resolution #1).
      const k = key.escape
        ? "esc"
        : key.tab && key.shift
          ? "shiftTab"
          : key.return
            ? "enter"
            : key.upArrow
              ? "up"
              : key.downArrow
                ? "down"
                : "other";
      const action = footerKeyAction(k, NO_FOOTER_FOCUS, []);
      if (action.kind === "cyclePolicy") {
        onCyclePolicy();
        return;
      }

      // ---- Phase 3d T2: slash-menu key gating — the SINGLE actor for ↑/↓/tab/esc while the menu
      // is open (history nav below, and the esc/double-esc state machine that follows, never also
      // see these same keystrokes while `slashOpen` — the binding "one actor per key" rule). Enter
      // deliberately falls through to the unified handler further down: it needs the exact same
      // known-command/partial-match decision whether or not the menu happens to still be open.
      if (slashOpen) {
        if (k === "esc") {
          // "esc closes the menu ONLY" — no double-esc bookkeeping (`lastEscMs`/`onHint`) runs at
          // all, and this wins even over precedence #1 (running-interrupt) below: while the menu is
          // open it owns Esc completely.
          setDismissedQuery(rawQuery);
          return;
        }
        if (k === "up") {
          setSelected((sel) => {
            const bounded = filtered.length > 0 ? Math.min(sel, filtered.length - 1) : 0;
            return Math.max(0, bounded - 1);
          });
          return;
        }
        if (k === "down") {
          setSelected((sel) => {
            const bounded = filtered.length > 0 ? Math.min(sel, filtered.length - 1) : 0;
            return filtered.length > 0 ? Math.min(filtered.length - 1, bounded + 1) : 0;
          });
          return;
        }
        if (key.tab && !key.shift) {
          completeSelected();
          return;
        }
      }

      if (k === "esc") {
        // Precedence #1 (UNCHANGED from 3a/3b): a running turn always interrupts on Esc, no matter
        // what's in the buffer.
        if (running) {
          onInterrupt();
          return;
        }
        // Precedence #2: idle + empty text — Esc stays inert (legacy idle-Esc parity, per app.tsx).
        if (state.text.length === 0) return;
        // Precedence #3: idle + non-empty text — double-esc-to-clear, timed off the `nowMs` prop
        // (never Date.now here).
        if (lastEscMs !== null && nowMs - lastEscMs <= DOUBLE_ESC_WINDOW_MS) {
          appendHistory(effectiveHistoryPath, { display: state.text, ts: nowMs, sessionId });
          setState({ text: "", cursor: 0 });
          setLastEscMs(null);
        } else {
          onHint?.("Esc again to clear");
          setLastEscMs(nowMs);
        }
        return;
      }

      if (k === "enter") {
        if (state.text.length === 0) return; // never submit/steer/run an empty buffer
        const text = state.text;
        // Phase 3d T2: the slash-command check runs FIRST — a buffer that parses as a slash
        // command never reaches onSubmit/onSteer (it never goes to the model).
        const parsed = parseSlashInput(text);
        if (parsed !== null) {
          const isKnown = COMMANDS.some((c) => c.name === parsed.cmd);
          if (!isKnown && slashOpen && filtered.length > 0) {
            // A "/partial" matching the currently-selected menu item -> complete it (exactly like
            // Tab), never run.
            completeSelected();
            return;
          }
          // A known command (with or without args), OR an unknown command with the menu already
          // closed (cursor past the first token) -> run it. `runCommand` (commands.ts, called by
          // App's onRunCommand) is what actually tells known from unknown and produces the
          // "Unknown command" note — this composer only decides WHETHER to run vs. complete.
          onRunCommand?.(text);
          appendHistory(effectiveHistoryPath, { display: text, ts: nowMs, sessionId });
          setState({ text: "", cursor: 0 });
          setLastEscMs(null);
          return;
        }
        if (running) onSteer(text);
        else onSubmit(text);
        appendHistory(effectiveHistoryPath, { display: text, ts: nowMs, sessionId });
        setState({ text: "", cursor: 0 });
        setLastEscMs(null); // a fresh line resets the double-esc window
        return;
      }

      if (k === "up") {
        const recalled = historyNav.up(state.text);
        if (recalled !== null) setState({ text: recalled, cursor: recalled.length });
        return;
      }
      if (k === "down") {
        const recalled = historyNav.down();
        if (recalled !== null) setState({ text: recalled, cursor: recalled.length });
        return;
      }

      if (key.ctrl && input === "a") { setState(home); return; }
      if (key.ctrl && input === "e") { setState(end); return; }
      if (key.leftArrow) { setState(key.ctrl || key.meta ? wordLeft : left); return; }
      if (key.rightArrow) { setState(key.ctrl || key.meta ? wordRight : right); return; }

      // Plain printable input (a single char, or a whole pasted string delivered as one event —
      // Ink's own doc for useInput). Backspace/Delete/Home/End never reach here — Ink forces
      // `input` to "" for all four (see the T3 doc comment above) — and ctrl/meta combos with no
      // dedicated branch above carry no printable text of their own (e.g. ctrl+c arrives as input
      // "c", key.ctrl true), so they stay excluded from the buffer.
      if (input && !key.ctrl && !key.meta) setState((s) => insert(s, input));
    },
    { isActive: !disabled },
  );

  const { before, at, after } = renderWithCursor(state);

  return (
    <>
      {/* Phase 3d T2: the completion menu renders ABOVE the open-rule box, never inside it — it's
       *  no part of the bordered composer's own single-root-Text layout (see the render note
       *  below), just a sibling that appears/disappears above it. */}
      {slashOpen ? <CompletionMenu items={menuItems} selected={boundedSelected} columns={columns} /> : null}
      <Box
        borderStyle="round"
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
        borderColor={theme.promptBorder}
        width="100%"
      >
        {/* ONE root <Text> with exactly ONE nested <Text> (the inverse cursor) — not two sibling
         *  Text nodes (the 3a/3b shape: a separate dimColor prompt Text next to a separate buffer
         *  Text). Ink v5.2.1's Yoga-backed layout mismeasures a bordered, width:100% Box's row on
         *  the FIRST render where MORE THAN ONE Text descendant has independent style/content
         *  (reproduced in isolation: 2 sibling Texts, or 1 root + 2 nested children, both glitch —
         *  garbled/truncated text, sometimes bleeding into the border row; 1 root + 1 nested child
         *  never does). To keep the reference behavior — ONLY the "❯ " glyph dims while a turn runs,
         *  never the user's typed text — the glyph's dim is baked into the root STRING as raw ANSI
         *  codes (`ansi.dim`, the module-level Chalk instance) instead of a styled <Text> child that
         *  would re-trigger the bug. Ink measures text width ANSI-aware (string-width), so the baked
         *  codes don't skew layout; verified clean on the bug's trigger case (first content frame
         *  after empty) in composer.test.tsx (n). */}
        <Text>
          {`${running ? ansi.dim("❯ ") : "❯ "}${before}`}
          <Text inverse>{at || " "}</Text>
          {after}
        </Text>
      </Box>
    </>
  );
}
