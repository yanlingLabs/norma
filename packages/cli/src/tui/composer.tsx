/** `<Composer>` (Phase 3a Task 4) — the interactive input line: buffer, submit/steer, esc-interrupt,
 *  shift+tab policy-cycle. Presentational only, per the brief's ambiguity resolution #4 — it renders
 *  the given `policy` and forwards key decisions via callbacks; the parent (a LATER task, T6) owns
 *  the actual policy value, the setPolicy RPC, and the one-RPC-at-a-time in-flight guard.
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
 *  Renders the `› {buffer}▌` prompt line (cursor block) plus a policy indicator mirroring
 *  `task-block.ts`'s `renderModeBar` wording (resolution #5) — Ink owns the coloring via `<Text>`
 *  spans instead of splicing in that function's raw ANSI bytes, the same choice `<StatusLine>`
 *  (Task 3) made over `renderStatusLine`. */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalPolicy } from "@norma/protocol";
import { footerKeyAction } from "../keys";
import type { FooterSelection } from "../task-block";

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
    <Box flexDirection="column">
      <Text>
        › {buffer}▌
      </Text>
      <Text>
        <Text color="blue">▶▶ {policy} mode</Text>
        <Text dimColor> (shift+tab to cycle) · esc to interrupt</Text>
      </Text>
    </Box>
  );
}
