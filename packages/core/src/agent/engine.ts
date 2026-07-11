import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { NewSessionEvent, Question, SessionEvent, Task } from "@norma/protocol";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";
import type { Provider, ProviderEvent, TurnInputItem } from "../providers/types";
import type { ToolRegistry } from "./tools/registry";
import type { PermissionGate, SessionApprovalPolicy } from "./gate";
import type { ApprovalBroker } from "./approvals";
import type { QuestionBroker } from "./questions";
import type { TaskStore } from "./task-store";
import type { PlanBroker } from "./plans";
import type { SessionDirectories } from "./dirs";
import { sessionTmpDir } from "./session-tmp";
import type { ContextAssembler } from "./context";
import type { Compactor } from "./compactor";
import type { McpManager } from "./mcp/manager";
import { bashLooksSafe, type BashReviewer } from "./reviewer";
import type { WorktreeManager } from "./worktree";
import type { SubagentManager } from "./subagents";
import type { AgentStore } from "./agents";
import type { BackgroundAgentRegistry, ResumeContext } from "./bg-agent-registry";
import type { HookResult } from "../plugins/hook-runner";

/** Structural narrowing of BackgroundTaskRegistry (bg-registry.ts) to just what pinnedTools
 *  (below) needs — lets the engine (and tests) work with anything shaped like a per-session task
 *  lister, without requiring the full class (whose other members — start/read/kill — pinnedTools
 *  never touches). A real BackgroundTaskRegistry instance satisfies this structurally. */
export interface BgTaskLister {
  list(sessionId: string): Array<{ status: string }>;
}

const MAIN_THREAD = "main";
const MAX_TOOL_ITERATIONS = 24; // runaway guard until 1b-ii budgets land

// 4h-i (CC parity: spawn_agent `mode`) — permissiveness order, LEAST to MOST permissive: "plan"
// is read-only (most restrictive), "ask" is human-gated (middle), "auto" auto-allows non-
// destructive tools (least restrictive). Mirrors gate.ts's own PermissionGate.evaluate() ordering
// (plan denies everything mutating outright; ask/auto both gate mutating tools, auto auto-allows).
const POLICY_RESTRICTIVENESS: Record<SessionApprovalPolicy, number> = { plan: 0, ask: 1, auto: 2 };

/** RESTRICT-ONLY: returns the MORE RESTRICTIVE of {parent, requested} — a spawn_agent `mode`
 *  override can only NARROW a child's effective approval policy relative to its parent thread's,
 *  never WIDEN it. A request that would widen (e.g. parent "ask" + requested "auto", or parent
 *  "plan" + requested "auto") is silently ignored — the parent's policy wins. Pure and exported
 *  for direct unit testing: this is the security-critical piece of the `mode` feature (a bug here
 *  is a privilege-escalation bug, not a UX one). */
export function restrictPolicy(parent: SessionApprovalPolicy, requested: SessionApprovalPolicy): SessionApprovalPolicy {
  return POLICY_RESTRICTIVENESS[requested] < POLICY_RESTRICTIVENESS[parent] ? requested : parent;
}

/** Maps a CC-parity spawn `mode` arg to Norma's `approvalPolicy`. Only `plan` maps to Norma's
 *  "plan" (read-only); `acceptEdits`/`dontAsk`/`bypassPermissions` all collapse to "auto" — Norma
 *  has no finer-grained distinction between them (CC parity here is at the arg-surface level, not
 *  full behavioral parity with CC's own distinct modes). `default`, absent, or any unrecognized
 *  string maps to `undefined` — "no override", i.e. the child inherits the parent's policy
 *  unchanged (this is what lets the spawn bridge skip building a child-scoped meta entirely when
 *  there's nothing to narrow — see the bridge's `childMeta` computation). */
export function mapSpawnMode(mode: string | undefined): SessionApprovalPolicy | undefined {
  switch (mode) {
    case "plan": return "plan";
    case "acceptEdits":
    case "dontAsk":
    case "bypassPermissions": return "auto";
    default: return undefined; // "default", absent, or an unrecognized string
  }
}

/** Mirrors protocol's ThreadInfoSchema (methods.ts) — kept as a plain local type rather than a
 *  zod import here since engine.ts only needs the shape, not a schema/validator of its own. */
export interface ThreadInfo {
  threadId: string;
  parentThreadId?: string;
  agentType?: string;
  status: "running" | "completed";
  stopReason?: string;
}

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
  // `live`, when wired (daemon.ts, from providers/manager.ts's ActiveProvider.liveModel),
  // re-resolves the model + reasoningEffort ONCE PER TURN straight off the current settings.json
  // — the whole point being that changing the configured model does NOT require a daemon
  // restart. Absent (test harnesses that don't care) means every turn just uses this boot-time
  // `model` snapshot, unchanged behavior. `model` itself is ALWAYS present as the fallback `live`
  // resolves from when unset, and as what `contextWindow`'s default-Infinity ModelInfo lookup
  // falls back to matching when `live` is absent.
  provider: { provider: Provider; model: string; live?: () => { model: string; reasoningEffort?: string } };
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
  // deferExternals mirrors registry.ts's opt of the same name ("always": externals defer whenever
  // ANY is visible, ignoring deferThreshold's count comparison; absent/"count" = unchanged).
  toolSearch?: { enabled?: boolean; deferThreshold?: number; deferExternals?: "count" | "always" };
  // Plan mode (1d-ii): both optional, and both absent leaves existing behavior untouched. Without
  // `plans`, exit_plan_mode falls to the else executeCall branch → the tool's own placeholder
  // run() (tools/plan.ts) rather than the approval bridge below. `setPolicy` persists an approved
  // plan's mode switch to the SessionStore (so it survives into the NEXT turn); the bridge also
  // mutates the in-memory `meta` object for the CURRENT turn regardless of whether setPolicy is
  // set, since that's what lets a same-turn follow-up call see the new mode immediately.
  plans?: PlanBroker;
  setPolicy?: (sessionId: string, policy: "ask" | "auto" | "plan") => Promise<void> | void;
  // Worktree isolation (1d-iii): optional — absent means enter_worktree/exit_worktree fall to
  // their own placeholder run() (tools/worktree.ts) rather than the bridge below. When set, the
  // bridge mutates the turn's local `cwd` (now `let`, not `const`) SAME-TURN, so a follow-up tool
  // call later in this same turn resolves into (or back out of) the worktree immediately — it
  // also persists via store.setCwd/dirs.add so the NEXT turn sees it too.
  worktrees?: WorktreeManager;
  // State pin (4g-i): per-session live background-task listing, consulted ONLY by pinnedTools
  // (below) to force bash_output/bash_kill visible while a task is running, without touching the
  // sticky loadedTools set. Absent → that pin never fires (bash_output/bash_kill, if registered
  // deferred:true, stay hidden until ToolSearch-loaded like any other deferred built-in).
  bgRegistry?: BgTaskLister;
  // Subagents (1d-iv): both optional, and both absent leaves spawn_agent at its own placeholder
  // run() (tools/spawn.ts) rather than the parallel bridge below. Both must be set together for
  // the bridge to activate — see the `spawnCalls` filter in runThread's dispatch loop.
  subagents?: SubagentManager;
  agents?: AgentStore;
  // Async spawn (4h-ii-a, CC parity: Agent.run_in_background): tracks DETACHED child threads —
  // see bg-agent-registry.ts's own doc comment for why this is a separate registry from
  // bgRegistry above (that one owns backgrounded bash processes; this one owns agent threads,
  // whose live output already streams as ordinary thread events). Optional — a spawn call with
  // `run_in_background:true` while this is unset fails as a typed error (see the bridge below)
  // rather than silently falling back to the synchronous path, so a caller never gets a "running"
  // tool_result for a detached child nothing is actually tracking.
  bgAgents?: BackgroundAgentRegistry;
  // 4h-i Task 3 (CC parity: configurable nesting depth, settings.subagents.maxDepth): how many
  // levels of spawn_agent nesting are allowed, orthogonal to SubagentManager's maxConcurrent
  // (fan-out width) — this is depth, not count or concurrency. Undefined → defaults to 5
  // (runThread reads `subagentMaxDepth ?? 5`), matching Claude Code's fixed max nesting depth of
  // 5 (user decision: "whatever Claude Code does"). `maxDepth: 1` reproduces the pre-4h-i
  // behavior (a depth-1 child could never spawn further). A thread at `depth <
  // maxDepth` may spawn (spawn_agent stays in its specs, the bridge runs its calls); a thread AT
  // `depth >= maxDepth` has spawn_agent excluded from its specs and, belt-and-braces, rejects any
  // spawn_agent call it receives anyway.
  subagentMaxDepth?: number;
  // SessionTitler (Phase 2e-iii Task 3): optional — absent means no session gets an
  // auto-generated title. Fired fire-and-forget, only at the main thread's (depth 0) turn
  // completion, never on the error paths (an errored first turn has nothing worth titling).
  titler?: { maybeTitle(sessionId: string): Promise<void> };
  // Plugin hooks runtime (Phase 4f Task 2 — TYPE ONLY here; Task 3 wires the 4 actual call sites:
  // session-start/pre-tool(block)/post-tool/turn-end). daemon.ts builds this from a HookRegistry +
  // HookRunner + the hot `settings.hooks.enabled` read (plugins/hook-registry.ts's HookFacade).
  // Absent (every test/config predating Task 3) means no hook call site fires at all — this field
  // existing on the type does NOT by itself add any behavior.
  hooks?: { runFor(event: string, extra: Record<string, unknown>, sessionId: string, signal?: AbortSignal): Promise<Array<{ pluginId: string; result: HookResult }>> };
}

export class AgentEngine {
  private runningTurns = new Set<string>();
  private steerQueue = new Map<string, string[]>();
  // 4h-ii-b Task 4 (CC SendMessage): per-CHILD-THREAD steer queue, keyed by threadId (globally
  // unique th_<uuid>) — SEPARATE from the sessionId-keyed `steerQueue` above, which stays
  // MAIN-thread-only and untouched. A send_message to a RUNNING child pushes here (sendToThread);
  // the child's runThread drains its own thread's queue at each round boundary (round-top drain),
  // exactly mirroring how the main loop drains steerQueue. Deleted when a child thread's runThread
  // reaches any terminal return (see cleanupThreadSteer in runThread) so an undrained message can't
  // leak into a later resume of the SAME threadId.
  private threadSteerQueue = new Map<string, string[]>();
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
  // THREAD-LOCAL WRITES (4g final-review fix): this map is populated ONLY by the MAIN thread —
  // turn() seeds `this.loadedTools.get(sessionId)` and hands that SAME Set object to runThread as
  // opts.loaded. executeCall/markToolLoaded (below) always operate on THE CALLING THREAD's
  // `loaded` set (threaded through as a parameter), never by re-deriving it from this map via
  // sessionId. For the main thread that set IS this map's entry, so a load still lands here and
  // stays sticky across turns — unchanged. A CHILD thread's `loaded` (runThread's spawn bridge:
  // `childLoaded = new Set()`) is never stored in this map, so a subagent's ToolSearch load can
  // no longer leak into (or be shadowed by) the session-wide set.
  private loadedTools = new Map<string, Set<string>>();
  // Thread registry (1d-iv, for thread.list): SESSION-scoped, mirrors loadedSkills/loadedTools
  // above in lifetime (never cleared per-turn). Seeded lazily (via threadList()) with the main
  // thread entry on first read/turn, then appended to by the spawn bridge as children are
  // registered/completed. Never a snapshot — entries are mutated in place by completeThread.
  private threads = new Map<string, ThreadInfo[]>();
  // Plugin hooks (4f Task 3): sessionIds whose `session-start` hook has already fired in THIS
  // daemon process. PROCESS-LIFETIME, never persisted — a session RESUMED in a fresh daemon
  // process re-fires session-start once (acceptable v1: a resumed session has no in-memory record
  // it already started; CC has the same re-fire-on-restart shape). Only consulted when cfg.hooks
  // is wired, so it's inert (allocated-but-untouched) for every hook-less config — byte-identical.
  private hookSessionStarted = new Set<string>();
  constructor(private readonly cfg: EngineConfig) {}

  /** True while a turn is executing for the session. */
  isRunning(sessionId: string): boolean { return this.runningTurns.has(sessionId); }

  /** Lazily seeds the main thread entry for a session on first read/turn. */
  private threadList(sessionId: string): ThreadInfo[] {
    let list = this.threads.get(sessionId);
    if (!list) {
      list = [{ threadId: MAIN_THREAD, status: "running" }];
      this.threads.set(sessionId, list);
    }
    return list;
  }

  /** Registers a new (child) thread entry — called by the spawn bridge when a subagent starts. */
  private registerThread(sessionId: string, info: ThreadInfo): void {
    this.threadList(sessionId).push(info);
  }

  /** Marks a thread (main or child) completed with its stop reason, in place. */
  private completeThread(sessionId: string, threadId: string, stopReason: "end_turn" | "aborted" | "error"): void {
    const t = this.threadList(sessionId).find((t) => t.threadId === threadId);
    if (t) { t.status = "completed"; t.stopReason = stopReason; }
  }

  /** All threads for a session (thread.list): main first, then children in registration order. */
  threadsFor(sessionId: string): ThreadInfo[] {
    return this.threadList(sessionId);
  }

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

