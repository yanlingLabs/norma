/** `<Composer>` (Phase 3a Task 4; re-skinned Phase 3b Task 5) — the interactive input line:
 *  buffer, submit/steer, esc-interrupt, shift+tab policy-cycle. Presentational only, per the
 *  brief's ambiguity resolution #4 — it renders the given `policy` and forwards key decisions via
 *  callbacks; the parent (a LATER task, T6) owns the actual policy value, the setPolicy RPC, and
 *  the one-RPC-at-a-time in-flight guard.
 *
 *  Ink's `useInput` hands the handler an already-parsed `key` object, never keys.ts's raw
 *  escape-sequence strings — so `decodeKey` isn't directly reusable here. Ambiguity resolution #1:
 *  a tiny adapter maps Ink's `key` to `decodeKey`'s return enum, then feeds that into
 *  `footerKeyAction` with a constant `focusIndex: null` selection, keeping esc→interrupt and
 *  shiftTab→cyclePolicy in lockstep with the legacy raw-stdin decision table instead of hardcoding
 *  them here. (Footer focus navigation — up/down/select — is a later task; this component never
 *  has footer focus, hence the fixed `focusIndex: null` / empty `rowThreadIds`.)
 *
 *  Enter/backspace/the buffer itself are this component's OWN state (`useState`), per resolution
 *  #2: Enter on a non-empty buffer steers (`running`) or submits (idle), then clears the buffer;
 *  Enter on an empty buffer is a no-op (never submits/steers ""). Per resolution #3, `disabled` (a
 *  pending card owns input) is wired via `useInput`'s `isActive` so the listener isn't attached at
 *  all while disabled — every key is ignored, not just Enter.
 *
 *  Phase 3b T5 RENDER-ONLY rewrite (cc-ui-study-chrome.md §1): the key-handling `useInput` block
 *  above this comment is UNCHANGED from 3a. Only the returned JSX changed — an "open" prompt (bare
 *  top+bottom rounded rules, no side walls) instead of a full box, a `❯ ` prompt glyph (dimmed
 *  while a turn runs) instead of `›`, and the buffer + block cursor `▌`. The old inline mode-bar
 *  line moved OUT of this component: `<Footer>` (this task) now owns policy/hint rendering. */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalPolicy } from "@norma/protocol";
import { footerKeyAction } from "../keys";
import type { FooterSelection } from "../task-block";
import { theme } from "./theme";

// The composer never has footer keyboard focus (that's a later task) — this is the one constant
// FooterSelection it ever passes to footerKeyAction, selecting the "no footer focus" branch of its
// decision table (down/esc/shiftTab only; rowThreadIds is irrelevant on that branch, hence []).
const NO_FOOTER_FOCUS: FooterSelection = { selectedThreadId: "main", focusIndex: null };

export interface ComposerProps {
  running: boolean;
  policy: ApprovalPolicy;
  onSubmit: (text: string) => void;
  onSteer: (text: string) => void;
  onInterrupt: () => void;
  onCyclePolicy: () => void;
  disabled?: boolean;
}

export function Composer({ running, policy, onSubmit, onSteer, onInterrupt, onCyclePolicy, disabled }: ComposerProps) {
  // `policy` stays a prop (callers/tests still pass it; `<Footer>`, a sibling this task adds, is
  // now the one that renders it) — this component no longer renders it directly, matching
  // `task-list.tsx`'s `void nowMs;` convention for an intentionally-unused-here prop.
  void policy;
  const [buffer, setBuffer] = useState("");

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
      if (action.kind === "interrupt") {
        onInterrupt();
        return;
      }
      if (action.kind === "cyclePolicy") {
        onCyclePolicy();
        return;
      }

      if (k === "enter") {
        if (buffer.length === 0) return; // never submit/steer an empty buffer
        if (running) onSteer(buffer);
        else onSubmit(buffer);
        setBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      // Plain printable input (a single char, or a whole pasted string delivered as one event —
      // Ink's own doc for useInput). Ctrl/meta combos carry no printable text of their own here
      // (e.g. ctrl+c arrives as input "c", key.ctrl true) so they're excluded from the buffer.
      if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
    },
    { isActive: !disabled },
  );

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
      <Text dimColor={running}>{"❯ "}</Text>
      <Text>
        {buffer}
        {"▌"}
      </Text>
    </Box>
  );
}
