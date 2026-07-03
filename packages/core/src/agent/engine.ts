import type { NewSessionEvent, Question, SessionEvent, Task } from "@norma/protocol";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";
import type { Provider, ProviderEvent, TurnInputItem } from "../providers/types";
import type { ToolRegistry } from "./tools/registry";
import type { PermissionGate } from "./gate";
import type { ApprovalBroker } from "./approvals";
import type { QuestionBroker } from "./questions";
import type { TaskStore } from "./task-store";
import type { SessionDirectories } from "./dirs";
import { sessionTmpDir } from "./session-tmp";
import type { ContextAssembler } from "./context";
import type { Compactor } from "./compactor";
import type { McpManager } from "./mcp/manager";
import { bashLooksSafe, type BashReviewer } from "./reviewer";

const MAIN_THREAD = "main";
const MAX_TOOL_ITERATIONS = 24; // runaway guard until 1b-ii budgets land

type Checkpoint = Extract<SessionEvent, { type: "checkpoint" }>;
function isCheckpoint(e: SessionEvent): e is Checkpoint {
  return e.type === "checkpoint";
}

type TurnCompleted = Extract<SessionEvent, { type: "turn_completed" }>;
function isTurnCompleted(e: SessionEvent): e is TurnCompleted {
  return e.type === "turn_completed";
}

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
  dirs: SessionDirectories;
  provider: { provider: Provider; model: string };
  assembler: ContextAssembler;
  compactor: Compactor;
  mcp?: McpManager;
  // Both optional — absent means the corresponding tool bridge (ctx.ask / ctx.taskEvent) is
  // undefined, and the ask_user/task_* tools degrade (ask_user: immediate "proceed" message;
  // task tools: registered only when a TaskStore is passed to registerTaskTools by the caller).
  questions?: QuestionBroker;
  tasks?: TaskStore;
  approvalTimeoutMs?: number; // default 5 min
  reviewer?: BashReviewer; // safety review for auto-policy bash calls (undefined → no review, unchanged behavior)
  reviewerEnabled?: boolean; // default true when reviewer is set; false disables the review path entirely
  reviewerAllow?: string[]; // extra commands/argv0s bashLooksSafe treats as obviously-safe (bypass review)
  // deferral wired ONLY when this is set AND enabled !== false — undefined (the setupEngine/
  // daemon default before this config existed) leaves specs()/instructions/execute untouched.
  toolSearch?: { enabled?: boolean; deferThreshold?: number };
}

export class AgentEngine {
  private runningTurns = new Set<string>();
  private steerQueue = new Map<string, string[]>();
  private aborters = new Map<string, AbortController>();
  // loadedSkills is SESSION-scoped (sticky across turns) — NOT cleared per turn, unlike
  // steerQueue/aborters below (which ARE deleted in runTurn's finally, being per-turn). A skill
  // loaded via the Skill tool in one turn must still be injected into the NEXT turn's assembled
  // instructions, so this map lives for the lifetime of the engine (per session), not the turn.
  private loadedSkills = new Map<string, Set<string>>();
  // loadedTools mirrors loadedSkills above: SESSION-scoped (sticky across turns), NOT cleared in
  // runTurn's finally. A deferred mcp__ tool's schema, once loaded via the ToolSearch tool, must
  // stay loaded for every later round of the SAME turn (defense-in-depth's execute check runs
  // per-round) AND for every subsequent turn of the session — so this Set is shared, mutated
  // in-place (never copied/snapshotted), across specs()/deferredIndex()/executeCall's ctx. See
  // the NOTE in turn() below.
  private loadedTools = new Map<string, Set<string>>();
  constructor(private readonly cfg: EngineConfig) {}

  /** True while a turn is executing for the session. */
  isRunning(sessionId: string): boolean { return this.runningTurns.has(sessionId); }