  /**
   * 4h-ii-b Task 4 (CC SendMessage): deliver `text` to a RUNNING child thread. The child receives
   * it at its next step. QUEUE-ONLY — push `text` into this child thread's own steer queue (keyed by
   * threadId), which the child's runThread drains at its next round boundary (the round-top drain),
   * exactly like the main loop drains steerQueue. This is the running-target half of the
   * send_message bridge (SM4); the finished-target half reuses resumeThread instead.
   *
   * The child-scoped `user_message` is NO LONGER persisted here — it is persisted at the CHILD
   * round-top DRAIN (see runThread's child branch) instead (whole-branch review C1/I1). Persisting
   * at SEND time was a bug: a send that lands while the child is AWAITING executeCall (a real
   * multi-second bash/web_fetch/nested-spawn window) would slot the user_message BETWEEN that
   * round's tool_call and its tool_result in the child's persisted log — an INTERIOR corruption the
   * resume clean-termination guard (which only inspects the LAST event) misses. On resume,
   * childHistoryInput (a blind 1:1 seq map, no coalescing) then reconstructs an orphan
   * function_call immediately followed by a user turn → a hard provider reject. Persisting at the
   * drain instead guarantees the message lands AFTER the prior round's tool_result (clean
   * alternation), and a message that is never drained (child finishing, I1) is never persisted.
   */
  sendToThread(sessionId: string, threadId: string, text: string): void {
    const q = this.threadSteerQueue.get(threadId) ?? [];
    q.push(text);
    this.threadSteerQueue.set(threadId, q);
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

  private toolSearchDeferExternals(): "count" | "always" | undefined {
    return this.toolSearchEnabled() ? this.cfg.toolSearch!.deferExternals : undefined;
  }

  /** Per-turn/round pins (4g-i): state-required deferred built-ins forced visible WITHOUT
   *  touching the sticky `loadedTools` set (that Set is mutated ONLY by markToolLoaded — see the
   *  NOTE above `loadedTools`'s declaration). Callers union the result into a NEW Set
   *  (`effectiveLoaded`) at each of the three deferral seams (buildInstructionsFull, the
   *  per-round specs() call, and executeCall) — `loaded` itself is never copied or mutated here.
   *  Recomputed fresh at each seam (not cached) so a mid-turn state change — a plan approved, a
   *  worktree entered/exited via the same-turn bridges, a bg task started/exited — is reflected
   *  without waiting for the next turn. A no-op when the corresponding tool isn't registered
   *  deferred:true (or isn't registered at all) — specs()/execute don't care about pins for a
   *  tool that was never hidden in the first place. `_cwd` is unused today (no current pin is
   *  scope-aware) — kept in the signature for parity with the other deferral seams, which all
   *  thread cwd, in case a future pin needs it. */
  private pinnedTools(sessionId: string, meta: { approvalPolicy: "ask" | "auto" | "plan" }, _cwd: string | null): Set<string> {
    const pins = new Set<string>();
    if (meta.approvalPolicy === "plan") pins.add("exit_plan_mode");
    if (this.cfg.worktrees?.active(sessionId)) pins.add("exit_worktree");
    const bgTasks = this.cfg.bgRegistry?.list(sessionId) ?? [];
    // 4h-ii-c Task 2: task_stop can kill a running bg TASK too (its bash-unify path, mirroring
    // bash_kill) — pinned alongside bash_output/bash_kill whenever one is running.
    if (bgTasks.some((t) => t.status === "running")) { pins.add("bash_output"); pins.add("bash_kill"); pins.add("task_stop"); }
    // task_stop is ALSO pinned whenever a bg AGENT is running (independent of any bg bash task) —
    // that's its primary target (CC TaskStop parity: stop a running background agent).
    if (this.cfg.bgAgents?.list(sessionId).some((e) => e.status === "running")) pins.add("task_stop");
    return pins;
  }

  /** `model` is the PER-TURN resolved model (turn()'s `sel.model` — live-resolved when
   *  `cfg.provider.live` is wired, else the boot snapshot) — never the boot model directly, so a
   *  live model change is reflected in the auto-compact threshold on the very next turn, not just
   *  in the streamTurn call. Unknown model (no ModelInfo match, e.g. an openai-compatible
   *  provider with no static `models()` list) falls back to Infinity — i.e. auto-compact never
   *  fires rather than firing on a guessed window; this is the pre-existing behavior, unchanged. */
  private contextWindow(model: string): number {
    const m = this.cfg.provider.provider.models().find((mi) => mi.id === model);
    return m?.contextWindow ?? Infinity;
  }

  /** Auto-compact off the REAL provider-reported size of the previous turn (its `turn_completed`
   *  `inputTokens`) — not an estimate. Runs at the start of every turn, before `historyInput` is
   *  built, so a triggered compaction's checkpoint is what `historyInput` sees for this turn. No
   *  prior completed turn (first turn of a session) means the context is necessarily small, so
   *  there's nothing to check. `model` is this turn's resolved model (see `contextWindow`'s doc
   *  comment) — the Compactor's OWN summarization turn still runs on the boot-time model
   *  (Compactor is constructed once in daemon.ts and isn't live-wired); only the trigger
   *  threshold computed here uses the per-turn resolution. */
  private async maybeAutoCompact(sessionId: string, model: string): Promise<void> {
    const events = this.cfg.store.read(sessionId);
    const lastCompleted = [...events].reverse().find(isTurnCompleted);
    if (!lastCompleted) return;
    const used = lastCompleted.inputTokens;
    const frac = Number(process.env.NORMA_COMPACT_THRESHOLD_FRAC ?? 0.75);
    const absMax = process.env.NORMA_COMPACT_MAX_TOKENS ? Number(process.env.NORMA_COMPACT_MAX_TOKENS) : Infinity;
    const limit = Math.min(this.contextWindow(model) * frac, absMax);
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
      if ("threadId" in e && e.threadId !== MAIN_THREAD) continue;
      // CC parity: prior turns' tool calls/results are replayed verbatim (via the shared
      // eventToInput mapper below), not just summarized by their assistant_message — the model
      // no longer "forgets" what its tools did across turns. A checkpoint's `uptoSeq` is always a
      // MESSAGE seq (Compactor only ever folds up to a user/assistant boundary — see
      // compactor.ts's isMessage filter), so a tool_call/tool_result pair can never be split by a
      // checkpoint: either both are folded into the summary, or both survive as tail. That
      // guarantee is jointly held by TWO things, not one: (1) auto-compact runs at the start of a
      // turn (see maybeAutoCompact's doc comment above), before this turn's tool calls exist, so
      // there is never an in-flight pair for it to land inside; and (2) a manual `compact` IPC
      // call is live mid-turn and CAN race a pending tool call (e.g. a steer flood during a slow
      // approval), so compactor.ts's `compact` additionally clamps its candidate `uptoSeq` so it
      // never lands inside an unresolved main-thread tool_call/tool_result pair — see that
      // method's clamp comment. Only together do the two paths make the "never split" guarantee
      // hold unconditionally.
      const item = this.eventToInput(e);
      if (item) input.push(item);
    }
    return this.normalizeReplayOrder(input);
  }

  /** The ONE event→TurnInputItem mapping for history reconstruction (main + child threads must
   *  stay in lockstep — both feed the provider). Returns null for events with no provider shape. */
  private eventToInput(e: SessionEvent): TurnInputItem | null {
    if (e.type === "user_message") return { type: "message", role: "user", content: e.text };
    if (e.type === "assistant_message") return { type: "message", role: "assistant", content: e.text };
    if (e.type === "tool_call") return { type: "function_call", callId: e.callId, name: e.name, argsJson: e.argsJson };
    if (e.type === "tool_result") return { type: "tool_result", callId: e.callId, output: e.output, isError: e.isError };
    // history-parity Task 3: opaque reasoning items replay verbatim (CC/Codex parity). This ONE
    // case gives BOTH historyInput (cross-turn) and childHistoryInput (subagent resume) the replay.
    if (e.type === "reasoning_item") return { type: "reasoning", itemJson: e.itemJson };
    return null;
  }

  /** Replay-order normalization (whole-branch C1): a main-thread steer() persists its user_message
   *  at SEND time, which can land in seq between a tool_call and its tool_result (the live loop
   *  only drains steers at the next round top, so the PROVIDER never saw that interleaving). Replay
   *  must mirror what the provider actually received: any message items found between a
   *  function_call and its matching tool_result are deferred to immediately after that tool_result,
   *  preserving their relative order. Reasoning/tool items are never reordered.
   *
   *  Single pass with a per-open-pair buffer: on a function_call, subsequent `{type:"message"}`
   *  items buffer until the matching tool_result (same callId) is emitted, then flush in order right
   *  after it. Edge cases (never drop an item): sequential pairs (fc1,res1,fc2,res2) buffer
   *  independently; a function_call opening while a prior pair is still unresolved flushes that
   *  prior buffer first (degenerate — shouldn't exist post-compactor-clamp); a function_call whose
   *  matching tool_result never appears flushes its buffered messages at the end. Reasoning items
   *  and any non-matching tool_result between a pair pass through in place — only messages defer. */
  private normalizeReplayOrder(input: TurnInputItem[]): TurnInputItem[] {
    const out: TurnInputItem[] = [];
    let openCallId: string | null = null; // the function_call whose matching tool_result we await
    let buffer: TurnInputItem[] = []; // message items deferred while that pair is open
    for (const item of input) {
      if (item.type === "function_call") {
        // A new pair opens. If a prior pair never resolved (degenerate), flush its buffered
        // messages before this call so nothing is dropped or reordered ahead of it.
        if (buffer.length > 0) { out.push(...buffer); buffer = []; }
        openCallId = item.callId;
        out.push(item);
      } else if (item.type === "tool_result" && openCallId !== null && item.callId === openCallId) {
        // Close the open pair: result right after its call, then the deferred messages flush right
        // after the result (mirroring the live [fc, result, steer] order).
        out.push(item);
        if (buffer.length > 0) { out.push(...buffer); buffer = []; }
        openCallId = null;
      } else if (item.type === "message" && openCallId !== null) {
        buffer.push(item); // a message between a call and its matching result — defer it
      } else {
        out.push(item); // reasoning / non-matching tool_result / message outside any pair — in place
      }
    }
    if (buffer.length > 0) out.push(...buffer); // open pair with no matching result — never drop
    return out;
  }

  /** Reconstructs a SPECIFIC child thread's own history from the store, in seq order — the
   *  foundation for `resume` (4h-ii-b Task 3). CRUCIAL DIFFERENCE from `historyInput` above is now
   *  FILTERING, not mapping: both callers delegate to the same `eventToInput` mapper above, so a
   *  main-thread turn's tool calls/results and a child's replay exactly the same shapes. The
   *  difference is which events reach the mapper — historyInput fast-forwards past a checkpoint's
   *  `uptoSeq` and keeps only the MAIN thread; this reconstructs ALL of one specific child
   *  thread's events, unfiltered by any checkpoint (child threads are never compacted today, so
   *  there is no per-child checkpoint event to fast-forward past). A resumed child needs its own
   *  tool_call/tool_result pairs (unlike a main-thread turn, it has no assistant-text summary to
   *  fall back on for what its tools did), so this reconstruction is indistinguishable, shape-wise,
   *  from a child that never stopped.
   *
   *  KNOWN GAP (not fixed here — see this task's report): a child thread's ORIGINAL spawn prompt
   *  is never itself persisted as a `user_message` event scoped to that threadId — the spawn
   *  bridge passes it straight into runThread's in-memory `input` array (`[{type:"message",
   *  role:"user", content:prompt}]`), never through `hub.append`/`store` — so a reconstruction
   *  built purely from stored events for a real spawned child starts at its FIRST
   *  assistant_message, not the prompt that kicked it off. That opening prompt only survives in
   *  the `thread_started` event's own `prompt` field. Whatever calls this (T3's `resume`) must
   *  account for that gap — e.g. by prepending `thread_started.prompt` itself — this function
   *  only reconstructs what the store actually recorded for `threadId`. */
  private childHistoryInput(sessionId: string, threadId: string): TurnInputItem[] {
    const events = this.cfg.store.read(sessionId);
    const input: TurnInputItem[] = [];
    for (const e of events) {
      if (!("threadId" in e) || e.threadId !== threadId) continue;
      const item = this.eventToInput(e);
      if (item) input.push(item);
    }
    // whole-branch C1: child history is already structurally clean (send_message persists at the
    // DRAIN, not at send), so this is a pure no-op today — applied here for uniformity and to guard
    // any future child-scoped persist-at-send source (mirrors historyInput above).
    return this.normalizeReplayOrder(input);
  }

  // Shared by every <system-reminder> builder below (taskListReminder, buildBgCompletionReminder):
  // reminder blocks interpolate model/tool-authored strings (task subjects, subagent result text)
  // that may carry attacker-influenced content — newlines would inject fake reminder lines, and a
  // literal </system-reminder> would close the block early, leaving durable ambient "system" text
  // in-context on every later turn. Sanitize before embedding, always.
  private sanitizeForReminder(s: string): string {
    return s.replace(/\r?\n/g, " ").replace(/<\/?system-reminder>/gi, "[tag]");
  }

  // ---- Plugin hooks (4f Task 3) ----------------------------------------------------------------
  // Four hook points hang off `cfg.hooks` (the Task-2 facade). Reserved-key note (once): the facade
  // spreads `extra` LAST over its own `{event, sessionId, pluginId, ts}`, so `extra` actually WINS a
  // key collision — the safety therefore does NOT come from spread order. It comes from the fact that
  // every per-event `extra` object below is authored HERE with only fixed, non-reserved literal keys
  // (toolName/argsJson/output/isError/threadId/cwd/stopReason/inputTokens/outputTokens) — none of
  // them is `event`/`sessionId`/`pluginId`/`ts`, so nothing can shadow the facade's common fields.
  // F1 (deny-only): only `pre-tool` can BLOCK, and only AFTER the gate has run (or, for the
  // read-only bridged tools, at their effect boundary) — a hook can restrict a call but never
  // widen/approve one. F2 (fail-open): `error`/`timeout`/non-blocked `ok` results are ignored so
  // the tool proceeds — that's just NOT treating them as `blocked`, no extra code.

  /** The isError tool_result a pre-tool BLOCK produces — the FIRST blocked hook result's pluginId +
   *  reason. Shape mirrors the engine's other early-outcome tool_results (depth-cap / deferred-
   *  builtin guards): a short human string + isError:true. */
  private hookBlockOutcome(blocked: { pluginId: string; result: HookResult }): { output: string; isError: boolean } {
    return { output: `blocked by plugin hook ${blocked.pluginId}: ${blocked.result.reason ?? "no reason given"}`, isError: true };
  }

  /** post-tool: observe a completed call's outcome (both success and isError). Observe-only —
   *  results are ignored. SKIPPED for a pre-tool-blocked call (it never ran): `blockedCallIds`
   *  carries every callId a pre-tool BLOCK shortcut set an outcome for. Callers guard on
   *  `this.cfg.hooks` before awaiting, so this is never reached hook-less (byte-identical). */
  private async firePostTool(
    sessionId: string,
    threadId: string,
    call: { name: string; argsJson: string; callId: string },
    outcome: { output: string; isError: boolean },
    blockedCallIds: Set<string>,
    signal?: AbortSignal, // [4f I1] session interrupt cuts through the hook chain
  ): Promise<void> {
    if (blockedCallIds.has(call.callId)) return;
    await this.cfg.hooks!.runFor("post-tool", { toolName: call.name, argsJson: call.argsJson, output: outcome.output, isError: outcome.isError, threadId }, sessionId, signal);
  }

