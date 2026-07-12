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

import React, { useEffect, useMemo, useState } from "react";
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
}: ComposerProps) {
  // `policy` stays a prop (callers/tests still pass it; `<Footer>`, a sibling, is the one that
  // renders it) — this component no longer renders it directly, matching `task-list.tsx`'s
  // `void nowMs;` convention for an intentionally-unused-here prop.
  void policy;
  const [state, setState] = useState<InputState>({ text: "", cursor: 0 });
  const [lastEscMs, setLastEscMs] = useState<number | null>(null);
  const effectiveHistoryPath = historyPath ?? defaultHistoryPath();

  // Load prompt history once per mount (the App never remounts a live composer, so "once" here
  // really does mean "for this composer's whole lifetime") — a lazy useState initializer, not an
  // effect, since there's no cleanup and no need to re-run on every render.
  const [historyEntries] = useState(() => loadHistory(effectiveHistoryPath, sessionId));
  const historyNav = useMemo(() => makeHistoryNav(historyEntries), [historyEntries]);

  // T3 raw side-channel (see the file-top doc comment) — Home/End/Backspace/Forward-Delete only.
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    if (disabled || !internal_eventEmitter) return;
    const onRawInput = (chunk: Buffer | string) => {
      const seq = typeof chunk === "string" ? chunk : chunk.toString();
      if (HOME_SEQS.has(seq)) { setState(home); return; }
      if (END_SEQS.has(seq)) { setState(end); return; }
      if (BACKSPACE_SEQS.has(seq)) { setState(backspace); return; }
      if (DELETE_SEQS.has(seq)) { setState(del); return; }
    };
    internal_eventEmitter.on("input", onRawInput);
    return () => { internal_eventEmitter.off("input", onRawInput); };
  }, [disabled, internal_eventEmitter]);

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
        if (state.text.length === 0) return; // never submit/steer an empty buffer
        const text = state.text;
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
  );
}
