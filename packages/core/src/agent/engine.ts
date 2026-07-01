import type { NewSessionEvent, SessionEvent } from "@norma/protocol";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";
import type { Provider, ProviderEvent, TurnInputItem } from "../providers/types";
import type { ToolRegistry } from "./tools/registry";
import type { PermissionGate } from "./gate";
import type { ApprovalBroker } from "./approvals";

const MAIN_THREAD = "main";
const MAX_TOOL_ITERATIONS = 24; // runaway guard until 1b-ii budgets land

export const SYSTEM_PROMPT = [
  "You are Norma, an agentic assistant running on the user's Mac.",
  "You operate inside a session working directory; file tool paths are relative to it.",
  "Use the tools to accomplish the user's request, then reply with a concise summary.",
].join(" ");

export interface EngineConfig {
  store: SessionStore;
  hub: SessionHub;
  registry: ToolRegistry;
  gate: PermissionGate;
  broker: ApprovalBroker;
  provider: { provider: Provider; model: string };
  approvalTimeoutMs?: number; // default 5 min
}

export class AgentEngine {
  private runningTurns = new Set<string>();
  constructor(private readonly cfg: EngineConfig) {}

  /** True while a turn is executing for the session. */
  isRunning(sessionId: string): boolean { return this.runningTurns.has(sessionId); }

  async runTurn(sessionId: string): Promise<void> {
    if (this.runningTurns.has(sessionId)) throw new Error(`turn already running for ${sessionId}`);
    this.runningTurns.add(sessionId);
    try {
      await this.turn(sessionId);
    } finally {
      this.runningTurns.delete(sessionId);
    }
  }

  private emit(sessionId: string, event: NewSessionEvent): SessionEvent {
    return this.cfg.hub.append(sessionId, event); // hub.append: store.append + broadcast (added below)
  }

  private historyInput(sessionId: string): TurnInputItem[] {
    const input: TurnInputItem[] = [];
    for (const e of this.cfg.store.read(sessionId)) {
      if (e.type === "user_message") input.push({ type: "message", role: "user", content: e.text });
      else if (e.type === "assistant_message") input.push({ type: "message", role: "assistant", content: e.text });
      // Prior turns' tool calls are summarized by their assistant_message; current-turn
      // call/result items are threaded in-memory below. Compaction-aware assembly is 1c.
    }
    return input;
  }

  private async turn(sessionId: string): Promise<void> {
    const meta = this.cfg.store.meta(sessionId);
    const cwd = meta.cwd ?? process.cwd();
    const input = this.historyInput(sessionId);
    const usage = { inputTokens: 0, outputTokens: 0 };
    const threadId = MAIN_THREAD;

    this.emit(sessionId, { type: "turn_started", sessionId, threadId });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      let textBuf = "";
      const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
      let stop: "end_turn" | "tool_calls" | "aborted" | null = null;

      for await (const ev of this.cfg.provider.provider.streamTurn({
        model: this.cfg.provider.model,
        instructions: SYSTEM_PROMPT,
        input,
        tools: this.cfg.registry.specs(),
      })) {
        if (ev.type === "text_delta") textBuf += ev.delta;
        else if (ev.type === "tool_call") calls.push(ev);
        else if (ev.type === "usage") { usage.inputTokens += ev.inputTokens; usage.outputTokens += ev.outputTokens; }
        else if (ev.type === "done") stop = ev.stopReason;
        else if (ev.type === "error") {
          this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: ev.message });
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
          return;
        }
      }

      if (textBuf.length > 0) {
        this.emit(sessionId, { type: "assistant_message", sessionId, threadId, text: textBuf });
        input.push({ type: "message", role: "assistant", content: textBuf });
      }

      if (stop !== "tool_calls" || calls.length === 0) {
        this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: stop === "aborted" ? "aborted" : "end_turn", ...usage });
        return;
      }

      for (const call of calls) {
        this.emit(sessionId, { type: "tool_call", sessionId, threadId, callId: call.callId, name: call.name, argsJson: call.argsJson });
        input.push({ type: "function_call", callId: call.callId, name: call.name, argsJson: call.argsJson });

        let outcome: { output: string; isError: boolean };
        const decision = this.cfg.gate.evaluate(call.name, meta.approvalPolicy);
        if (decision === "ask") {
          // Register the wait BEFORE emitting: broadcast is synchronous, so a watcher that
          // resolves the approval as soon as it observes the event (see engine.test.ts) would
          // otherwise race broker.wait() and resolve into an empty pending-map slot, timing out.
          const waiting = this.cfg.broker.wait(sessionId, call.callId, this.cfg.approvalTimeoutMs ?? 5 * 60_000);
          this.emit(sessionId, {
            type: "approval_requested", sessionId, threadId, callId: call.callId, toolName: call.name,
            summary: `${call.name} ${call.argsJson.slice(0, 160)}`,
          });
          const res = await waiting;
          this.emit(sessionId, { type: "approval_resolved", sessionId, threadId, callId: call.callId, approved: res.approved, by: res.by });
          outcome = res.approved
            ? await this.executeCall(call, cwd)
            : { output: `denied by ${res.by}`, isError: true };
        } else {
          outcome = await this.executeCall(call, cwd);
        }

        this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
        input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
      }
    }

    this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: `tool-iteration cap (${MAX_TOOL_ITERATIONS}) reached` });
    this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
  }

  private executeCall(call: { name: string; argsJson: string }, cwd: string): Promise<{ output: string; isError: boolean }> {
    let args: unknown;
    try { args = call.argsJson.length ? JSON.parse(call.argsJson) : {}; }
    catch { return Promise.resolve({ output: `tool arguments were not valid JSON`, isError: true }); }
    return this.cfg.registry.execute(call.name, args, { cwd });
  }
}