  /** turn-end: fired immediately after a MAIN-thread `turn_completed` emit (all terminal paths:
   *  end_turn/aborted, deniedByHuman, provider error, iteration cap — INCLUDE-both-terminal-paths).
   *  Child-thread turns are excluded v1 (noise) — the threadId guard makes it a no-op for them.
   *  Observe-only. Callers guard on `this.cfg.hooks` before awaiting (byte-identical hook-less). */
  private async fireTurnEnd(
    sessionId: string,
    threadId: string,
    stopReason: "end_turn" | "aborted" | "error",
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    if (threadId !== MAIN_THREAD) return;
    // [4f I1] DELIBERATELY passes NO AbortSignal — unlike session-start/pre-tool/post-tool. turn-end
    // is the TERMINAL observation and must fire on ALL terminal paths, INCLUDING `aborted` (see this
    // method's doc above). But `stopReason === "aborted"` happens precisely when the session signal
    // fired (the provider only reports "aborted" once `signal` is aborted), so threading that signal
    // into runFor's pre-hook `aborted` check would suppress turn-end on exactly the aborted path the
    // design requires it to fire on. I1's interrupt-cuts-the-chain guarantee targets the ongoing work
    // of a live turn (pre-tool gate chain, post-tool observation, session-start injection), not the
    // turn's close-out — and turn-end hooks are already time-bounded by their own HookRunner budget.
    await this.cfg.hooks!.runFor("turn-end", { stopReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, sessionId);
  }

  /** Per-turn task-list reminder (CC v2 parity): the model's own context carries task IDs
   *  nowhere else — `historyInput` above replays only user/assistant messages, never the
   *  task_updated events — so without this the model routinely loses track of ids and calls
   *  task_create again for work already on the list instead of task_update. Mirrors Claude
   *  Code's own system-reminder: injected as a "user" message (there's no dedicated reminder
   *  role on TurnInputItem) wrapped in an explicit <system-reminder> tag so the model treats it
   *  as ambient state, not something the user said — the tag text itself says as much ("never
   *  mention it"). ASSEMBLED INPUT ONLY: built fresh every turn from `cfg.tasks.list()`, appended
   *  to `input` in `turn()` below, and NEVER emitted/persisted as a session event — a session
   *  replay (historyInput on the NEXT turn) must not see this turn's reminder baked in as a fake
   *  user message. Returns undefined when there's nothing to remind about (no TaskStore wired,
   *  or the session's list is empty) so `turn()` can skip appending entirely. */
  private taskListReminder(sessionId: string): TurnInputItem | undefined {
    if (!this.cfg.tasks) return undefined;
    const tasks = this.cfg.tasks.list(sessionId);
    if (tasks.length === 0) return undefined;
    // FINAL-REVIEW FIX: subjects are model-authored strings that may carry attacker-influenced
    // content (the model quotes user/tool/file text into subjects) — sanitize before embedding
    // in the reminder block: newlines would inject fake reminder lines, and a literal
    // </system-reminder> would close the block early, leaving durable ambient "system" text
    // in-context on every later turn.
    const lines = tasks.map((t) => `#${t.id} [${t.status}] ${this.sanitizeForReminder(t.subject)}`).join("\n");
    const content = "<system-reminder>\nCurrent task list (update these by id — do NOT create a new task for work already listed):\n"
      + lines
      + "\nUse task_update with the task's id to change status; task_list shows full details."
      + "\nThis reminder is invisible to the user — never mention it.\n</system-reminder>";
    return { type: "message", role: "user", content };
  }

  /** Per-turn background-agent completion reminder (CC parity: Agent completion notices) — a
   *  `run_in_background` child (4h-ii-a spawn_agent) finishes DETACHED, off the parent's own
   *  turn, so nothing tells the model a bg agent it kicked off is done unless something injects
   *  it. Mirrors `taskListReminder` above in every structural way (same "user" message wrapped in
   *  an explicit <system-reminder> tag, same ASSEMBLED-INPUT-ONLY / never-persisted contract, same
   *  call site in `turn()`) with ONE deliberate difference: this builder is NOT pure/idempotent.
   *  `registry.takeCompletedForSession` marks every entry it returns `notified: true` as a
   *  side effect — so this method must be called EXACTLY ONCE per turn, and only where its result
   *  is actually used, never speculatively or twice. That side effect is what makes the
   *  notification fire exactly once (the turn AFTER the agent finished): a second call this same
   *  turn, or a call whose result is discarded, silently loses that agent's notification forever.
   *  Returns undefined when there's nothing to remind about (no BackgroundAgentRegistry wired, or
   *  no unnotified terminal entries) so `turn()` can skip appending entirely — byte-identical
   *  turn input when no bg agent has finished. */
  private buildBgCompletionReminder(sessionId: string): TurnInputItem | undefined {
    if (!this.cfg.bgAgents) return undefined;
    const finished = this.cfg.bgAgents.takeCompletedForSession(sessionId);
    if (finished.length === 0) return undefined;
    const lines = finished.map((e) => {
      // `result` is only set by registry.complete() — a `stop()`-terminated entry never gets one,
      // so this must tolerate undefined rather than assume every terminal entry has a result.
      const resultHead = this.sanitizeForReminder((e.result ?? "").slice(0, 120));
      // sanitize the label too: agentId is a safe th_+uuid today, but `name` becomes model-supplied
      // in 4h-ii-b — route it through sanitizeForReminder now so it can never inject a fake block.
      return `- agent ${this.sanitizeForReminder(e.name ?? e.agentId)} finished (${e.status}): ${resultHead}`;
    }).join("\n");
    const content = "<system-reminder>\nBackground agent"
      + (finished.length > 1 ? "s" : "")
      + " finished since your last turn:\n"
      + lines
      + "\nRead an agent's full output or resume it with spawn_agent {resume: <agentId>} (resume lands in 4h-ii-b) — for now use its result above."
      + "\nThis reminder is invisible to the user — never mention it.\n</system-reminder>";
    return { type: "message", role: "user", content };
  }

  // Computed ONCE per turn by turn() (same one-per-turn rule as `instructions` itself) — a
  // same-turn ToolSearch load changes `loaded` but must not re-trigger this mid-turn; and the
  // plan-mode reminder is appended off the policy at turn start, not re-checked per round, so an
  // in-turn exit_plan_mode approval (which mutates `meta.approvalPolicy` for the REST of this
  // turn) does not retroactively add/remove this reminder mid-turn.
  private buildInstructionsFull(base: string, cwd: string, loaded: Set<string>, policy: "ask" | "auto" | "plan", sessionId: string): string {
    const tsEnabled = this.toolSearchEnabled();
    const deferThreshold = this.toolSearchThreshold();
    // Pins computed HERE, at instructionsFull's own once-per-turn/thread cadence (see this
    // method's callers — turn() and the spawn bridge each call it exactly once), NOT the
    // per-round cadence used at the specs()/executeCall seams below. `loaded` itself is never
    // mutated — pins are unioned into a NEW Set.
    const pins = tsEnabled ? this.pinnedTools(sessionId, { approvalPolicy: policy }, cwd) : new Set<string>();
    const effectiveLoaded = pins.size ? new Set([...loaded, ...pins]) : loaded;
    const deferred = tsEnabled
      ? this.cfg.registry.deferredIndex(cwd, effectiveLoaded, deferThreshold, tsEnabled, this.toolSearchDeferExternals())
      : [];
    let instructionsFull = deferred.length
      ? base + "\n\n# Deferred tools\nThe following tools exist but their schemas are NOT loaded — calling them directly fails. Load schemas first with the ToolSearch tool (query \"select:<name>\" or keywords), then call them normally.\n" + deferred.map((d) => `- ${d.name} — ${d.description}`).join("\n")
      : base;
    if (policy === "plan") {
      instructionsFull += "\n\n# Plan mode\nYou are in plan mode: research and form a plan, but make NO changes — file edits, writes, and commands are disabled and will be blocked. Any clarifying question or choice you need from the user MUST go through the ask_user tool (structured options) — do not ask in prose and stop. When your plan is ready, call exit_plan_mode with the plan (markdown) to present it for approval. Only after approval will editing be enabled.";
    }
    return instructionsFull;
  }

  private async turn(sessionId: string, signal: AbortSignal): Promise<void> {
    const meta = this.cfg.store.meta(sessionId);
    const threadId = MAIN_THREAD;
    // Resolved ONCE per turn (spec: "changing models must NOT require a daemon restart") — a
    // settings.json edit mid-turn does not retroactively change THIS turn's model, only the
    // NEXT one's, mirroring how `instructions`/`instructionsFull` below are also computed once
    // per turn and not re-read mid-turn. Falls back to the boot-time `provider.model` when `live`
    // isn't wired (most test harnesses) — unchanged behavior for them.
    const sel = this.cfg.provider.live?.() ?? { model: this.cfg.provider.model };
    if (!meta.cwd) {
      this.emit(sessionId, { type: "turn_started", sessionId, threadId });
      this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: "session has no working directory — create the session with a cwd" });
      this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", inputTokens: 0, outputTokens: 0 });
      return;
    }
    // `let`, not `const`: the enter/exit_worktree bridge below reassigns this SAME-TURN so a
    // follow-up tool call later in this turn's dispatch loop resolves into (or back out of) the
    // worktree without waiting for the next turn's store.meta() re-read.
    let cwd = meta.cwd;
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
    const instructionsFull = this.buildInstructionsFull(instructions, cwd, loaded, meta.approvalPolicy, sessionId);
    // Auto-compact BEFORE historyInput is built, so a triggered compaction's checkpoint is
    // reflected in this turn's input. A compaction failure degrades to a normal (uncompacted)
    // turn rather than breaking it. Uses THIS turn's resolved model (sel.model), not the boot
    // snapshot — see contextWindow's doc comment.
    try { await this.maybeAutoCompact(sessionId, sel.model); } catch (e) { console.error("auto-compact failed", e); }
    const input = this.historyInput(sessionId);
    // Appended AFTER history (nearest the model's attention), BEFORE the tool loop starts — see
    // taskListReminder's doc comment for why this is transient (assembled input only, never a
    // persisted event) and why it's a "user" message rather than a new TurnInputItem role.
    const taskReminder = this.taskListReminder(sessionId);
    if (taskReminder) input.push(taskReminder);
    // Same call site/contract as taskReminder above (transient, appended once, never persisted)
    // — this method's own doc comment covers why it must be called exactly once, right here,
    // with its result used immediately. `turn()` is the MAIN-thread (depth 0) entry point only —
    // subagent threads run through `runThread` directly via the spawn bridge, never through
    // `turn()` — so this site is inherently main-thread-scoped without an extra depth check.
    const bgReminder = this.buildBgCompletionReminder(sessionId);
    if (bgReminder) input.push(bgReminder);

    // [4f session-start] Fire the session-start hook ONCE per sessionId per daemon process, at the
    // MAIN thread's turn start, BEFORE the first provider round (runThread) below — CC SessionStart
    // parity: the event exists to inject context. Marked started BEFORE the await so a concurrent
    // re-entry can't double-fire (runTurn already serializes turns per session anyway). Each `ok`
    // result with NON-EMPTY stdout becomes ONE <system-reminder> "user" message appended to THIS
    // turn's input — same assembled-input-only / never-persisted contract and same
    // sanitizeForReminder pass (newlines→spaces + literal </system-reminder>→[tag]) as
    // taskListReminder/buildBgCompletionReminder, so hook stdout can't inject a fake reminder block.
    // error/timeout results (F2 fail-open) and ok-with-empty-stdout inject nothing. extra: {cwd}.
    if (this.cfg.hooks && !this.hookSessionStarted.has(sessionId)) {
      this.hookSessionStarted.add(sessionId);
      const results = await this.cfg.hooks.runFor("session-start", { cwd }, sessionId, signal); // [4f I1] interrupt cuts the chain
      for (const { result } of results) {
        if (result.status === "ok" && result.stdout.trim().length > 0) {
          const content = "<system-reminder>\n"
            + this.sanitizeForReminder(result.stdout)
            + "\nThis reminder is invisible to the user — never mention it.\n</system-reminder>";
          input.push({ type: "message", role: "user", content });
        }
      }
    }

