/** `<Footer>` (Phase 3b Task 5) — the CC-shaped single dim hint line beneath the composer: an
 *  approval-policy mode indicator (plan/auto, colored per `theme.planMode`/`theme.autoAccept`),
 *  an `esc to interrupt` hint while a turn runs, and an agents pill (`N agent(s) · ctrl+t`) when
 *  any subagents are live — segments joined with `" · "`. When none of those render, a fallback
 *  `shift+tab to cycle modes` hint keeps the line non-empty (cc-ui-study-chrome.md §1's
 *  `PromptInputFooterLeftSide` empty-state hint, adapted).
 *
 *  Pure — no client, no timers; `policy`/`running`/`agents` are all caller-supplied snapshots. */

import React from "react";
import { Text } from "ink";
import type { ApprovalPolicy } from "@norma/protocol";
import { theme } from "./theme";
import type { AgentRow } from "./state";

export interface FooterProps {
  policy: ApprovalPolicy;
  running: boolean;
  agents: AgentRow[];
}

export function Footer({ policy, running, agents }: FooterProps) {
  const segments: React.ReactNode[] = [];

  if (policy === "plan") {
    segments.push(
      <Text key="mode" color={theme.planMode}>
        ⏸ plan mode on (shift+tab to cycle)
      </Text>,
    );
  } else if (policy === "auto") {
    segments.push(
      <Text key="mode" color={theme.autoAccept}>
        ⏵⏵ auto mode on (shift+tab to cycle)
      </Text>,
    );
  }

  if (running) segments.push(<Text key="interrupt">esc to interrupt</Text>);

  if (agents.length > 0) {
    const noun = agents.length === 1 ? "agent" : "agents";
    segments.push(
      <Text key="agents">
        {agents.length} {noun} · ctrl+t
      </Text>,
    );
  }

  if (segments.length === 0) {
    segments.push(<Text key="fallback">shift+tab to cycle modes</Text>);
  }

  return (
    <Text dimColor>
      {segments.map((segment, i) => (
        <Text key={`slot-${i}`}>
          {i > 0 ? " · " : ""}
          {segment}
        </Text>
      ))}
    </Text>
  );
}