  async runTurn(sessionId: string): Promise<void> {
    if (this.runningTurns.has(sessionId)) throw new Error(`turn already running for ${sessionId}`);
    this.runningTurns.add(sessionId);
    const ac = new AbortController();
    this.aborters.set(sessionId, ac);
    try {
      await this.turn(sessionId, ac.signal);
    } finally {
      this.runningTurns.delete(sessionId);
      this.aborters.delete(sessionId);
      this.steerQueue.delete(sessionId);
    }
  }

  /** Abort the in-flight turn for a session, if any. Idempotent — safe to call when idle. */
  interrupt(sessionId: string): { wasRunning: boolean } {
    const ac = this.aborters.get(sessionId);
    if (!ac) return { wasRunning: false };
    ac.abort();
    return { wasRunning: true };
  }

  /**
   * Inject a user message into a session. If a turn is running, the message is queued and
   * drained into the next round's input (steering it mid-turn); otherwise a new turn is
   * started so the message reaches the model. The message is always appended to history
   * immediately (via hub.append) regardless of which path is taken.
   */
  steer(sessionId: string, text: string): { injected: boolean } {
    // Surface as a user_message (history + all harnesses) — clientName "steer".
    this.cfg.hub.append(sessionId, { type: "user_message", sessionId, threadId: MAIN_THREAD, text, clientName: "steer" });
    if (this.isRunning(sessionId)) {
      const q = this.steerQueue.get(sessionId) ?? [];
      q.push(text); this.steerQueue.set(sessionId, q);
      return { injected: true };
    }
    // start a turn; the user_message is already in history
    void this.runTurn(sessionId).catch((e) => console.error("steer turn failed:", e));
    return { injected: false };
  }

  private emit(sessionId: string, event: NewSessionEvent): SessionEvent {
    return this.cfg.hub.append(sessionId, event); // hub.append: store.append + broadcast (added below)
  }

  /** Manually trigger compaction (e.g. via an explicit IPC method), scoped to any turn
   *  currently running for this session so an abort/interrupt also cancels the compaction. */
  async compact(sessionId: string): Promise<{ compacted: boolean; uptoSeq: number; summaryChars: number }> {
    return this.cfg.compactor.compact(sessionId, this.aborters.get(sessionId)?.signal);
  }

  /** ToolSearch deferral is wired ONLY when cfg.toolSearch is set AND enabled !== false. */
  private toolSearchEnabled(): boolean {
    return this.cfg.toolSearch !== undefined && this.cfg.toolSearch.enabled !== false;
  }

  private toolSearchThreshold(): number | undefined {
    return this.toolSearchEnabled() ? this.cfg.toolSearch!.deferThreshold : undefined;
  }

  private contextWindow(): number {
    const m = this.cfg.provider.provider.models().find((mi) => mi.id === this.cfg.provider.model);
    return m?.contextWindow ?? Infinity;
  }

  /** Auto-compact off the REAL provider-reported size of the previous turn (its `turn_completed`
   *  `inputTokens`) — not an estimate. Runs at the start of every turn, before `historyInput` is
   *  built, so a triggered compaction's checkpoint is what `historyInput` sees for this turn. No
   *  prior completed turn (first turn of a session) means the context is necessarily small, so
   *  there's nothing to check. */
  private async maybeAutoCompact(sessionId: string): Promise<void> {
    const events = this.cfg.store.read(sessionId);
    const lastCompleted = [...events].reverse().find(isTurnCompleted);
    if (!lastCompleted) return;
    const used = lastCompleted.inputTokens;
    const frac = Number(process.env.NORMA_COMPACT_THRESHOLD_FRAC ?? 0.75);
    const absMax = process.env.NORMA_COMPACT_MAX_TOKENS ? Number(process.env.NORMA_COMPACT_MAX_TOKENS) : Infinity;
    const limit = Math.min(this.contextWindow() * frac, absMax);
    if (used > limit) await this.cfg.compactor.compact(sessionId, this.aborters.get(sessionId)?.signal);
  }