    await this.runThread({
      sessionId,
      threadId: MAIN_THREAD,
      instructionsFull,
      input,
      cwd,
      model: sel.model,
      reasoningEffort: sel.reasoningEffort,
      meta,
      depth: 0,
      signal,
      loaded,
    });
  }

  /**
   * The tool-calling loop shared by the main turn (`turn()`, depth 0, threadId MAIN_THREAD) and
   * (later) sub-agent threads. Steer-queue draining only applies to the main thread — a child
   * thread has no steer queue of its own.
   */
  private async runThread(opts: {
    sessionId: string;
    threadId: string;
    instructionsFull: string;
    input: TurnInputItem[];
    cwd: string;
    model: string;
    // Per-turn resolved reasoning-effort (turn()'s sel.reasoningEffort), threaded straight into
    // the TurnRequest below. Subagents inherit the SAME effort as their parent thread (opts
    // .reasoningEffort's fallback in the spawn bridge) — no per-agent-def override, matching the
    // model-override precedence's own comment: agent defs get a model override but not an effort
    // one (spec: "do NOT add per-agent effort").
    reasoningEffort?: string;
    meta: ReturnType<SessionStore["meta"]>;
    depth: number;
    signal: AbortSignal;
    loaded: Set<string>;
    excludeTools?: Set<string>;
    allowTools?: Set<string>;
    // 4h-i (CC parity: Agent.max_turns): a per-thread override of MAX_TOOL_ITERATIONS. Only the
    // spawn bridge (below) ever passes this — main-thread callers (turn()) never set it, so the
    // main thread's bound is unchanged (MAX_TOOL_ITERATIONS, 24). A child's effective bound is
    // 1-50 (spawn.ts's zod range / the bridge's own clamp); omitted → the default 24. Note this
    // can go EITHER direction relative to the default — a child asking for max_turns > 24 (up to
    // 50) gets a LARGER cap than the main thread's default, not just a smaller one. Additive/sync
    // only: no new async surface, just a different bound for that one child thread's own loop.
    maxTurns?: number;
    // 4h-i Task 4 (CC parity: Agent.isolation "worktree"): a per-thread override of the allowed
    // fs-tool roots. Only the spawn bridge (below) ever passes this, and only for a child
    // spawned with `isolation:"worktree"` — set to EXACTLY `[worktreeDir]`, not an addition to
    // the session's own roots (this.cfg.dirs.roots(sessionId) is SESSION-scoped, keyed by
    // sessionId not threadId — widening it here would leak the worktree into the PARENT's own
    // roots too, and persist past the child's lifetime). Undefined (every other caller) means
    // executeCall falls back to the session's normal live roots, unchanged behavior. roots[0]
    // MUST be the primary cwd (registry.ts's own contract) — the spawn bridge sets this to
    // exactly `[childCwd]` where childCwd is also what's passed as this same call's `cwd`.
    rootsOverride?: string[];
  }): Promise<{ finalText: string; stopReason: "end_turn" | "aborted" | "error"; errorMessage?: string }> {
    const { sessionId, threadId, instructionsFull, input, meta, signal, loaded, excludeTools, allowTools, rootsOverride } = opts;
    let cwd = opts.cwd;
    const tsEnabled = this.toolSearchEnabled();
    const deferThreshold = this.toolSearchThreshold();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let lastText = "";
    // The effective iteration bound for THIS thread — opts.maxTurns (spawn bridge only) or the
    // shared default. Computed once so the loop condition and the cap message below always agree
    // on the exact number.
    const effectiveMaxIterations = opts.maxTurns ?? MAX_TOOL_ITERATIONS;
    // 4h-i Task 3: the nesting-depth cap for THIS thread's own spawn attempts — see
    // EngineConfig.subagentMaxDepth's doc comment. Computed once so the spawn-gather filter below
    // and the belt-and-braces reject agree on the exact same number.
    const maxDepth = this.cfg.subagentMaxDepth ?? 5;
    // 4h-ii-b Task 4 (SM3): delete THIS child thread's steer queue when its runThread terminates,
    // so a send_message that landed but wasn't drained before the child finished can't resurface
    // when the SAME threadId is later resumed (resume reuses the threadId; its round-top drain
    // would otherwise pick up the stale entry). Called before EVERY terminal return below (the four
    // returns: error, end_turn/aborted, deniedByHuman, cap). NO-OP for MAIN — the main thread never
    // populates threadSteerQueue, so this leaves the byte-identical main path unchanged.
    const cleanupThreadSteer = () => { if (threadId !== MAIN_THREAD) this.threadSteerQueue.delete(threadId); };

    this.emit(sessionId, { type: "turn_started", sessionId, threadId });

    for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
      if (threadId === MAIN_THREAD) {
        const steers = this.steerQueue.get(sessionId);
        if (steers && steers.length) { for (const t of steers) input.push({ type: "message", role: "user", content: t }); steers.length = 0; }
      } else {
        // 4h-ii-b Task 4 (SM2): CHILD threads drain their OWN per-thread steer queue here — a
        // SEPARATE parallel branch to the MAIN branch above (which is untouched). A send_message to
        // this running child (sendToThread) queued into threadSteerQueue[threadId]; drain it into
        // this round's input exactly like the main loop drains steerQueue.
        // Whole-branch review C1/I1: PERSIST each drained message as a child user_message HERE, at
        // the drain — NOT at send time (sendToThread is queue-only now). The drain runs at the TOP of
        // a round: AFTER the prior round's tool_result was emitted+persisted (during that round's
        // dispatch), BEFORE the next provider call — so the persisted user_message gets a seq
        // strictly after the tool_result, never between a tool_call and its tool_result. That is
        // clean alternation on resume (childHistoryInput reconstructs [...tool_result, user], no
        // interior orphan function_call). A message that is never drained (child finishing before
        // this runs, I1) is simply never persisted → no trailing-user-turn corruption.
        const msgs = this.threadSteerQueue.get(threadId);
        if (msgs && msgs.length) {
          for (const t of msgs) {
            this.emit(sessionId, { type: "user_message", sessionId, threadId, text: t, clientName: "send_message" });
            input.push({ type: "message", role: "user", content: t });
          }
          msgs.length = 0;
        }
      }

      let textBuf = "";
      const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
      // history-parity Task 3: this round's opaque reasoning items, in provider emission order.
      // Prefixed ahead of the round's message/function_calls below, then cleared (must not leak
      // into the next round of the same turn). Empty when the provider emits none → the round's
      // input assembly is byte-identical to the pre-change behavior.
      const roundReasoning: string[] = [];
      let stop: "end_turn" | "tool_calls" | "aborted" | null = null;

      // Pins recomputed EVERY round (unlike buildInstructionsFull's once-per-thread read above) —
      // a mid-turn state change (plan approved, worktree entered/exited via the same-turn
      // bridges, a bg task started/exited) must be visible to the VERY NEXT round's specs() AND
      // to that round's tool-call dispatch below, not just the next turn. `loaded` is NEVER
      // mutated here — see the loadedTools NOTE above. Reused for every executeCall/
      // requestApproval invocation triggered by THIS round's calls, further down.
      const pins = tsEnabled ? this.pinnedTools(sessionId, meta, cwd) : new Set<string>();
      const effectiveLoaded = pins.size ? new Set([...loaded, ...pins]) : loaded;

      for await (const ev of this.cfg.provider.provider.streamTurn({
        model: opts.model,
        instructions: instructionsFull,
        input,
        tools: this.cfg.registry.specs(cwd, tsEnabled
            ? { loaded: effectiveLoaded, deferThreshold, builtinDeferral: true, deferExternals: this.toolSearchDeferExternals() }
            : undefined)
          .filter((s) => !excludeTools?.has(s.name))
          .filter((s) => !allowTools || allowTools.has(s.name)),
        signal,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      })) {
        if (ev.type === "text_delta") {
          textBuf += ev.delta;
          // TRANSIENT streaming event: broadcast to attached harnesses, never persisted (spec 2a).
          if (ev.delta.length > 0) this.cfg.hub.broadcastTransient(sessionId, { type: "assistant_delta", sessionId, threadId, delta: ev.delta });
        }
        else if (ev.type === "tool_call") calls.push(ev);
        else if (ev.type === "reasoning_item") {
          roundReasoning.push(ev.itemJson);
          // Persist AT ARRIVAL so seq order = provider emission order (the replay-order invariant,
          // spec §B4/§B6). itemJson is sensitive-opaque: this append is its only sink — never log it.
          this.emit(sessionId, { type: "reasoning_item", sessionId, threadId, itemJson: ev.itemJson });
        }
        else if (ev.type === "usage") { usage.inputTokens += ev.inputTokens; usage.outputTokens += ev.outputTokens; }
        else if (ev.type === "done") stop = ev.stopReason;
        else if (ev.type === "error") {
          this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: ev.message });
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
          if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, "error", usage); // [4f turn-end] provider-error terminal
          // `errorMessage` is consumed ONLY by the spawn bridge below (a CHILD thread's failure
          // must surface through the parent's tool_result — the agent_error/turn_completed events
          // just emitted are invisible to the parent model, which only sees the child's return
          // value). Main-thread callers (turn(), which just `await`s runThread without touching
          // the return value) are unaffected — see the grep note in the 4e-fix3 report.
          cleanupThreadSteer();
          return { finalText: lastText, stopReason: "error", errorMessage: ev.message };
        }
      }

      // Emission-order replay (spec §B4): reasoning items precede the round's message/function_calls.
      // Simplification, documented: all of a round's reasoning items are prefixed as a block in
      // arrival order (the Responses API emits reasoning before the items it reasons for — codex
      // report §13.1; a hypothetical mid-batch reasoning item would be hoisted to the block, never
      // dropped/reordered relative to other reasoning items). Empty roundReasoning → no-op, so the
      // no-reasoning path (every non-reasoning provider) is byte-identical to before.
      for (const r of roundReasoning) input.push({ type: "reasoning", itemJson: r });
      roundReasoning.length = 0;

      if (textBuf.length > 0) {
        this.emit(sessionId, { type: "assistant_message", sessionId, threadId, text: textBuf });
        input.push({ type: "message", role: "assistant", content: textBuf });
        lastText = textBuf;
      }

      if (stop !== "tool_calls" || calls.length === 0) {
        // A steer/message landed as we finished → drain at next iteration top, keep going. But an
        // interrupt must win: an aborted turn ends now with turn_completed(aborted) even if one is
        // queued (it stays queued for the next runTurn, e.g. via steer()'s own restart). 4h-ii-b
        // Task 4 (SM3): GENERALIZED from MAIN-only to also continue a CHILD when a send_message
        // landed as it finished (else a message sent while the child is on its final round would be
        // silently dropped) — `pending` reads the MAIN steerQueue for the main thread and this
        // child's threadSteerQueue for a child. For the MAIN thread this is byte-identical to the
        // prior `if (threadId === MAIN_THREAD) { const pending = steerQueue.get(sessionId); ... }`.
        const pending = threadId === MAIN_THREAD ? this.steerQueue.get(sessionId) : this.threadSteerQueue.get(threadId);
        if (stop !== "aborted" && pending && pending.length) { continue; }
        cleanupThreadSteer();
        this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: stop === "aborted" ? "aborted" : "end_turn", ...usage });
        if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, stop === "aborted" ? "aborted" : "end_turn", usage); // [4f turn-end] end_turn/aborted terminal
        if (opts.depth === 0 && this.cfg.titler) void this.cfg.titler.maybeTitle(sessionId);
        return { finalText: lastText, stopReason: stop === "aborted" ? "aborted" : "end_turn" };
      }

      // spawn_agent calls in this round run CONCURRENTLY (parallel subagent fan-out), computed
      // BEFORE the per-call loop below so N spawns in one assistant message don't serialize —
      // each child runs its own full runThread() to completion via SubagentManager.run (which
      // enforces maxConcurrent + a timeout), and the collected outcomes are consumed by the loop
      // below in the model's ORIGINAL call order (a plain Map keyed by callId, not the resolution
      // order of Promise.all). Only active when both cfg.subagents and cfg.agents are wired
      // (daemon.ts) AND this is a depth-0 thread — a depth>0 (child) thread trying to spawn is
      // denied in the loop below instead (belt-and-braces: its own specs already exclude
      // spawn_agent via excludeTools, so this only matters if a provider ignores that). 4h-i Task
      // 3: "depth-0 thread" generalizes to "depth < maxDepth" — any thread below the configured
      // nesting cap (not just the main thread) gathers its own spawn_agent calls through this SAME
      // bridge, recursively, so a depth-1 child can itself spawn a depth-2 grandchild when
      // maxDepth allows it.
      const spawnOutcomes = new Map<string, { output: string; isError: boolean }>();
      // [4f] callIds a pre-tool BLOCK short-circuited this round (Site 1 for bridged spawn_agent/
      // send_message, Site 2 for normal calls). Consulted by firePostTool so a blocked call — which
      // NEVER ran — gets no post-tool observe. Round-scoped (a fresh Set per provider round).
      const hookBlockedCallIds = new Set<string>();
      const spawnCalls = this.cfg.subagents && this.cfg.agents && opts.depth < maxDepth
        ? calls.filter((c) => c.name === "spawn_agent")
        : [];
      // 4h-ii-b Task 4 (SM1 + SM6, CC SendMessage): message a subagent by agentId/name. DEPTH-0
      // ONLY — only the main thread orchestrates in v1 (no agent-to-agent messaging), belt-and-
      // braces with send_message's unconditional exclusion from every child's tool set below.
      // Precomputed here (like spawnOutcomes) and consumed by the per-call dispatch loop below as a
      // send_message call's tool_result, so it never falls through to executeCall. Processed in a
      // simple `for` loop (not Promise.all): a running-target delivery is sync (sendToThread), a
      // finished-target resume is async (awaited), and there's no benefit to parallelizing them.
      const sendMessageOutcomes = new Map<string, { output: string; isError: boolean }>();
      const sendMessageCalls = opts.depth === 0 ? calls.filter((c) => c.name === "send_message") : [];
      if (spawnCalls.length > 0) {
        await Promise.all(spawnCalls.map(async (call) => {
          // [4f pre-tool — Site 1 (bridged)] FIRST statement in the callback, before ANY spawn work
          // (no thread_started/register/subagents.run yet). spawn_agent is bridge-intercepted, so it
          // hits the per-call loop's `preOutcome` branch and `continue`s BEFORE Site 2 — meaning
          // Site 2 never fires for it. Firing here is the ONLY pre-tool for this callId (no-double-
          // fire). F1: spawn_agent is READ_ONLY (no approval gate to run "after"), so its effect
          // boundary IS the gate boundary. A BLOCK sets this call's spawnOutcomes entry to the block
          // tool_result and returns — no thread_started ever emits.
          if (this.cfg.hooks) {
            const results = await this.cfg.hooks.runFor("pre-tool", { toolName: call.name, argsJson: call.argsJson, threadId }, sessionId, signal); // [4f I1] interrupt cuts the chain
            const blocked = results.find((r) => r.result.status === "blocked");
            if (blocked) { spawnOutcomes.set(call.callId, this.hookBlockOutcome(blocked)); hookBlockedCallIds.add(call.callId); return; }
          }
          let parsed: { prompt?: unknown; agentType?: unknown; model?: unknown; description?: unknown; max_turns?: unknown; mode?: unknown; isolation?: unknown; run_in_background?: unknown; name?: unknown; resume?: unknown } = {};
          try { parsed = JSON.parse(call.argsJson || "{}"); } catch { /* defensive: empty prompt below */ }
          const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
          const agentType = typeof parsed.agentType === "string" ? parsed.agentType : undefined;
          const modelOverride = typeof parsed.model === "string" ? parsed.model : undefined;
          const description = typeof parsed.description === "string" ? parsed.description : undefined;
          // 4h-ii-b Task 2 (CC parity: stable per-session handle for resume/send_message) — same
          // hand-parse-before-zod reasoning as model/description/mode/isolation/run_in_background
          // above: only a string is recognized; anything else (wrong type, absent) → undefined,
          // same as omitting the arg entirely (the child is addressable by agentId only, today's
          // unchanged behavior).
          const spawnName = typeof parsed.name === "string" ? parsed.name : undefined;
          // 4h-ii-b Task 3 (CC parity: resume a finished agent) — same hand-parse-before-zod
          // reasoning as name/model/mode above: only a non-empty string is recognized (an agentId
          // or a `name` to resume); anything else → undefined, i.e. today's fresh-spawn path.
          const resumeArg = typeof parsed.resume === "string" && parsed.resume.length > 0 ? parsed.resume : undefined;
          // 4h-i (CC parity: Agent.max_turns): this bridge hand-parses raw argsJson BEFORE
          // spawn.ts's own zod validation would ever run (same reason model/description are
          // hand-checked above), so a provider that ignores the declared `.int().positive().max(50)`
          // schema could still send an out-of-range or non-integer value through — clamp
          // defensively here rather than trusting the schema. Non-finite/non-integer/non-positive
          // → ignored (undefined), same as omitting the arg (falls back to MAX_TOOL_ITERATIONS).
          const maxTurns = typeof parsed.max_turns === "number" && Number.isInteger(parsed.max_turns) && parsed.max_turns > 0
            ? Math.min(parsed.max_turns, 50)
            : undefined;
          // 4h-i (CC parity: spawn_agent `mode`) — same hand-parse-before-zod reasoning as
          // max_turns/model/description above: only accept one of the 5 known mode strings;
          // anything else (wrong type, typo, provider hallucination) → undefined, same as omitting
          // the arg entirely (no override, child inherits the parent's policy). mapSpawnMode below
          // further narrows "default"/unrecognized to "no override" too.
          const modeRaw = typeof parsed.mode === "string" ? parsed.mode : undefined;
          // RESTRICT-ONLY (the security-critical bit — see restrictPolicy's own doc comment):
          // requestedPolicy is undefined when there's nothing to apply (mode absent/"default"/
          // unrecognized) — in that case childPolicy is EXACTLY meta.approvalPolicy (the parent's),
          // so childMeta below stays the SAME object as `meta`, byte-identical to pre-4h-i
          // behavior. When a mode DOES map to a policy, restrictPolicy takes the more restrictive
          // of {parent, requested} — a request that would WIDEN the child's permissions relative to
          // the parent (e.g. parent "ask" + requested "auto"/bypassPermissions) is silently denied
          // and the parent's policy wins; only a NARROWING request actually changes childPolicy.
          const requestedPolicy = mapSpawnMode(modeRaw);
          const childPolicy = requestedPolicy !== undefined ? restrictPolicy(meta.approvalPolicy, requestedPolicy) : meta.approvalPolicy;
          // 4h-i Task 4 (CC parity: Agent.isolation "worktree") — same hand-parse-before-zod
          // reasoning as mode/max_turns/model/description above: only the literal "worktree" is
          // recognized; anything else (wrong type, typo, provider hallucination) → false, same as
          // omitting the arg entirely (no isolation, child runs in the parent's own cwd — today's
          // unchanged behavior).
          const wantsWorktreeIsolation = parsed.isolation === "worktree";
          // 4h-ii-a (CC parity: Agent.run_in_background) — same hand-parse-before-zod reasoning as
          // isolation/mode/max_turns/model/description above: only the literal boolean `true` is
          // recognized; anything else (wrong type, absent, false) → false, same as omitting the arg
          // entirely (the synchronous, awaited path — today's unchanged behavior).
          const runInBackground = parsed.run_in_background === true;
          // 4h-ii-b Task 3 (D7): a resume takes over the WHOLE callback for this call — it sits
          // EARLY, before any fresh-spawn machinery (childId gen, description/model checks,
          // worktree, register). resumeThread does its own typed-error guards (no prompt / unknown
          // / still-running) BEFORE any thread_started re-emit or store write, and drives the
          // resumed run through the SAME sync/bg fork the fresh path uses. `threadId` is the
          // RESUMING thread (this callback's own thread) — it becomes the re-emitted child's
          // parentThreadId (D2).
          if (resumeArg !== undefined) {
            spawnOutcomes.set(call.callId, await this.resumeThread({
              sessionId,
              resumeArg,
              prompt,
              runInBackground,
              meta,
              model: opts.model,
              reasoningEffort: opts.reasoningEffort,
              depth: opts.depth,
              parentThreadId: threadId,
            }));
            return;
          }
          // Child-scoped meta: a shallow copy ONLY when childPolicy actually narrows (differs from
          // the parent's) — never mutate the shared `meta` object itself (that object is the SAME
          // one `turn()`'s dispatch loop uses for the REST of the parent's turn; mutating
          // `meta.approvalPolicy` here would corrupt the parent's own policy for later tool calls
          // in this same turn, and this bridge runs N spawns concurrently via Promise.all — a
          // second spawn's read of `meta.approvalPolicy` must never see a first spawn's override).
          // When childPolicy === meta.approvalPolicy (no mode, or an escalation request that was
          // denied), childMeta IS `meta` — the identical object, not just an equal-valued copy.
          const childMeta = childPolicy !== meta.approvalPolicy ? { ...meta, approvalPolicy: childPolicy } : meta;

          // 4g-ii (CC parity): spawn_agent's `description` is now a REQUIRED arg (spawn.ts's own
          // zod schema enforces this — but this concurrent bridge hand-parses call.argsJson and
          // short-circuits BEFORE executeCall's registry.execute() ever runs its zod validation,
          // same reason the model-override check below can't rely on the schema either. Must be
          // checked BEFORE thread_started/registerThread/subagents.run, mirroring the model-
          // override early-return just below. Message format matches registry.execute()'s own
          // "invalid arguments for X: field" wording for a consistent typed-error shape. No
          // `.trim()` here — matches spawn.ts's `z.string().min(1)` exactly (a whitespace-only
          // description satisfies min(1) too), so both paths agree on what counts as "present".
          if (!description) {
            spawnOutcomes.set(call.callId, { output: `invalid arguments for spawn_agent: description`, isError: true });
            return; // no thread_started, no thread registry entry, no subagents.run slot
          }

          const def = this.cfg.agents!.resolve(agentType, opts.cwd);

          // Defect 1 (4e gate F9): validate an EXPLICIT model override — modelOverride (the
          // calling model's own tool arg) or def.model (an agent-def's configured override), NOT
          // opts.model, which is the inherited parent-thread model and is already
          // resolver-validated (turn()'s sel.model / manager.ts's liveModel) — BEFORE emitting
          // thread_started or registering the thread. A provider whose models() enumerates a
          // known set (codex-oauth: the gpt-5.6 trio) rejects an override outside that set as a
          // typed error tool_result, so a hallucinated model id (e.g. "gpt-5-mini") fails fast
          // instead of spawning a child whose provider call 404s. A provider with an EMPTY
          // models() (openai-compatible with no static `models` configured, i.e. an arbitrary
          // endpoint the provider can't enumerate) can't validate anything, so the override
          // passes through unchanged — same as before this fix.
          const effectiveOverride = modelOverride ?? def.model;
          if (effectiveOverride !== undefined) {
            const known = this.cfg.provider.provider.models();
            if (known.length > 0 && !known.some((m) => m.id === effectiveOverride)) {
              const ids = known.map((m) => m.id).join(", ");
              spawnOutcomes.set(call.callId, {
                output: `unknown model '${effectiveOverride}' — available models: ${ids}; omit \`model\` to inherit the session's model`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
          }

          // 4h-ii-a (CC parity: Agent.run_in_background) — a bg spawn needs somewhere to land its
          // detached state; if the registry was never wired (daemon.ts) this fails as a typed
          // error BEFORE thread_started/registerThread/subagents.run, same reason the checks above
          // do — a caller must never get a `{agentId,status:"running"}` tool_result for a child
          // nothing is actually tracking (no way to observe completion, no `stop()` target).
          if (runInBackground && !this.cfg.bgAgents) {
            spawnOutcomes.set(call.callId, {
              output: `run_in_background is not available in this session`,
              isError: true,
            });
            return; // no thread_started, no thread registry entry, no subagents.run slot
          }

          // 4h-ii-b Task 2 (CC parity: stable per-session handle for resume/send_message,
          // Tasks 3-4) — a `name` colliding with an EXISTING agent in this session must fail the
          // spawn BEFORE thread_started/registerThread/subagents.run, same reason the
          // description/model/run_in_background checks above do: a caller must never get a ghost
          // thread for a name that `registry.get` would just resolve to the OTHER agent. The
          // message is byte-identical to what BackgroundAgentRegistry.register() itself produces
          // on the same collision (bg-agent-registry.ts) so both paths agree. This is only a
          // PRE-check for the common case — a name already registered from a prior spawn/turn; it
          // cannot see two sibling spawns in the SAME batch reusing one name (neither has
          // registered yet when this runs) — register()'s own collision result (surfaced at the
          // bg register() call below) is the backstop for that rare edge, unchanged.
          if (spawnName) {
            const existing = this.cfg.bgAgents?.get(spawnName, sessionId);
            if (existing) {
              spawnOutcomes.set(call.callId, {
                output: `name '${spawnName}' already in use by agent ${existing.agentId}`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
          }

          // 4h-i Task 4 (CC parity: Agent.isolation "worktree") — create the child's isolation
          // worktree BEFORE thread_started/registerThread/subagents.run, same as the
          // description/model checks above: a create failure (no git repo, or
          // WorktreeManager not wired into this session) must fail the spawn as a typed
          // isError tool_result with NO ghost thread, never a half-spawned child.
          // `createDetached` is a STATELESS WorktreeManager method (worktree.ts) — it does NOT
          // touch the per-session `sessions` map that enter_worktree/exit_worktree use, so a
          // child's ephemeral isolation worktree can never collide with (or be silently torn
          // down by) this session's own concurrent enter_worktree/exit_worktree state. Base off
          // opts.cwd (THIS spawning thread's own cwd — for a depth>0 spawner that is itself an
          // isolated child, that's already its own worktree dir, so a grandchild's isolation
          // worktree nests off the child's, not the top-level session repo).
          let isolatedWorktree: { dir: string; branch: string } | undefined;
          if (wantsWorktreeIsolation) {
            if (!this.cfg.worktrees) {
              spawnOutcomes.set(call.callId, {
                output: `isolation:"worktree" is not available in this session`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
            try {
              isolatedWorktree = this.cfg.worktrees.createDetached(opts.cwd, `spawn-${randomUUID().slice(0, 8)}`);
            } catch (err) {
              spawnOutcomes.set(call.callId, {
                output: `isolation:"worktree" requires a git repository (${err instanceof Error ? err.message : String(err)})`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
          }
          // The child's own cwd: the fresh worktree dir when isolated, otherwise unchanged
          // (opts.cwd, today's behavior). This is what the child's runThread actually runs at
          // AND what buildInstructionsFull below resolves project context relative to.
          const childCwd = isolatedWorktree?.dir ?? opts.cwd;

          const childId = "th_" + randomUUID().slice(0, 8);
          this.emit(sessionId, {
            type: "thread_started", sessionId, threadId: childId, parentThreadId: threadId,
            agentType: agentType ?? "general-purpose", prompt, description,
          });
          this.registerThread(sessionId, {
            threadId: childId, parentThreadId: threadId, agentType: agentType ?? "general-purpose", status: "running",
          });
          // 4h-i Task 3: spawn_agent is excluded from the child's own specs ONLY when the child
          // itself sits AT (or past) the nesting cap — i.e. it has no room left to spawn a
          // grandchild. `childDepth < maxDepth` keeps spawn_agent visible so the child can spawn
          // one more level (recursing into this SAME bridge, via its own runThread call, with the
          // gate-1 spawnCalls filter above reading ITS OWN opts.depth). ask_user/exit_plan_mode/
          // enter_plan_mode stay excluded from every child regardless of depth (unchanged).
          // 4h-ii-b Task 4 (SM6): send_message is excluded from EVERY child UNCONDITIONALLY (not
          // depth-conditional like spawn_agent) — v1 has no agent-to-agent messaging; only the main
          // thread orchestrates. Belt-and-braces with the bridge's own `opts.depth === 0` gate on
          // sendMessageCalls above. Captured into resumeCtx.excludeTools below, so a resumed child
          // stays excluded too.
          // 4h-ii-c Task 2: task_stop is excluded from EVERY child UNCONDITIONALLY too, same
          // rationale — v1 depth-0-only: a child must not be able to kill its siblings' or its
          // parent's OWN background agents/tasks, only the main thread orchestrates.
          const childDepth = opts.depth + 1;
          const childExcludeTools = new Set(["ask_user", "exit_plan_mode", "enter_plan_mode", "send_message", "task_stop"]);
          if (childDepth >= maxDepth) childExcludeTools.add("spawn_agent");
          // 4h-ii-b Task 1: instructionsFull is computed ONCE here — hoisted out of the bg and
          // sync closures below, which used to each build their own copy independently — so it
          // can be captured into `resumeCtx` just below AND reused by both closures without
          // recomputing. Every input (def.instructions, childCwd, a fresh childLoaded Set,
          // childPolicy, sessionId) is already known at this point in the bridge either way, so
          // this is purely a hoist: same value, computed earlier, not a behavior change.
          const childLoaded = new Set<string>();
          const instructionsFull = this.buildInstructionsFull(def.instructions, childCwd, childLoaded, childPolicy, sessionId);
          // 4h-ii-b Task 1: everything a future `resume` (Task 3) needs to re-run THIS child
          // EXCEPT input/signal — captured now, at spawn time, from the exact values this bridge
          // already computed to start the child's own live run below. Stored on the registry
          // entry regardless of run_in_background — BOTH the bg and sync paths register with this
          // SAME context (see each path's own register() call just below).
          const resumeCtx: ResumeContext = {
            agentType: agentType ?? "general-purpose",
            cwd: childCwd,
            roots: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
            approvalPolicy: childPolicy,
            model: effectiveOverride ?? opts.model,
            instructions: instructionsFull,
            maxTurns,
            // 4h-ii-b Task 3 (D5): capture-at-spawn, don't re-derive-at-resume. `openingPrompt` is
            // the child's original prompt (never persisted as a child event — the fresh run passes
            // it straight into `input` below), so resume must prepend it by hand. `loaded` is
            // snapshotted here (right after buildInstructionsFull, which does NOT mutate
            // childLoaded — so it's [] at a normal spawn); a resumed run re-derives deferral from
            // scratch rather than inheriting the child's later in-run ToolSearch loads. depth/
            // excludeTools/allowTools are the exact runThread args this spawn computed, arrayified.
            openingPrompt: prompt,
            description,
            depth: childDepth,
            loaded: Array.from(childLoaded),
            excludeTools: Array.from(childExcludeTools),
            allowTools: def.allowTools ? Array.from(def.allowTools) : undefined,
          };
          // 4h-ii-a (CC parity: Agent.run_in_background): the async/detached path — starts the
          // child through the SAME SubagentManager slot (concurrency-limited) + depth cap as the
          // synchronous path below, but does NOT await it. `entryAbort` is THIS bg entry's own
          // controller (bg-agent-registry.ts's `stop()` fires it) — the child's own runThread
          // signal is `AbortSignal.any([childSignal, entryAbort.signal])`. 4h-ii-c: this call's own
          // `subagents.run` now passes `timeoutMs: null` (below), so `childSignal` itself never
          // aborts on a clock anymore — `entryAbort` (a future task_stop) is this detached child's
          // ONLY kill mechanism. This call's tool_result is set SYNCHRONOUSLY, right here, before
          // any of the child's own work has run — Promise.all resolves as soon as this closure
          // returns, without waiting on the detached chain below.
          if (runInBackground) {
            const entryAbort = new AbortController();
            const registered = this.cfg.bgAgents!.register({
              agentId: childId,
              sessionId,
              threadId: childId,
              // `name` (4h-ii-b Task 2): the caller's own stable per-session handle (spawn.ts's
              // `name` arg) — undefined when omitted, unchanged register() behavior.
              name: spawnName,
              abort: entryAbort,
              resume: resumeCtx,
            });
            if (!registered.ok) {
              // childId itself can't collide (a fresh randomUUID), so this can only ever be a
              // NAME collision — the pre-check above already rejects the common case (a name
              // already registered from a prior spawn/turn) before thread_started even fires, so
              // this is the backstop for the one thing the pre-check can't see: two sibling
              // spawns in the SAME batch reusing one name (neither had registered yet when the
              // pre-check ran for either). thread_started already fired above for THIS call, so
              // this must still complete that thread entry rather than leaving a ghost "running" thread.
              this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason: "error" });
              this.completeThread(sessionId, childId, "error");
              spawnOutcomes.set(call.callId, { output: registered.error, isError: true });
              return;
            }
            void this.cfg.subagents!.run(async (childSignal) => {
              return this.runThread({
                sessionId,
                threadId: childId,
                instructionsFull,
                input: [{ type: "message", role: "user", content: prompt }], // FRESH — no parent history
                cwd: childCwd,
                model: effectiveOverride ?? opts.model,
                // Subagents inherit the PARENT thread's resolved reasoning effort — no per-agent-def
                // override, same as the synchronous path below.
                reasoningEffort: opts.reasoningEffort,
                meta: childMeta,
                depth: childDepth,
                // registry.stop() (entryAbort.signal) is now the ONLY thing that can abort this
                // detached child — see this branch's own doc comment above (4h-ii-c: childSignal
                // itself never fires on a clock anymore, `timeoutMs: null` just below).
                signal: AbortSignal.any([childSignal, entryAbort.signal]),
                loaded: childLoaded,
                excludeTools: childExcludeTools,
                allowTools: def.allowTools,
                maxTurns,
                rootsOverride: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
              });
            }, {
              reentrant: opts.depth > 0,
              // 4h-ii-c: a detached `run_in_background` child has no waiting parent to time out
              // FOR — the 4h-ii-a T3 review flagged the bg spawn's inherited SubagentManager
              // timeout as something to "relax only once a manual kill exists" (a runaway
              // detached child was previously bounded ONLY by this clock, with no way to kill it
              // early). task_stop (this same phase) now IS that manual kill via `entryAbort`
              // above — but task_stop is main-thread-only (it's in childExcludeTools, and only the
              // MAIN thread ever learns a bg agentId from the tool_result), so it can only reach a
              // DEPTH-0 detached child. A depth>0 spawner's own bg grandchild would be untimed AND
              // unkillable (entryAbort doesn't cascade from a stopped parent into a grandchild's
              // AbortSignal.any set, and there's no session-level kill-all) — so the relax is
              // scoped to depth 0 only: `timeoutMs: null` there (untimed, task_stop reaches it),
              // `undefined` at depth>0 (falls back to SubagentManager's own 300s default, the
              // pre-4h-ii-c bound, since nothing could stop it manually). Whole-branch review C1
              // (4h-ii-c): "untimed ⟺ killable".
              timeoutMs: opts.depth === 0 ? null : undefined,
            })
              .then((result) => {
                const stopReason = result.ok ? result.value.stopReason : "error";
                this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason });
                this.completeThread(sessionId, childId, stopReason);
                // Same outcome shape as the synchronous path's spawnOutcomes.set below (Defect 2,
                // 4e gate F10) — a completed-but-errored child (result.ok, stopReason "error")
                // reports as a failure, not a quiet success. This result is only READ later — by
                // the completion reminder (a separate 4h-ii-a task, not built here) or a future
                // resume/get — never by this already-returned tool_result.
                this.cfg.bgAgents!.complete(childId, !result.ok
                  ? { ok: false, result: `subagent (${agentType ?? "general-purpose"}) ${result.error}` }
                  : result.value.stopReason === "error"
                    ? { ok: false, result: `subagent (${agentType ?? "general-purpose"}) failed: ${result.value.errorMessage ?? "provider error"}` }
                    : { ok: true, result: result.value.finalText || "the subagent finished without a final message" },
                  // 4h-ii-c: only reachable today if a future config re-adds a bg timeout (this
                  // call itself now runs with `timeoutMs: null`, above) — wired now so a timed-out
                  // detached child is never misreported as a generic "failed" once one exists.
                  !result.ok && result.timedOut ? { timedOut: true } : undefined);
              })
              .catch((err) => {
                // Defensive only — SubagentManager.run() itself never throws (see its own doc
                // comment); this guards against a throw in the `.then` handler above (e.g. a
                // registry bug) so a detached child NEVER leaves an unhandled rejection.
                const message = err instanceof Error ? err.message : String(err);
                this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason: "error" });
                this.completeThread(sessionId, childId, "error");
                this.cfg.bgAgents!.complete(childId, { ok: false, result: message });
              })
              .finally(() => {
                // 4h-i Task 4 teardown, mirrored for the detached path — see the synchronous
                // path's own `finally` block below for the full rationale (clean-only removal,
                // dirty worktrees left on disk for review).
                if (isolatedWorktree) {
                  try {
                    const removed = this.cfg.worktrees!.removeDetached(isolatedWorktree.dir, opts.cwd, true);
                    if (!removed) {
                      console.error(`spawn_agent isolation:"worktree": left dirty worktree at ${isolatedWorktree.dir} (uncommitted changes) — not auto-removed`);
                    }
                  } catch (err) {
                    console.error(`spawn_agent isolation:"worktree": teardown failed for ${isolatedWorktree.dir}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              })
              .catch(() => {
                // Terminal net (whole-branch review): the `.catch` above re-calls emit/
                // completeThread, which can throw again for the same PERSISTENT cause (e.g. an
                // appendFileSync IO fault on the completion emit), and `.finally` re-propagates —
                // leaving the void-ed detached chain rejected with no handler. The synchronous
                // path surfaces the same fault as a caught turn error, but a detached child has no
                // caller to surface to, so swallow it here rather than emit an unhandled rejection.
              });
            // NOTE: only {agentId, status} — never the AbortController/registry entry itself —
            // ever reaches the model, via this tool_result JSON.
            spawnOutcomes.set(call.callId, {
              output: JSON.stringify({ agentId: childId, status: "running" }),
              isError: false,
            });
            return; // Promise.all resolves without waiting on the detached chain above
          }

          // 4h-ii-b Task 1: register a SYNC spawn in the bg-agent registry too — before this task
          // only `run_in_background` spawns ever got a registry entry. CC parity: ANY finished
          // agent (sync or async) must be resumable, and `resume` (Task 3) looks a child up by
          // agentId in this SAME registry regardless of how it was spawned. `entryAbort` mirrors
          // the bg path's own controller above (AgentEntry.abort is a mandatory field) and is
          // folded into this child's own signal below via AbortSignal.any, exactly like the bg
          // path — nothing calls registry.stop() yet (no stop tool exists today), but this keeps
          // a future stop() working uniformly for sync- and bg-spawned children without touching
          // this bridge again. Gated on `this.cfg.bgAgents` being wired at all (optional, same as
          // the bg path's own guard) — when it's absent this block is a no-op and the sync spawn
          // runs exactly as it did before this task (plain `childSignal`, no registry entry).
          // Registration failure is defensive-only, same reasoning as the bg path's own
          // register() call above: childId can't collide (a fresh randomUUID) and a `name`
          // collision with an EXISTING agent was already rejected by the pre-check before
          // thread_started fired — the only thing this register() can still reject is a
          // same-batch sibling reusing one name (see the bg path's own comment above). Unlike the
          // bg path, a failure here must NOT fail the sync spawn itself (the registry is a BONUS
          // here, not the only channel back to the caller like it is for a detached child), so
          // `registeredInBg` just guards the later complete() call.
          const entryAbort = this.cfg.bgAgents ? new AbortController() : undefined;
          const registeredInBg = !!(entryAbort && this.cfg.bgAgents!.register({
            agentId: childId,
            sessionId,
            threadId: childId,
            name: spawnName,
            abort: entryAbort,
            resume: resumeCtx,
          }).ok);

          // Nested-spawn saturation fix (T3 review): `opts.depth` is THIS spawning thread's own
          // depth — >0 means it already holds a concurrency slot (it's itself a child), so this
          // run() call is a REENTRANT acquire. SubagentManager bounds a reentrant wait
          // (acquireTimeoutMs) instead of queueing unbounded, so pool saturation under nesting
          // fails fast with a typed error instead of stalling for the full per-run timeoutMs
          // (300s) — see SubagentManager.acquire's doc comment. A depth-0 (top-level) spawn is
          // never reentrant and keeps its existing unbounded queueing behind busy siblings.
          try {
            const result = await this.cfg.subagents!.run(async (childSignal) => {
              return this.runThread({
                sessionId,
                threadId: childId,
                instructionsFull,
                input: [{ type: "message", role: "user", content: prompt }], // FRESH — no parent history
                cwd: childCwd,
                model: effectiveOverride ?? opts.model,
                // Subagents inherit the PARENT thread's resolved reasoning effort — no per-agent-def
                // override (agent defs only carry a model override, never an effort one).
                reasoningEffort: opts.reasoningEffort,
                // childMeta: the SAME object as `meta` (byte-identical, no copy) when there's no
                // narrowing `mode` override — the child inherits the parent's (possibly
                // later-mutated) approval policy, exactly as before 4h-i. Only a NARROWING `mode`
                // (restrictPolicy above) produces a child-scoped shallow copy, so the parent's own
                // `meta.approvalPolicy` is NEVER mutated by a spawn's mode override — see
                // `childMeta`'s own doc comment above for why (concurrent spawns, same-turn parent
                // policy corruption).
                meta: childMeta,
                depth: childDepth,
                // registeredInBg → entryAbort is defined (see the register block above) and its
                // signal is folded in, mirroring the bg path's own AbortSignal.any wiring; absent
                // registration (no bgAgents wired) → plain childSignal, unchanged pre-4h-ii-b
                // behavior.
                signal: registeredInBg ? AbortSignal.any([childSignal, entryAbort!.signal]) : childSignal,
                loaded: childLoaded,
                // enter_plan_mode excluded alongside exit_plan_mode (4g Task 4): the child inherits
                // the parent's (or, with a narrowing `mode` override, its OWN child-scoped) `meta`
                // object BY REFERENCE (just above) — an unexcluded child calling enter_plan_mode
                // would mutate that object's `approvalPolicy` AND persist it via `cfg.setPolicy`
                // (when it's the SAME object as the parent's, that would silently put the WHOLE
                // session into plan mode once the spawn returns). Plan-mode entry/exit stays a
                // main-thread-only decision regardless of which meta object the child got.
                // spawn_agent's presence/absence here is depth-conditional — see childExcludeTools
                // above (4h-i Task 3).
                excludeTools: childExcludeTools,
                allowTools: def.allowTools,
                maxTurns,
                // 4h-i Task 4: isolated child's fs tools are fenced to EXACTLY the worktree dir
                // (not additive to the session's own roots — see rootsOverride's own doc comment
                // on RunThreadOpts). Undefined (no isolation) → executeCall falls back to the
                // session's normal live roots, unchanged behavior.
                rootsOverride: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
              });
            }, { reentrant: opts.depth > 0 });
            const stopReason = result.ok ? result.value.stopReason : "error";
            this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason });
            this.completeThread(sessionId, childId, stopReason);
            // Defect 2 (4e gate F10): a child that ran to completion (result.ok) but whose OWN
            // final round hit a provider error (runThread's error branch, stopReason "error") must
            // be reported to the parent as a FAILURE, not as a quiet "finished without a final
            // message" success — the parent's tool_result is the only channel a child has back to
            // its caller (unlike the main thread, whose agent_error event the user sees directly).
            // The `!result.ok` branch (SubagentManager timeout / thrown error) is unchanged.
            // Computed ONCE (4h-ii-b Task 1) — the exact same {output,isError}-shaped outcome
            // both feeds the parent's tool_result (spawnOutcomes, unchanged wording/behavior from
            // before this task) AND, when this sync spawn was also registered above
            // (registeredInBg), the registry's own complete() — same {ok,result} shape the bg
            // path's own `.then` handler already uses just above, so a `resume`d-then-re-finished
            // sync child and a bg child report through the exact same registry contract.
            const outcome: { output: string; isError: boolean } = !result.ok
              ? { output: `subagent (${agentType ?? "general-purpose"}) ${result.error}`, isError: true }
              : result.value.stopReason === "error"
                ? { output: `subagent (${agentType ?? "general-purpose"}) failed: ${result.value.errorMessage ?? "provider error"}`, isError: true }
                : { output: result.value.finalText || "the subagent finished without a final message", isError: false };
            spawnOutcomes.set(call.callId, outcome);
            // { notified: true } — this sync child's result already reached the parent directly
            // as this SAME call's tool_result, this SAME turn; without this the next turn's
            // buildBgCompletionReminder sweep (built for run_in_background's DETACHED
            // completions) would re-surface it as a "background agent finished" reminder,
            // leaking the child's raw output into a turn that never asked for it (see
            // BackgroundAgentRegistry.complete's own doc comment).
            // 4h-ii-c: this sync spawn's own `subagents.run` call above is UNCHANGED (no
            // `timeoutMs` override — still the constructor default, 300s), but `timedOut` is
            // threaded through here too for correctness/consistency with the bg path's own
            // `.then` handler above, in case `result` ever IS a timeout (it still can be, since
            // this path's run() call has no override).
            if (registeredInBg) this.cfg.bgAgents!.complete(childId, { ok: !outcome.isError, result: outcome.output },
              { notified: true, timedOut: !result.ok && result.timedOut });
          } finally {
            // 4h-i Task 4: teardown runs whether the child succeeded, errored, or timed out —
            // clean-only (mirrors exit_worktree's default guard AND CC's own isolation
            // teardown): a CLEAN worktree (no uncommitted changes) is removed; a DIRTY one is
            // left on disk for the user to review (logged) — NO auto-merge, NO force-remove
            // (no data loss). `this.cfg.worktrees` is guaranteed set here (isolatedWorktree is
            // only ever assigned after that same guard above).
            if (isolatedWorktree) {
              try {
                const removed = this.cfg.worktrees!.removeDetached(isolatedWorktree.dir, opts.cwd, true);
                if (!removed) {
                  console.error(`spawn_agent isolation:"worktree": left dirty worktree at ${isolatedWorktree.dir} (uncommitted changes) — not auto-removed`);
                }
              } catch (err) {
                console.error(`spawn_agent isolation:"worktree": teardown failed for ${isolatedWorktree.dir}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }));
      }

      // 4h-ii-b Task 4 (SM1/SM4): the send_message bridge. Each depth-0 send_message call resolves
      // its `to` (agentId/name) in this session's bg-agent registry and routes: a RUNNING target
      // gets the message queued into its thread steer queue (sendToThread); a TERMINAL target is
      // resumed in the BACKGROUND (resumeThread with runInBackground:true — send_message never
      // blocks the parent, and this reuses ALL of T3's guards: clean-termination, removed-worktree,
      // policy no-widen). The precomputed {output,isError} becomes the call's tool_result in the
      // dispatch loop below (read via `preOutcome`), so a send_message call never reaches
      // executeCall. `to`/`message` are hand-parsed from argsJson (string-only) BEFORE any zod
      // would run — same defensive shape as the spawn bridge — so a malformed call is a typed error.
      for (const call of sendMessageCalls) {
        // [4f pre-tool — Site 1 (bridged)] FIRST statement, before any send_message work. Same
        // rationale as the spawn_agent bridge above: send_message is bridge-intercepted (its
        // outcome lands in sendMessageOutcomes → preOutcome branch → continue), so it never reaches
        // Site 2 — this is its one and only pre-tool fire. send_message is READ_ONLY (no gate), so
        // its effect boundary is the gate boundary. A BLOCK sets the outcome and skips the delivery.
        if (this.cfg.hooks) {
          const results = await this.cfg.hooks.runFor("pre-tool", { toolName: call.name, argsJson: call.argsJson, threadId }, sessionId, signal); // [4f I1] interrupt cuts the chain
          const blocked = results.find((r) => r.result.status === "blocked");
          if (blocked) { sendMessageOutcomes.set(call.callId, this.hookBlockOutcome(blocked)); hookBlockedCallIds.add(call.callId); continue; }
        }
        let smParsed: { to?: unknown; message?: unknown } = {};
        try { smParsed = JSON.parse(call.argsJson || "{}"); } catch { /* defensive: typed error below */ }
        const to = typeof smParsed.to === "string" && smParsed.to.length > 0 ? smParsed.to : undefined;
        const message = typeof smParsed.message === "string" && smParsed.message.length > 0 ? smParsed.message : undefined;
        if (!to) { sendMessageOutcomes.set(call.callId, { output: "invalid arguments for send_message: to", isError: true }); continue; }
        if (!message) { sendMessageOutcomes.set(call.callId, { output: "invalid arguments for send_message: message", isError: true }); continue; }
        // No registry wired (daemon.ts never built bgAgents) → nothing to address, mirroring the
        // spawn bridge's own `run_in_background && !bgAgents` guard.
        if (!this.cfg.bgAgents) { sendMessageOutcomes.set(call.callId, { output: "send_message is not available in this session", isError: true }); continue; }
        const target = this.cfg.bgAgents.get(to, sessionId);
        if (!target) { sendMessageOutcomes.set(call.callId, { output: `no agent '${to}' to message`, isError: true }); continue; }
        if (target.status === "running") {
          this.sendToThread(sessionId, target.threadId, message);
          sendMessageOutcomes.set(call.callId, { output: `message delivered to '${to}'`, isError: false });
          continue;
        }
        // terminal (completed/failed/stopped/timeout) → resume it in the background. Its {output,isError}
        // (a bg resume returns {agentId,status:"running"} immediately, or a T3 guard's typed error)
        // becomes this send_message call's tool_result.
        sendMessageOutcomes.set(call.callId, await this.resumeThread({
          sessionId,
          resumeArg: to,
          prompt: message,
          runInBackground: true,
          meta,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          depth: opts.depth,
          parentThreadId: threadId,
        }));
      }

      for (const call of calls) {
        this.emit(sessionId, { type: "tool_call", sessionId, threadId, callId: call.callId, name: call.name, argsJson: call.argsJson });
        input.push({ type: "function_call", callId: call.callId, name: call.name, argsJson: call.argsJson });

        let outcome: { output: string; isError: boolean; deniedByHuman?: boolean };
        // A precomputed outcome from the spawn OR send_message bridge above becomes this call's
        // tool_result verbatim (both are computed BEFORE this loop so N spawns/messages in one
        // assistant message don't serialize the dispatch), so it never falls through to executeCall.
        const preOutcome = spawnOutcomes.get(call.callId) ?? sendMessageOutcomes.get(call.callId);
        if (preOutcome) {
          outcome = preOutcome;
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
          // [4f post-tool — bridged outcome] observe a spawn_agent/send_message call's result.
          // firePostTool SKIPS a pre-tool-blocked call (hookBlockedCallIds) — that call never ran.
          if (this.cfg.hooks) await this.firePostTool(sessionId, threadId, call, outcome, hookBlockedCallIds, signal); // [4f I1] interrupt cuts the chain
          continue;
        }
        if (call.name === "spawn_agent" && opts.depth >= maxDepth) {
          // Belt-and-braces: a thread AT the nesting cap already had spawn_agent excluded from its
          // specs (childExcludeTools above), so this only fires if a provider ignores the tool
          // list and calls it anyway. A thread BELOW the cap (opts.depth < maxDepth) never reaches
          // here for spawn_agent — its calls were already siphoned off into spawnOutcomes by the
          // spawn-gather filter earlier in this same round (4h-i Task 3).
          outcome = { output: "subagents cannot spawn further subagents", isError: true };
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
          continue;
        }
        // 4g fix-wave-1 (T1 review): reject a deferred:true built-in that's called before being
        // loaded/pinned — BEFORE any of the bridge intercepts below get a chance to run. Those
        // bridges (worktree, exit_plan_mode) dispatch straight from `call.name`, bypassing
        // executeCall entirely — so without this guard a model calling e.g. enter_worktree
        // unloaded would silently reach the bridge and succeed, instead of being told to load its
        // schema via ToolSearch first like every other deferred tool. Mirrors registry.execute()'s
        // own rejection message byte-for-byte, and reuses THIS round's `effectiveLoaded` (loaded ∪
        // pins, computed once above) — so a PINNED tool (exit_plan_mode while policy==="plan",
        // exit_worktree while a worktree is active) is IN effectiveLoaded and naturally passes:
        // the states that make a tool meaningful keep it callable. `isDeferredBuiltin`'s
        // `tsEnabled` arg is this round's SAME toolSearchEnabled() flag threaded through specs()/
        // executeCall above — when toolSearch is disabled it always returns false, so this guard
        // is a no-op then, preserving the pre-4g byte-identical invariant.
        if (this.cfg.registry.isDeferredBuiltin(call.name, tsEnabled) && !effectiveLoaded.has(call.name)) {
          outcome = { output: `tool ${call.name} is deferred — load its schema via ToolSearch first`, isError: true };
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
          continue;
        }
        const decision = this.cfg.gate.evaluate(call.name, meta.approvalPolicy);
        // Worktree tools are MUTATING (gate.ts), so under `ask` policy (the DEFAULT) `decision` is
        // "ask", not "allow" — checked here, BEFORE the generic `decision === "ask"` branch below,
        // so that branch never gets first crack at a worktree call. Without this dedicated branch,
        // the generic one would run executeCall on approval (the tool's own placeholder run()),
        // and the bridge (setCwd + git + same-turn cwd + worktree_* events) would NEVER run outside
        // `auto` policy — see task-4-report.md for the bug writeup.
        const isWorktree = (call.name === "enter_worktree" || call.name === "exit_worktree") && !!this.cfg.worktrees;
        // [4f pre-tool — Site 2 (normal calls)] Post-gate (decision computed just above), before ANY
        // dispatch branch runs/approves. Bridged calls (spawn_agent/send_message) NEVER reach here —
        // they were siphoned into spawn/sendMessageOutcomes and hit the `preOutcome` branch ABOVE,
        // which `continue`s — so pre-tool fires EXACTLY ONCE per call (bridged ⇒ Site 1; normal ⇒
        // Site 2), no double-fire. F1 (deny-only): a `blocked` result short-circuits to an isError
        // tool_result; every other status (ok/error/timeout, F2 fail-open) falls through to the
        // normal gate/approval/executeCall dispatch UNCHANGED — the hook can restrict, never widen.
        // Kept as ONE logical site here rather than threaded through each requestApproval onApprove
        // (LOCKED DECISION 2): for an `ask` call the hook fires before the approval prompt, but since
        // it can ONLY block (deny-only) that never bypasses the gate — a blocked call simply never
        // reaches the prompt. A `deny` (plan-mode) call still fires the hook; block-or-not is moot
        // there (the tool won't run either way), acceptable for a single site.
        if (this.cfg.hooks) {
          const results = await this.cfg.hooks.runFor("pre-tool", { toolName: call.name, argsJson: call.argsJson, threadId }, sessionId, signal); // [4f I1] interrupt cuts the chain
          const blocked = results.find((r) => r.result.status === "blocked");
          if (blocked) {
            outcome = this.hookBlockOutcome(blocked);
            hookBlockedCallIds.add(call.callId); // post-tool must NOT observe a call that never ran
            this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
            input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
            continue;
          }
        }
        if (decision === "deny") {
          // Plan mode's blanket deny (gate.ts): tool NOT run. No approval flow here — the point
          // of plan mode is that nothing mutates until exit_plan_mode is approved.
          outcome = {
            output: "Blocked in plan mode — you are researching and planning, so file changes and commands are disabled. Make no changes; when your plan is ready, call exit_plan_mode to present it for approval.",
            isError: true,
          };
        } else if (isWorktree) {
          // "allow" (auto policy) runs the bridge directly, synchronously. "ask" (default policy)
          // still waits on the ApprovalBroker via requestApproval, but passes the bridge itself as
          // the onApprove action, so an APPROVED enter/exit runs the bridge — not executeCall.
          // `newCwd` is captured through the `onCwd` callback in both branches; because
          // runWorktreeBridge is synchronous, the callback (if any) has already run by the time
          // each branch's `await`/direct call returns, so reading `newCwd` right after is safe —
          // and it's reassigned to the loop's local `cwd` so a same-turn follow-up call resolves
          // into (or back out of) the worktree either way (mirrors the plan bridge's same-turn
          // `meta.approvalPolicy` mutation above).
          let newCwd: string | undefined;
          const onCwd = (next: string) => { newCwd = next; };
          if (decision === "ask") {
            outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
              timeoutMs: this.cfg.approvalTimeoutMs ?? 5 * 60_000,
              summary: `${call.name} ${call.argsJson.slice(0, 160)}`,
              // no denialMessage → the helper defaults to `denied by ${res.by}` (unchanged behavior)
            }, loaded, async () => this.runWorktreeBridge(call, sessionId, threadId, cwd, onCwd), pins, rootsOverride);
          } else {
            outcome = this.runWorktreeBridge(call, sessionId, threadId, cwd, onCwd);
          }
          if (newCwd !== undefined) cwd = newCwd;
        } else if (decision === "ask") {
          outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
            timeoutMs: this.cfg.approvalTimeoutMs ?? 5 * 60_000,
            summary: `${call.name} ${call.argsJson.slice(0, 160)}`,
            // no denialMessage → the helper defaults to `denied by ${res.by}` (unchanged behavior)
          }, loaded, undefined, pins, rootsOverride);
        } else if (call.name === "exit_plan_mode" && this.cfg.plans && meta.approvalPolicy === "plan") {
          outcome = await this.runPlanBridge(call, sessionId, threadId, meta);
        } else if (call.name === "enter_plan_mode") {
          // Unconditional — no PlanBroker/manager dependency to gate on (see runEnterPlanBridge's
          // doc comment). decision is always "allow" here (enter_plan_mode is in gate.ts's
          // READ_ONLY set under every policy), so this branch is reached for every call.
          outcome = await this.runEnterPlanBridge(sessionId, meta);
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
            outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride);
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
              }, loaded, undefined, pins, rootsOverride);
            } else {
              outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride);
            }
          }
        } else {
          outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride);
        }

        this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
        input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
        // [4f post-tool — normal outcome] observe the executed call's result (success or isError).
        // A pre-tool-blocked normal call `continue`d at Site 2 and never reached here, so it's
        // naturally skipped (hookBlockedCallIds guards it anyway, defense-in-depth).
        if (this.cfg.hooks) await this.firePostTool(sessionId, threadId, call, outcome, hookBlockedCallIds, signal); // [4f I1] interrupt cuts the chain

        // A human explicitly denied this action → end the turn now and return control to the
        // user (Claude Code parity). The denied tool_result is already persisted above, so the
        // NEXT turn's context shows "you tried X, the user denied it" alongside whatever the
        // user then says. Any later calls in this same batch were never emitted/pushed (the
        // loop pushes function_call + tool_result one at a time), so nothing is left dangling.
        if (outcome.deniedByHuman) {
          cleanupThreadSteer();
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "end_turn", ...usage });
          if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, "end_turn", usage); // [4f turn-end] deniedByHuman terminal
          if (opts.depth === 0 && this.cfg.titler) void this.cfg.titler.maybeTitle(sessionId);
          return { finalText: lastText, stopReason: "end_turn" };
        }
      }
    }

    const capMessage = `tool-iteration cap (${effectiveMaxIterations}) reached`;
    cleanupThreadSteer();
    this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: capMessage });
    this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
    if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, "error", usage); // [4f turn-end] iteration-cap terminal
    return { finalText: lastText, stopReason: "error", errorMessage: capMessage };
  }

  /**
   * 4h-ii-b Task 3 (D6/D7): re-run a FINISHED child thread WITH its full prior context — the
   * engine half of spawn_agent `resume`. Called from the spawn bridge's per-call callback (an
   * early branch that takes over the whole callback for a resume call), and structured so T4's
   * `send_message`-to-a-finished-agent can reuse the SAME "re-run this terminal thread with a new
   * prompt" path (a resume of a finished agent IS a send_message to a finished agent).
   *
   * Returns the {output,isError} outcome the caller drops into `spawnOutcomes` — for a sync resume
   * the child's final text (awaited); for a `run_in_background` resume, {agentId,status:"running"}
   * immediately (the detached run re-completes the registry entry off-turn, exactly like a fresh
   * bg spawn). NO worktree is created or torn down here (D6): a resume reuses `rc.roots`.
   */
  private async resumeThread(args: {
    sessionId: string;
    resumeArg: string;
    prompt: string;
    runInBackground: boolean;
    meta: ReturnType<SessionStore["meta"]>;
    model: string;
    reasoningEffort?: string;
    depth: number;
    parentThreadId: string;
  }): Promise<{ output: string; isError: boolean }> {
    const { sessionId, resumeArg, prompt, runInBackground, meta, model, reasoningEffort, depth, parentThreadId } = args;

    // D7 — all typed-error guards BEFORE any thread_started re-emit / store write / runThread.
    if (!prompt) return { output: "resume requires a prompt (the new instruction to continue with)", isError: true };
    const entry = this.cfg.bgAgents?.get(resumeArg, sessionId);
    if (!entry) return { output: `no agent '${resumeArg}' to resume`, isError: true };
    if (entry.status === "running") return { output: `agent '${resumeArg}' is still running — use send_message to message it`, isError: true };
    const rc = entry.resume;
    // Defensive (Task 1's contract): an entry may predate the resume-context capture, or have been
    // registered by a caller that never built one — such an agent is simply not resumable.
    if (!rc) return { output: `agent '${resumeArg}' has no saved context to resume`, isError: true };

    // T3 REVIEW (IMPORTANT) — CLEAN-TERMINATION guard, by HISTORY SHAPE, not by status. Reconstruct
    // the child's PRE-EXISTING stored history HERE (before the reopen / thread_started re-emit /
    // user_message persist below, so it reflects the child's TRUE end state) and require it to END ON
    // AN ASSISTANT TURN. This directly enforces D1's alternation invariant regardless of status: a
    // cleanly COMPLETED or cleanly STOPPED child ends on an assistant_message and IS resumable; a
    // capped / failed / mid-tool child ends on a tool_result or an orphan function_call (or has no
    // history) and is NOT — resuming it would persist user(newPrompt) after that trailing item and
    // hand the provider [...tool_result, user] (non-standard adjacency) or [...function_call, user]
    // (orphan call → near-certain hard reject), since openai-compatible.ts mapInput is a blind 1:1
    // map with no coalescing/validation.
    //   A STATUS CHECK IS INSUFFICIENT — status is orthogonal to last-event shape (verified against
    // this file): the tool-iteration cap path (~:1362) returns stopReason:"error" → the completion
    // fork (~:1188) maps that to isError:true → complete(ok:false) → status "failed" (NOT
    // "completed"); the human-denied path (~:1354) emits the denied tool_result then returns
    // stopReason:"end_turn" → isError:false → complete(ok:true) → status "completed" YET its last
    // child event is a tool_result; and a cleanly-stopped child is status "stopped" yet ends on an
    // assistant turn and SHOULD resume. So neither `=== "completed"` nor `!== "failed"` gets this
    // right — only the last-event shape does. "Resume a capped agent for more turns" is a headline
    // use case, so reject it GRACEFULLY here rather than let a malformed provider input through.
    const priorHistory = this.childHistoryInput(sessionId, entry.threadId);
    // whole-branch #3: a cleanly-finished child whose FINAL round emitted a reasoning item then
    // ended the turn with EMPTY assistant text (see runThread's `if (textBuf.length > 0)` — no
    // assistant_message persisted) leaves a TRAILING reasoning item as its last reconstructed item.
    // Reasoning is opaque, ORDER-TRANSPARENT state (it always PRECEDES the item it reasons for), so
    // it must not count as the terminal shape: walk back past any trailing reasoning items to the
    // last REAL item, then apply the assistant-turn check on THAT. A [tool_result, reasoning] tail
    // (mid-tool + stray reasoning) still lands on the tool_result → correctly still rejected.
    let lastIdx = priorHistory.length - 1;
    while (lastIdx >= 0 && priorHistory[lastIdx]!.type === "reasoning") lastIdx--;
    const lastPrior = priorHistory[lastIdx];
    if (!lastPrior || !(lastPrior.type === "message" && lastPrior.role === "assistant")) {
      return { output: `agent '${resumeArg}' didn't finish cleanly and can't be resumed`, isError: true };
    }

    // T3 REVIEW (MINOR) — REMOVED-WORKTREE guard. An isolation:"worktree" child's worktree is torn
    // down on clean completion, so on resume rc.roots points at a possibly-removed dir; the fs/bash
    // tools would then fence to a gone directory and error confusingly mid-run. rc.roots is only set
    // when the child WAS isolated (undefined → a plain-cwd child, skip); rc.roots[0] is the primary
    // cwd by contract. Reject up front rather than fail confusingly later.
    if (rc.roots && rc.roots[0] && !existsSync(rc.roots[0])) {
      return { output: `cannot resume an isolated agent '${resumeArg}'; its worktree was removed`, isError: true };
    }

    const agentType = rc.agentType ?? "general-purpose";

    // 4h-ii-b Task 4 (SM3, defensive): start the resumed run with a CLEAN thread steer queue. A
    // send_message to the prior (now-terminal) instance is stale on resume — and there is a narrow
    // window where one can be orphaned into this queue: runThread's own cleanupThreadSteer runs at
    // its terminal return BEFORE the detached completion handler flips bgAgents status to terminal,
    // so a delivery in that gap sees "running" and lands here AFTER cleanup. Deleting the key here,
    // before input reconstruction / the round-0 top-drain, guarantees such a message can't be
    // drained into the resumed run (it would otherwise surface as a spurious extra user turn).
    this.threadSteerQueue.delete(entry.threadId);

    // D4 — POLICY ON RESUME (restrict-only, no widen): the MORE RESTRICTIVE of {current session
    // policy, the child's ORIGINAL captured policy}. This never widens beyond the child's original
    // grant (satisfies "a resume can't widen the child's original policy"), AND additionally caps
    // the resumed run at the CURRENT session policy if the session has TIGHTENED since spawn (e.g.
    // the user switched to plan mode) — strictly safer than reusing rc.approvalPolicy verbatim,
    // never wider. Same shallow-copy-only-when-it-narrows discipline as the fresh path's childMeta.
    const childPolicyOnResume = restrictPolicy(meta.approvalPolicy, rc.approvalPolicy);
    const childMeta = childPolicyOnResume !== meta.approvalPolicy ? { ...meta, approvalPolicy: childPolicyOnResume } : meta;

    // D3 — flip the registry entry back to running with a FRESH abort controller (register() can't
    // re-admit a known agentId). reopen() also resets notified so the resumed completion re-fires
    // its reminder (bg path); the sync path re-marks it notified below.
    const entryAbort = new AbortController();
    this.cfg.bgAgents!.reopen(entry.agentId, entryAbort);

    // D2 — re-emit thread_started so both client reducers RE-ADD the child (they prune all child
    // items on the main thread's turn_completed, and dedupe thread_started by threadId → a no-op if
    // still present, a correct re-add if pruned). parentThreadId is the RESUMING thread. The NEW
    // prompt rides thread_started.prompt (what the clients render as the child's prompt), so the
    // child user_message persisted below needs no separate broadcast for display.
    this.emit(sessionId, {
      type: "thread_started", sessionId, threadId: entry.threadId, parentThreadId,
      agentType, prompt, description: rc.description,
    });
    // registerThread would PUSH a second thread.list entry for the same child on every resume — D2
    // says "call registerThread", but a literal push double-lists the child; refine to flip the
    // EXISTING entry back to running in place (register it only if somehow absent). thread_started's
    // own by-threadId dedupe already covers the client-facing event stream.
    const existingThread = this.threadsFor(sessionId).find((t) => t.threadId === entry.threadId);
    if (existingThread) { existingThread.status = "running"; existingThread.stopReason = undefined; }
    else this.registerThread(sessionId, { threadId: entry.threadId, parentThreadId, agentType, status: "running" });

    // D1 — persist the NEW prompt as a child-scoped user_message BEFORE reconstructing input, so
    // childHistoryInput picks it up as the LAST child event. Without this, resume #1 works but
    // resume #2's reconstruction loses the between-assistants user turn (see childHistoryInput's
    // KNOWN GAP note and this task's D1). The store's first_message index special-cases
    // threadId==="main" only, so a child user_message appends without mis-indexing. runThread does
    // NOT re-persist its input, so this event is written exactly once (pinned by an engine test).
    this.emit(sessionId, { type: "user_message", sessionId, threadId: entry.threadId, text: prompt, clientName: "resume" });
    // Reconstruct: opening prompt (the fresh spawn never persisted it) + the child's OWN stored
    // history (now ending with the prompt just persisted).
    const input: TurnInputItem[] = [
      { type: "message", role: "user", content: rc.openingPrompt },
      ...this.childHistoryInput(sessionId, entry.threadId),
    ];

    // D5 — replay the EXACT runThread args captured at spawn (fresh Sets from the arrayified
    // snapshots), NOT re-derived: rc.depth (the child's own depth, gates its grandchild spawns),
    // rc.instructions/cwd/roots/maxTurns, rc.model ?? the resuming turn's model. reasoningEffort is
    // the CURRENT resuming turn's effort (inherited per-turn, not frozen at spawn). Both the sync
    // and bg forks fold entryAbort.signal into the run signal, mirroring the fresh path.
    const runResumed = (childSignal: AbortSignal) => this.runThread({
      sessionId,
      threadId: entry.threadId,
      instructionsFull: rc.instructions,
      input,
      cwd: rc.cwd,
      model: rc.model ?? model,
      reasoningEffort,
      meta: childMeta,
      depth: rc.depth,
      signal: AbortSignal.any([childSignal, entryAbort.signal]),
      loaded: new Set(rc.loaded),
      excludeTools: new Set(rc.excludeTools),
      allowTools: rc.allowTools ? new Set(rc.allowTools) : undefined,
      maxTurns: rc.maxTurns,
      rootsOverride: rc.roots,
    });

    // D6 — same sync/bg fork the fresh path uses; `reentrant` keys off the RESUMING thread's depth
    // (a depth>0 resumer already holds a SubagentManager slot), exactly like the fresh spawn.
    if (runInBackground) {
      void this.cfg.subagents!.run(async (childSignal) => runResumed(childSignal), {
        reentrant: depth > 0,
        // 4h-ii-c (T1 follow-up): a RESUMED detached child is as untimed as a freshly-spawned one
        // — same rationale as the fresh bg spawn branch's own `timeoutMs` relax (no waiting parent
        // to time out FOR; the 4h-ii-a T3 review's "relax only once a manual kill exists" is
        // satisfied by task_stop firing `entryAbort` above). This path is MAINSTREAM, not an edge:
        // a send_message to a finished agent always resumes with runInBackground:true. Same depth
        // gate as the fresh path (whole-branch review C1, 4h-ii-c): `depth` here is the RESUMING
        // thread's own depth — task_stop is main-thread-only, so only a depth-0 resumer's bg child
        // can actually be killed manually. `depth > 0` keeps the SubagentManager default (300s)
        // instead, since nothing could stop it early ("untimed ⟺ killable").
        timeoutMs: depth === 0 ? null : undefined,
      })
        .then((result) => {
          const stopReason = result.ok ? result.value.stopReason : "error";
          this.emit(sessionId, { type: "thread_completed", sessionId, threadId: entry.threadId, stopReason });
          this.completeThread(sessionId, entry.threadId, stopReason);
          this.cfg.bgAgents!.complete(entry.agentId, !result.ok
            ? { ok: false, result: `subagent (${agentType}) ${result.error}` }
            : result.value.stopReason === "error"
              ? { ok: false, result: `subagent (${agentType}) failed: ${result.value.errorMessage ?? "provider error"}` }
              : { ok: true, result: result.value.finalText || "the subagent finished without a final message" },
            // 4h-ii-c: only reachable if a future config re-adds a bg timeout (this call runs with
            // `timeoutMs: null` above) — wired now, same as the fresh bg spawn's `.then`, so a
            // timed-out resumed child is never misreported as generic "failed".
            !result.ok && result.timedOut ? { timedOut: true } : undefined);
        })
        .catch((err) => {
          // Defensive: SubagentManager.run() never throws; this guards a throw in the .then handler
          // above so a detached resume never leaves an unhandled rejection.
          const message = err instanceof Error ? err.message : String(err);
          this.emit(sessionId, { type: "thread_completed", sessionId, threadId: entry.threadId, stopReason: "error" });
          this.completeThread(sessionId, entry.threadId, "error");
          this.cfg.bgAgents!.complete(entry.agentId, { ok: false, result: message });
        })
        .catch(() => { /* terminal net: a throw in the .catch above (persistent IO fault on the completion emit) has no caller to surface to on a detached run — swallow rather than emit an unhandled rejection */ });
      return { output: JSON.stringify({ agentId: entry.threadId, status: "running" }), isError: false };
    }

    const result = await this.cfg.subagents!.run(async (childSignal) => runResumed(childSignal), { reentrant: depth > 0 });
    const stopReason = result.ok ? result.value.stopReason : "error";
    this.emit(sessionId, { type: "thread_completed", sessionId, threadId: entry.threadId, stopReason });
    this.completeThread(sessionId, entry.threadId, stopReason);
    const outcome: { output: string; isError: boolean } = !result.ok
      ? { output: `subagent (${agentType}) ${result.error}`, isError: true }
      : result.value.stopReason === "error"
        ? { output: `subagent (${agentType}) failed: ${result.value.errorMessage ?? "provider error"}`, isError: true }
        : { output: result.value.finalText || "the subagent finished without a final message", isError: false };
    // { notified: true }: this sync resume's result reached the caller directly as its own
    // tool_result this same turn, so the next turn's completion-reminder sweep must not re-surface
    // it (same reasoning as the fresh sync path). `timedOut` (4h-ii-c): the sync resume's run()
    // call above is still on the constructor-default clock (no override), so a timeout IS
    // reachable here — mirror the fresh sync path's threading so it reports "timeout", not "failed".
    this.cfg.bgAgents!.complete(entry.agentId, { ok: !outcome.isError, result: outcome.output },
      { notified: true, timedOut: !result.ok && result.timedOut });
    return outcome;
  }

  /** Shared approval-request flow for the `ask`-policy path, the reviewer's escalation path, and
   *  (1d-iii) the worktree bridge's ask-policy path. Registers the broker wait BEFORE emitting
   *  `approval_requested` — the broadcast is synchronous, so a watcher that resolves the approval
   *  as soon as it observes the event (see engine.test.ts) would otherwise race `broker.wait()`
   *  and resolve into an empty pending-map slot, timing out. On denial, `opts.denialMessage` lets
   *  a caller (the reviewer path) override the default `denied by ${res.by}` string with a
   *  retry-hint message; the `ask` path passes no override, preserving that exact string
   *  byte-for-byte. `onApprove` lets a caller run something OTHER than executeCall when approved
   *  (the worktree dispatch branch passes the worktree bridge here); omitted (the `ask`/reviewer
   *  callers above), it defaults to `executeCall` — behavior-preserving for every existing caller.
   *  `pins` (4g-i) is the CALLING round's pinnedTools() result — forwarded to executeCall's
   *  default path unchanged; callers that pass their own `onApprove` (the worktree bridge) don't
   *  need it, but still supply it for signature uniformity (defaults to an empty Set).
   *  `loaded` (4g final-review fix) is the CALLING THREAD's live `loaded` set (runThread's
   *  `opts.loaded` — the same object for every caller in this file, main or child) — forwarded
   *  unchanged to executeCall's default path so an approved call's load/defense-in-depth check
   *  lands on the thread that actually asked, not always the session-scoped map.
   *  `rootsOverride` (4h-i Task 4) — forwarded unchanged to executeCall's default path; callers
   *  that pass their own `onApprove` (the worktree bridge) don't need it. */
  private async requestApproval(
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    opts: { timeoutMs: number; summary: string; denialMessage?: string },
    loaded: Set<string>,
    onApprove?: () => Promise<{ output: string; isError: boolean }>,
    pins: Set<string> = new Set(),
    rootsOverride?: string[],
  ): Promise<{ output: string; isError: boolean; deniedByHuman?: boolean }> {
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
    if (res.approved) {
      return await (onApprove ? onApprove() : this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride));
    }
    // An EXPLICIT human denial (any `by` other than the broker's "timeout") ends the turn and
    // hands control back to the user (Claude Code parity) — see the caller's `deniedByHuman`
    // check in the tool loop. Crucially it does NOT invite a "retry with a justification"
    // (that path let a model re-submit the SAME command and have the AI reviewer re-approve it
    // in-turn with no second human confirmation — a real gate bypass). The retry-with-
    // justification hint is kept ONLY for genuine timeouts (no human ever answered), where the
    // caller supplies `denialMessage`.
    if (res.by !== "timeout") {
      return {
        output: `The user denied this ${call.name} action — it was NOT run. Stop here and wait for the user to tell you how to proceed. Do not retry it, rephrase it, or attempt a workaround; the user will give further instructions.`,
        isError: true,
        deniedByHuman: true,
      };
    }
    return { output: opts.denialMessage ?? `denied by ${res.by}`, isError: true };
  }

  /** exit_plan_mode's approval bridge — wired ONLY when cfg.plans is set (see the else-if guard
   *  at the call site); otherwise exit_plan_mode falls through to executeCall's placeholder run.
   *  Mirrors requestApproval's wait-before-emit + emit-failure pattern above: the PlanBroker wait
   *  is registered BEFORE `plan_presented` is emitted, since the broadcast is synchronous and a
   *  watcher that responds as soon as it observes the event would otherwise race an unregistered
   *  wait into a lost response (see engine-plan.test.ts). On approval, `meta.approvalPolicy` is
   *  mutated IN PLACE on the SAME object the dispatch loop's gate check reads every iteration —
   *  that's what makes a follow-up tool call LATER IN THIS SAME TURN see the new mode immediately,
   *  without waiting for the next turn's `store.meta()` re-read. `cfg.setPolicy` persists the
   *  change to the SessionStore so it also survives into the next turn. */
  private async runPlanBridge(
    call: { callId: string; name: string; argsJson: string },
    sessionId: string,
    threadId: string,
    meta: { approvalPolicy: "ask" | "auto" | "plan" },
  ): Promise<{ output: string; isError: boolean }> {
    const plans = this.cfg.plans!;
    let plan = "";
    try {
      const a = JSON.parse(call.argsJson || "{}");
      plan = typeof a.plan === "string" ? a.plan : "";
    } catch { /* empty */ }
    const planTimeoutMs = Number(process.env.NORMA_PLAN_TIMEOUT_MS ?? 300_000);
    const waiting = plans.wait(sessionId, call.callId, planTimeoutMs); // BEFORE emit (race lesson)
    try {
      this.emit(sessionId, { type: "plan_presented", sessionId, threadId, callId: call.callId, plan });
    } catch (err) {
      plans.respond(sessionId, call.callId, { approved: false, autoAccept: false }, "emit-failure");
      await waiting;
      throw err;
    }
    const res = await waiting;
    const approved = "approved" in res ? res.approved : false;
    const autoAccept = "approved" in res ? res.autoAccept : false;
    const feedback = "approved" in res ? res.feedback : undefined;
    const by = "approved" in res ? res.by : "timeout";
    this.emit(sessionId, { type: "plan_resolved", sessionId, threadId, callId: call.callId, approved, feedback, autoAccept, by });
    if (approved) {
      const next = autoAccept ? "auto" : "ask";
      await this.cfg.setPolicy?.(sessionId, next);
      meta.approvalPolicy = next; // SAME-TURN: follow-up calls in this turn use the new mode
      return {
        output: `Plan approved (auto-accept edits: ${autoAccept ? "on" : "off"}). Proceed with the plan. Create a task for each step with task_create as you work.`,
        isError: false,
      };
    }
    const reason = feedback && feedback.trim().length > 0
      ? feedback
      : (by === "timeout"
          ? "no response — the user did not respond within the time limit"
          : "the user rejected the plan without specific feedback");
    return {
      output: `Plan rejected: ${reason}. Stay in plan mode and revise your plan, then call exit_plan_mode again.`,
      isError: false,
    };
  }

  /** enter_plan_mode's bridge (4g Task 4, CC parity) — mirrors runPlanBridge's `meta` mutation +
   *  `cfg.setPolicy` persistence mechanics, but is wired UNCONDITIONALLY at the call site (no
   *  `cfg.plans`-style optional dependency to gate on): entering plan mode needs no human
   *  approval — it's strictly restrictive, so there's no broker wait, no `plan_presented`/
   *  `plan_resolved` event pair, just an immediate switch. Guard: calling this while ALREADY in
   *  plan mode is a typed error (not a gate denial — gate.ts's READ_ONLY membership allows the
   *  call through under every policy, including "plan", precisely so this guard can produce a
   *  clear message instead of the generic "Blocked in plan mode" text). On success,
   *  `meta.approvalPolicy` is mutated IN PLACE on the SAME object the dispatch loop's gate check
   *  reads every iteration — a follow-up tool call LATER IN THIS SAME TURN sees the new mode
   *  immediately; `cfg.setPolicy` persists the switch to the SessionStore so it also survives into
   *  the next turn (same as the exit bridge — see runPlanBridge's doc comment). */
  private async runEnterPlanBridge(
    sessionId: string,
    meta: { approvalPolicy: "ask" | "auto" | "plan" },
  ): Promise<{ output: string; isError: boolean }> {
    if (meta.approvalPolicy === "plan") {
      return { output: "already in plan mode", isError: true };
    }
    await this.cfg.setPolicy?.(sessionId, "plan");
    meta.approvalPolicy = "plan"; // SAME-TURN: follow-up calls in this turn use the new mode
    return {
      output: "Plan mode ON — read-only tools only; present your plan with exit_plan_mode when ready.",
      isError: false,
    };
  }

  /** enter_worktree/exit_worktree's bridge — wired ONLY when cfg.worktrees is set (see the
   *  `isWorktree` guard at the call site); otherwise both tools fall through to executeCall's
   *  placeholder run (tools/worktree.ts). Called from BOTH decisions the gate can produce for a
   *  MUTATING tool: directly when `decision === "allow"` (auto policy), and as `requestApproval`'s
   *  `onApprove` action when `decision === "ask"` (the DEFAULT policy) — see the dispatch loop
   *  above. Synchronous (WorktreeManager's git calls are Bun.spawnSync), unlike the approval/plan
   *  bridges above which wait on a broker. `setCwd` persists the switch to the SessionStore so it
   *  also survives into the next turn; `onCwd` reports the new cwd to the caller, which mutates the
   *  dispatch loop's local `cwd` (now `let`) so a follow-up call LATER IN THIS SAME TURN resolves
   *  into (or back out of) the worktree immediately — this works identically whether the caller is
   *  the direct "allow" branch or the "ask"-approved `onApprove` closure. A thrown manager
   *  error (e.g. dirty worktree on remove, not a git repo, already in a worktree) becomes an
   *  isError outcome rather than propagating and failing the whole turn. */
  private runWorktreeBridge(
    call: { callId: string; name: string; argsJson: string },
    sessionId: string,
    threadId: string,
    cwd: string,
    onCwd: (next: string) => void,
  ): { output: string; isError: boolean } {
    const worktrees = this.cfg.worktrees!;
    try {
      if (call.name === "enter_worktree") {
        let name: string | undefined;
        try { name = JSON.parse(call.argsJson || "{}").name; } catch { /* ignore — name stays undefined */ }
        const wt = worktrees.enter(sessionId, cwd, name);
        this.cfg.store.setCwd(sessionId, wt.dir);
        this.cfg.dirs.add(sessionId, wt.dir);
        onCwd(wt.dir); // SAME-TURN: subsequent calls in this turn resolve into the worktree
        this.emit(sessionId, { type: "worktree_entered", sessionId, threadId, name: wt.name, path: wt.dir, branch: wt.branch });
        return {
          output: `Entered worktree ${wt.name} at ${wt.dir} on branch ${wt.branch}. You're now working in an isolated copy; the original repo is untouched.`,
          isError: false,
        };
      }
      let action: "keep" | "remove" = "keep";
      let discardChanges = false;
      try {
        const a = JSON.parse(call.argsJson || "{}");
        if (a.action === "remove") action = "remove";
        if (a.discard_changes === true) discardChanges = true;
      } catch { /* default to keep, discardChanges false */ }
      // Capture the worktree dir BEFORE exit() clears the manager's active-session entry, so we
      // can drop it from SessionDirectories below — on BOTH keep and remove: once exited we're
      // back in the original repo either way, and a lingering root (especially one whose dir was
      // just deleted by {remove}) must not stick around in the allowed-roots list.
      const activeDir = worktrees.active(sessionId)?.dir;
      const res = worktrees.exit(sessionId, action, discardChanges);
      this.cfg.store.setCwd(sessionId, res.originalCwd);
      if (activeDir) this.cfg.dirs.remove(sessionId, activeDir);
      onCwd(res.originalCwd); // SAME-TURN revert
      this.emit(sessionId, { type: "worktree_exited", sessionId, threadId, name: res.name, action, removed: res.removed });
      return {
        output: action === "remove"
          ? `Left and removed worktree ${res.name}.`
          : `Left worktree ${res.name}; branch ${res.branch} kept — merge or PR it when ready.`,
        isError: false,
      };
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
  }

  private executeCall(
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    // 4g final-review fix: the CALLING THREAD's live `loaded` set — runThread's own `opts.loaded`,
    // threaded straight through by every call site in this file (main-thread branches AND the
    // requestApproval/executeCall calls inside a spawned child's own runThread invocation). This
    // is THE set a load must land in and THE set the defense-in-depth check below must read —
    // for the MAIN thread it IS `this.loadedTools.get(sessionId)` (turn() hands that exact object
    // to runThread as opts.loaded), so main-thread behavior is byte-identical to before; for a
    // CHILD thread it's the fresh per-spawn `childLoaded` Set (runThread's spawn bridge), never
    // `this.loadedTools` — so a subagent's ToolSearch load now lands where its OWN specs()/guard
    // actually look, instead of a session-wide set the child never consults.
    loaded: Set<string>,
    // 4g-i: the CALLING round's pinnedTools() result (runThread's `pins`, or requestApproval's
    // forwarded copy of it) — defaulted so any caller that doesn't care about pins compiles
    // unchanged. Unioned below with `loaded`, never mutating either.
    pins: Set<string> = new Set(),
    // 4h-i Task 4: forwarded straight from runThread's own `opts.rootsOverride` (see its doc
    // comment) — undefined for every caller except a worktree-isolated child, in which case it's
    // EXACTLY that child's `[worktreeDir]`, replacing (not extending) the session-wide roots
    // this.cfg.dirs.roots(sessionId) would otherwise return.
    rootsOverride?: string[],
  ): Promise<{ output: string; isError: boolean }> {
    let args: unknown;
    try { args = call.argsJson.length ? JSON.parse(call.argsJson) : {}; }
    catch { return Promise.resolve({ output: `tool arguments were not valid JSON`, isError: true }); }
    const roots = rootsOverride ?? this.cfg.dirs.roots(sessionId);
    const tmpDir = sessionTmpDir(sessionId);
    const markSkillLoaded = (n: string) => {
      let set = this.loadedSkills.get(sessionId);
      if (!set) { set = new Set(); this.loadedSkills.set(sessionId, set); }
      set.add(n);
    };
    // Mutate the CALLING THREAD's own `loaded` set in place — never `this.loadedTools.get
    // (sessionId)` (that lookup is what caused the bug: a child thread's load used to land in the
    // session-wide map instead of the `childLoaded` set the child's own specs()/guard consult,
    // AND polluted the session-wide set for good measure). See `loaded`'s doc comment above.
    const markToolLoaded = (n: string) => { loaded.add(n); };
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
            // CC AskUserQuestion parity: mirror the broker's notes onto the persisted/broadcast
            // event too (schema-optional, additive) so replay/other clients can see them — the
            // model-visible copy is folded into the tool's own return string in ask-user.ts.
            ...("notes" in res && res.notes ? { notes: res.notes } : {}),
          });
          return res;
        }
      : undefined;
    // Gated on cfg.tasks (mirrors `ask` above being gated on cfg.questions) — previously
    // unconditional, which left cfg.tasks dead and contradicted the "absent means ctx.taskEvent
    // is undefined" comment on EngineConfig. registerTaskTools is what actually decides whether
    // task_create/task_update/task_list exist at all, so this only matters if a future caller
    // registers those tools without also wiring a TaskStore into the engine config (M2 finding).
    const taskEvent = this.cfg.tasks
      ? (task: Task) => { this.emit(sessionId, { type: "task_updated", sessionId, threadId, task }); }
      : undefined;
    // The calling thread's own `loaded` set (see its doc comment above), unioned with this
    // round's pins into a NEW Set — `loaded` itself is NEVER copied/mutated by this union.
    const effectiveLoaded = pins.size ? new Set([...loaded, ...pins]) : loaded;
    return this.cfg.registry.execute(call.name, args, {
      cwd, roots, tmpDir, sessionId, signal, markSkillLoaded,
      markToolLoaded,
      loadedTools: effectiveLoaded,
      deferThreshold: this.toolSearchThreshold(),
      deferExternals: this.toolSearchDeferExternals(),
      builtinDeferral: this.toolSearchEnabled(),
      ask,
      taskEvent,
    });
  }
}
