/** `<PendingCards>` (Phase 3a Task 5) — the approval / ask_user-question / plan cards that TAKE
 *  OVER input while `TuiState.pending` is set (the App mounts this component instead of, and
 *  passes the composer `disabled` alongside, `<Composer>` — Task 4's `disabled` wiring already
 *  covers the composer side of that hand-off). Each card owns its OWN `useInput` buffer (Task 4's
 *  same pattern: buffer/backspace/printable-char state, Enter cooks the line) since there is no
 *  `readLine()` to `await` in Ink's render-driven world — main.ts's async per-card loops
 *  (packages/cli/src/main.ts:531-616) are reproduced here as per-card state machines instead.
 *
 *  Byte-parity source of truth is main.ts's three branches:
 *   - approval (main.ts:532): `approve {toolName}? {summary} [y/N] ` — Enter cooks
 *     `onApprove(callId, line.trim().toLowerCase() === "y")` (main.ts:724 — case-insensitive "y"
 *     only; "n"/"yes"/anything else is false).
 *   - plan (main.ts:609-614): "Plan" header, the plan text, the fixed 3-line menu, then
 *     `onPlan(callId, parsePlanResponse(line))` — parsePlanResponse (plan-response.ts) already
 *     encodes the "1"/"2"/"3 <reason>"/free-text-as-rejection rules; not re-derived here.
 *   - question / ask_user (main.ts:557-602): the one non-trivial card. Legacy loops
 *     `for (const q of e.questions)` with THREE sequential readLine()s per question (answer,
 *     optionally re-prompted as "Other" free text, then an optional note) and calls
 *     `askUserRespond` exactly once after the LAST question's note. Reproduced below as a
 *     3-phase-per-question state machine (`qi` + `phase`) so the same three prompts/transitions
 *     fire in the same order for however many questions the array holds, and `onAnswer` fires
 *     exactly once, at the very end — never per-question. */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PendingCard } from "./state";
import { formatOptionLines, isOtherChoice, parseQuestionAnswer } from "../questions";
import { parsePlanResponse } from "../plan-response";

export interface AnswerPayload {
  answers: Record<string, string>;
  notes?: Record<string, string>;
}

export interface PendingCardsProps {
  pending: PendingCard;
  onApprove: (callId: string, yes: boolean) => void;
  onAnswer: (callId: string, payload: AnswerPayload) => void;
  onPlan: (callId: string, resp: ReturnType<typeof parsePlanResponse>) => void;
}

/** Shared "cooked line" input handling every card below uses identically: printable chars append
 *  to the buffer, backspace/delete pops the last char (safe on empty), Enter is handled by the
 *  caller. Factored out once rather than re-typed per card (approval/plan/question all need it). */
function useBufferedInput(onEnter: (line: string) => void) {
  const [buffer, setBuffer] = useState("");
  useInput((input, key) => {
    if (key.return) {
      onEnter(buffer);
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
  });
  return [buffer, setBuffer] as const;
}

function ApprovalCard({ pending, onApprove }: { pending: Extract<PendingCard, { kind: "approval" }>; onApprove: PendingCardsProps["onApprove"] }) {
  const [buffer, setBuffer] = useBufferedInput((line) => {
    onApprove(pending.callId, line.trim().toLowerCase() === "y");
    setBuffer("");
  });

  return (
    <Text>
      approve {pending.toolName}? <Text dimColor>{pending.summary}</Text> [y/N] {buffer}
    </Text>
  );
}

function PlanCard({ pending, onPlan }: { pending: Extract<PendingCard, { kind: "plan" }>; onPlan: PendingCardsProps["onPlan"] }) {
  const [buffer, setBuffer] = useBufferedInput((line) => {
    onPlan(pending.callId, parsePlanResponse(line));
    setBuffer("");
  });

  return (
    <Box flexDirection="column">
      <Text>Plan</Text>
      <Text>{pending.plan}</Text>
      <Text>{"  1) approve — I'll approve each edit"}</Text>
      <Text>{"  2) approve + auto-accept edits"}</Text>
      <Text>{"  3) reject (type: 3 <reason>)"}</Text>
      <Text>choose (number or text): {buffer}</Text>
    </Box>
  );
}

// Legacy `ask_user` question shape (main.ts's `e.questions` elements) — narrowed from the
// PendingCard's `questions: unknown[]` at render time, not re-declared in the protocol.
interface LegacyOption {
  label: string;
  description?: string;
  preview?: string;
}
interface LegacyQuestion {
  header: string;
  question: string;
  options: LegacyOption[];
  multiSelect: boolean;
}

type QuestionPhase = "answer" | "otherAnswer" | "note";

function QuestionCard({ pending, onAnswer }: { pending: Extract<PendingCard, { kind: "question" }>; onAnswer: PendingCardsProps["onAnswer"] }) {
  const questions = pending.questions as LegacyQuestion[];
  const [qi, setQi] = useState(0);
  const [phase, setPhase] = useState<QuestionPhase>("answer");
  const [buffer, setBuffer] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const q = questions[qi];

  useInput(
    (input, key) => {
      if (!q) return;
      if (key.return) {
        if (phase === "answer") {
          if (isOtherChoice(buffer, q.options.length)) {
            setPhase("otherAnswer");
            setBuffer("");
            return;
          }
          const answer = parseQuestionAnswer(buffer, q.options.map((o) => o.label), q.multiSelect);
          setAnswers((a) => ({ ...a, [q.question]: answer }));
          setPhase("note");
          setBuffer("");
          return;
        }
        if (phase === "otherAnswer") {
          setAnswers((a) => ({ ...a, [q.question]: buffer.trim() }));
          setPhase("note");
          setBuffer("");
          return;
        }
        // phase === "note": optional free-text note, then advance (or finish).
        const trimmedNote = buffer.trim();
        const nextNotes = trimmedNote !== "" ? { ...notes, [q.question]: trimmedNote } : notes;
        if (trimmedNote !== "") setNotes(nextNotes);

        const nextQi = qi + 1;
        if (nextQi < questions.length) {
          setQi(nextQi);
          setPhase("answer");
          setBuffer("");
        } else {
          onAnswer(pending.callId, {
            answers,
            ...(Object.keys(nextNotes).length > 0 ? { notes: nextNotes } : {}),
          });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
    },
    { isActive: !!q },
  );

  if (!q) return null;

  const optionLines = q.options
    .flatMap((o, i) => formatOptionLines(i + 1, o))
    .map((line) => line.replace(/\n$/, ""));
  const otherLine = `  ${q.options.length + 1}) Other (type your answer)`;
  const promptText =
    phase === "answer"
      ? q.multiSelect
        ? "choose (comma-separated numbers or text): "
        : "choose (number or text): "
      : phase === "otherAnswer"
        ? "your answer: "
        : "note (enter to skip): ";

  return (
    <Box flexDirection="column">
      <Text>
        {q.header} — {q.question}
      </Text>
      {optionLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Text>{otherLine}</Text>
      <Text>
        {promptText}
        {buffer}
      </Text>
    </Box>
  );
}

export function PendingCards({ pending, onApprove, onAnswer, onPlan }: PendingCardsProps) {
  switch (pending.kind) {
    case "approval":
      return <ApprovalCard pending={pending} onApprove={onApprove} />;
    case "question":
      return <QuestionCard pending={pending} onAnswer={onAnswer} />;
    case "plan":
      return <PlanCard pending={pending} onPlan={onPlan} />;
    default: {
      const _exhaustive: never = pending;
      return _exhaustive;
    }
  }
}