  /** Builds the turn's starting input from history: if the session has been compacted (a
   *  `checkpoint` event exists), the input opens with the checkpoint's summary in place of the
   *  messages it covers, followed only by messages after its `uptoSeq` — this is what actually
   *  shrinks the model's context after compaction. With no checkpoint, behavior is unchanged:
   *  the full user/assistant message history. */
  private historyInput(sessionId: string): TurnInputItem[] {
    const events = this.cfg.store.read(sessionId);
    const lastCp = [...events].reverse().find(isCheckpoint);
    const input: TurnInputItem[] = [];
    if (lastCp) input.push({ type: "message", role: "user", content: "[Summary of earlier conversation]\n" + lastCp.summary });
    const uptoSeq = lastCp ? lastCp.uptoSeq : 0;
    for (const e of events) {
      if (e.seq <= uptoSeq) continue;
      if (e.type === "user_message") input.push({ type: "message", role: "user", content: e.text });
      else if (e.type === "assistant_message") input.push({ type: "message", role: "assistant", content: e.text });
      // Prior turns' tool calls are summarized by their assistant_message; current-turn
      // call/result items are threaded in-memory below.
    }
    return input;
  }

  private async turn(sessionId: string, signal: AbortSignal): Promise<void> {
    const meta = this.cfg.store.meta(sessionId);
    const threadId = MAIN_THREAD;
    if (!meta.cwd) {
      this.emit(sessionId, { type: "turn_started", sessionId, threadId });
      this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: "session has no working directory — create the session with a cwd" });
      this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", inputTokens: 0, outputTokens: 0 });
      return;
    }
    const cwd = meta.cwd;
    // Trust-gated project .mcp.json bring-up, BEFORE the turn_started emit: this can spawn
    // subprocesses (slow), and a project server that's already started/recorded is a no-op, so
    // doing it here (rather than after turn_started) keeps the -p watchdog from tripping on a
    // slow first-turn project-server start. A failure here degrades to a turn with no project
    // tools rather than breaking the turn.
    try { await this.cfg.mcp?.ensureProject(cwd); } catch (e) { console.error("mcp ensureProject failed", e); }
    // Assembled ONCE per turn — not re-read per tool-round. Re-reading here would let a
    // same-turn tool write to <cwd>/NORMA.md (under `auto` policy) get injected as trusted
    // system instructions in a later round of the SAME turn. A NORMA.md change only takes
    // effect starting the NEXT turn.
    const instructions = this.cfg.assembler.assemble({ cwd, loadedSkills: [...(this.loadedSkills.get(sessionId) ?? [])] });
    // NOTE (correctness-critical): `loaded` MUST be THE ONE LIVE SET for this session — never a
    // snapshot/copy. It's read here to build specs()/deferredIndex() for round 0, and the SAME
    // object is handed to executeCall's ctx below; markToolLoaded (called by the ToolSearch tool)
    // mutates it in place. That's what makes a load in round 1 visible to round 2's specs() AND
    // to execute's defense-in-depth check, all within this one turn, without re-reading anything.
    if (!this.loadedTools.has(sessionId)) this.loadedTools.set(sessionId, new Set());
    const loaded = this.loadedTools.get(sessionId)!;
    const tsEnabled = this.toolSearchEnabled();
    const deferThreshold = this.toolSearchThreshold();
    const deferred = tsEnabled ? this.cfg.registry.deferredIndex(cwd, loaded, deferThreshold) : [];
    // Appended ONCE per turn, right after assemble (same one-per-turn rule as `instructions`
    // above) — a same-turn ToolSearch load changes `loaded` but must not re-trigger this section
    // mid-turn; deferred/instructionsFull are computed once here and reused for every round.
    const instructionsFull = deferred.length
      ? instructions + "\n\n# Deferred tools\nThe following tools exist but their schemas are NOT loaded — calling them directly fails. Load schemas first with the ToolSearch tool (query \"select:<name>\" or keywords), then call them normally.\n" + deferred.map((d) => `- ${d.name} — ${d.description}`).join("\n")
      : instructions;
    // Auto-compact BEFORE historyInput is built, so a triggered compaction's checkpoint is
    // reflected in this turn's input. A compaction failure degrades to a normal (uncompacted)
    // turn rather than breaking it.
    try { await this.maybeAutoCompact(sessionId); } catch (e) { console.error("auto-compact failed", e); }
    const input = this.historyInput(sessionId);
    const usage = { inputTokens: 0, outputTokens: 0 };

    this.emit(sessionId, { type: "turn_started", sessionId, threadId });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const steers = this.steerQueue.get(sessionId);
      if (steers && steers.length) { for (const t of steers) input.push({ type: "message", role: "user", content: t }); steers.length = 0; }

      let textBuf = "";
      const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
      let stop: "end_turn" | "tool_calls" | "aborted" | null = null;

      for await (const ev of this.cfg.provider.provider.streamTurn({
        model: this.cfg.provider.model,
        instructions: instructionsFull,
        input,
        tools: this.cfg.registry.specs(cwd, tsEnabled ? { loaded, deferThreshold } : undefined),
        signal,
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
        const pending = this.steerQueue.get(sessionId);
        // A steer landed as we finished → drain at next iteration top, keep going. But an
        // interrupt must win: an aborted turn ends now with turn_completed(aborted) even if a
        // steer is queued (it stays queued for the next runTurn, e.g. via steer()'s own restart).
        if (stop !== "aborted" && pending && pending.length) { continue; }
        this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: stop === "aborted" ? "aborted" : "end_turn", ...usage });
        return;
      }

      for (const call of calls) {
        this.emit(sessionId, { type: "tool_call", sessionId, threadId, callId: call.callId, name: call.name, argsJson: call.argsJson });
        input.push({ type: "function_call", callId: call.callId, name: call.name, argsJson: call.argsJson });

        let outcome: { output: string; isError: boolean };
        const decision = this.cfg.gate.evaluate(call.name, meta.approvalPolicy);
        if (decision === "ask") {
          outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
            timeoutMs: this.cfg.approvalTimeoutMs ?? 5 * 60_000,
            summary: `${call.name} ${call.argsJson.slice(0, 160)}`,
            // no denialMessage → the helper defaults to `denied by ${res.by}` (unchanged behavior)
          });
        } else if (
          decision === "allow" && call.name === "bash" && this.cfg.reviewer &&
          this.cfg.reviewerEnabled !== false && meta.approvalPolicy === "auto"
        ) {
          let command = "";
          let justification: string | undefined;
          try {
            const a = JSON.parse(call.argsJson || "{}");
            command = typeof a.command === "string" ? a.command : "";
            justification = typeof a.justification === "string" ? a.justification : undefined;
          } catch { /* fall through to review of "" → likely unsafe */ }
          if (command && bashLooksSafe(command, this.cfg.reviewerAllow ?? [])) {
            outcome = await this.executeCall(call, cwd, sessionId, threadId, signal);
          } else {
            let v: { verdict: "safe" | "unsafe"; reason: string };
            try {
              v = await this.cfg.reviewer.review({ command, justification }, signal);
            } catch {
              v = { verdict: "unsafe", reason: "reviewer unavailable — manual approval required" };
            }
            if (v.verdict === "unsafe") {
              outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
                timeoutMs: Number(process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS ?? 60_000),
                summary: `⚠ safety reviewer: ${v.reason} — ${call.name} ${command.slice(0, 120)}`,
                denialMessage: `blocked by the safety reviewer: ${v.reason}. No approval within 60s. If this command is genuinely necessary, call bash again with a "justification" explaining why — the reviewer will reconsider.`,
              });
            } else {
              outcome = await this.executeCall(call, cwd, sessionId, threadId, signal);
            }
          }
        } else {
          outcome = await this.executeCall(call, cwd, sessionId, threadId, signal);
        }

        this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
        input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
      }
    }

    this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: `tool-iteration cap (${MAX_TOOL_ITERATIONS}) reached` });
    this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
  }

  /** Shared approval-request flow for both the `ask`-policy path and the reviewer's escalation
   *  path. Registers the broker wait BEFORE emitting `approval_requested` — the broadcast is
   *  synchronous, so a watcher that resolves the approval as soon as it observes the event (see
   *  engine.test.ts) would otherwise race `broker.wait()` and resolve into an empty pending-map
   *  slot, timing out. On denial, `opts.denialMessage` lets a caller (the reviewer path) override
   *  the default `denied by ${res.by}` string with a retry-hint message; the `ask` path passes no
   *  override, preserving that exact string byte-for-byte. */
  private async requestApproval(
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    opts: { timeoutMs: number; summary: string; denialMessage?: string },
  ): Promise<{ output: string; isError: boolean }> {
    const waiting = this.cfg.broker.wait(sessionId, call.callId, opts.timeoutMs);
    try {
      this.emit(sessionId, {
        type: "approval_requested", sessionId, threadId, callId: call.callId, toolName: call.name,
        summary: opts.summary,
      });
    } catch (err) {
      // emit failed (e.g. disk): resolve the registered waiter now so it doesn't linger until timeout
      this.cfg.broker.resolve(sessionId, call.callId, false, "emit-failure");
      throw err;
    }
    const res = await waiting;
    this.emit(sessionId, { type: "approval_resolved", sessionId, threadId, callId: call.callId, approved: res.approved, by: res.by });
    return res.approved
      ? await this.executeCall(call, cwd, sessionId, threadId, signal)
      : { output: opts.denialMessage ?? `denied by ${res.by}`, isError: true };
  }

  private executeCall(
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
  ): Promise<{ output: string; isError: boolean }> {
    let args: unknown;
    try { args = call.argsJson.length ? JSON.parse(call.argsJson) : {}; }
    catch { return Promise.resolve({ output: `tool arguments were not valid JSON`, isError: true }); }
    const roots = this.cfg.dirs.roots(sessionId);
    const tmpDir = sessionTmpDir(sessionId);
    const markSkillLoaded = (n: string) => {
      let set = this.loadedSkills.get(sessionId);
      if (!set) { set = new Set(); this.loadedSkills.set(sessionId, set); }
      set.add(n);
    };
    // Pass the LIVE loadedTools set (mutated in place by markToolLoaded) — see the NOTE in
    // turn() above. By the time executeCall runs, turn() has already ensured this session's
    // entry exists, so `?? new Set()` here is a defensive fallback, never the live path.
    const markToolLoaded = (n: string) => {
      let set = this.loadedTools.get(sessionId);
      if (!set) { set = new Set(); this.loadedTools.set(sessionId, set); }
      set.add(n);
    };
    const askTimeoutMs = Number(process.env.NORMA_ASK_TIMEOUT_MS ?? 300_000);
    const ask = this.cfg.questions
      ? async (questions: Question[]) => {
          // Register the wait BEFORE emitting: broadcast is synchronous, so a watcher that
          // responds as soon as it observes question_asked would otherwise race the broker
          // (see requestApproval's identical wait-before-emit comment above).
          const waiting = this.cfg.questions!.wait(sessionId, call.callId, askTimeoutMs);
          try {
            this.emit(sessionId, { type: "question_asked", sessionId, threadId, callId: call.callId, questions });
          } catch (err) {
            this.cfg.questions!.respond(sessionId, call.callId, {}, "emit-failure");
            await waiting;
            return { timedOut: true } as const;
          }
          const res = await waiting;
          this.emit(sessionId, {
            type: "question_resolved", sessionId, threadId, callId: call.callId,
            answers: "answers" in res ? res.answers : {},
            by: "by" in res ? res.by : "timeout",
          });
          return res;
        }
      : undefined;
    const taskEvent = (task: Task) => { this.emit(sessionId, { type: "task_updated", sessionId, threadId, task }); };
    return this.cfg.registry.execute(call.name, args, {
      cwd, roots, tmpDir, sessionId, signal, markSkillLoaded,
      markToolLoaded,
      loadedTools: this.loadedTools.get(sessionId) ?? new Set(),
      deferThreshold: this.toolSearchThreshold(),
      ask,
      taskEvent,
    });
  }
}
