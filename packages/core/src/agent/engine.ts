import { randomUUID } from "node:crypto";
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
import type { BackgroundAgentRegistry } from "./bg-agent-registry";

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
    if (bgTasks.some((t) => t.status === "running")) { pins.add("bash_output"); pins.add("bash_kill"); }
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
      if (e.type === "user_message") input.push({ type: "message", role: "user", content: e.text });
      else if (e.type === "assistant_message") input.push({ type: "message", role: "assistant", content: e.text });
      // Prior turns' tool calls are summarized by their assistant_message; current-turn
      // call/result items are threaded in-memory below.
    }
    return input;
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
    const sanitize = (s: string) =>
      s.replace(/\r?\n/g, " ").replace(/<\/?system-reminder>/gi, "[tag]");
    const lines = tasks.map((t) => `#${t.id} [${t.status}] ${sanitize(t.subject)}`).join("\n");
    const content = "<system-reminder>\nCurrent task list (update these by id — do NOT create a new task for work already listed):\n"
      + lines
      + "\nUse task_update with the task's id to change status; task_list shows full details."
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

    this.emit(sessionId, { type: "turn_started", sessionId, threadId });

    for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
      if (threadId === MAIN_THREAD) {
        const steers = this.steerQueue.get(sessionId);
        if (steers && steers.length) { for (const t of steers) input.push({ type: "message", role: "user", content: t }); steers.length = 0; }
      }

      let textBuf = "";
      const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
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
        else if (ev.type === "usage") { usage.inputTokens += ev.inputTokens; usage.outputTokens += ev.outputTokens; }
        else if (ev.type === "done") stop = ev.stopReason;
        else if (ev.type === "error") {
          this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: ev.message });
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
          // `errorMessage` is consumed ONLY by the spawn bridge below (a CHILD thread's failure
          // must surface through the parent's tool_result — the agent_error/turn_completed events
          // just emitted are invisible to the parent model, which only sees the child's return
          // value). Main-thread callers (turn(), which just `await`s runThread without touching
          // the return value) are unaffected — see the grep note in the 4e-fix3 report.
          return { finalText: lastText, stopReason: "error", errorMessage: ev.message };
        }
      }

      if (textBuf.length > 0) {
        this.emit(sessionId, { type: "assistant_message", sessionId, threadId, text: textBuf });
        input.push({ type: "message", role: "assistant", content: textBuf });
        lastText = textBuf;
      }

      if (stop !== "tool_calls" || calls.length === 0) {
        if (threadId === MAIN_THREAD) {
          const pending = this.steerQueue.get(sessionId);
          // A steer landed as we finished → drain at next iteration top, keep going. But an
          // interrupt must win: an aborted turn ends now with turn_completed(aborted) even if a
          // steer is queued (it stays queued for the next runTurn, e.g. via steer()'s own restart).
          if (stop !== "aborted" && pending && pending.length) { continue; }
        }
        this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: stop === "aborted" ? "aborted" : "end_turn", ...usage });
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
      const spawnCalls = this.cfg.subagents && this.cfg.agents && opts.depth < maxDepth
        ? calls.filter((c) => c.name === "spawn_agent")
        : [];
      if (spawnCalls.length > 0) {
        await Promise.all(spawnCalls.map(async (call) => {
          let parsed: { prompt?: unknown; agentType?: unknown; model?: unknown; description?: unknown; max_turns?: unknown; mode?: unknown; isolation?: unknown; run_in_background?: unknown } = {};
          try { parsed = JSON.parse(call.argsJson || "{}"); } catch { /* defensive: empty prompt below */ }
          const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
          const agentType = typeof parsed.agentType === "string" ? parsed.agentType : undefined;
          const modelOverride = typeof parsed.model === "string" ? parsed.model : undefined;
          const description = typeof parsed.description === "string" ? parsed.description : undefined;
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
          const childDepth = opts.depth + 1;
          const childExcludeTools = new Set(["ask_user", "exit_plan_mode", "enter_plan_mode"]);
          if (childDepth >= maxDepth) childExcludeTools.add("spawn_agent");
          // 4h-ii-a (CC parity: Agent.run_in_background): the async/detached path — starts the
          // child through the SAME SubagentManager slot (concurrency-limited) + depth cap as the
          // synchronous path below, but does NOT await it. `entryAbort` is THIS bg entry's own
          // controller (bg-agent-registry.ts's `stop()` fires it) — the child's own runThread
          // signal is `AbortSignal.any([childSignal, entryAbort.signal])` so EITHER the
          // SubagentManager's own per-run timeout (childSignal) OR a future stop() call
          // (entryAbort) can abort it. This call's tool_result is set SYNCHRONOUSLY, right here,
          // before any of the child's own work has run — Promise.all resolves as soon as this
          // closure returns, without waiting on the detached chain below.
          if (runInBackground) {
            const entryAbort = new AbortController();
            const registered = this.cfg.bgAgents!.register({
              agentId: childId,
              sessionId,
              threadId: childId,
              // `name` (4h-ii-b) is a follow-up arg — this task never passes one, so every bg
              // entry is addressed by agentId (childId) only, same as thread.list today.
              name: undefined,
              abort: entryAbort,
            });
            if (!registered.ok) {
              // Not reachable today (childId is a fresh randomUUID and name is always undefined
              // here, so register() can only ever reject on a collision this task never produces)
              // — handled defensively rather than assumed impossible, mirroring the guard style
              // used throughout this bridge. thread_started already fired above, so this must
              // still complete that thread entry rather than leaving a ghost "running" thread.
              this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason: "error" });
              this.completeThread(sessionId, childId, "error");
              spawnOutcomes.set(call.callId, { output: registered.error, isError: true });
              return;
            }
            void this.cfg.subagents!.run(async (childSignal) => {
              const childLoaded = new Set<string>();
              const instructionsFull = this.buildInstructionsFull(def.instructions, childCwd, childLoaded, childPolicy, sessionId);
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
                // BOTH the SubagentManager's own per-run timeout (childSignal) AND a future
                // registry.stop() (entryAbort.signal) must be able to abort this detached child —
                // see this branch's own doc comment above. This is the ONLY functional difference
                // (besides not awaiting) from the synchronous path's childFn just below.
                signal: AbortSignal.any([childSignal, entryAbort.signal]),
                loaded: childLoaded,
                excludeTools: childExcludeTools,
                allowTools: def.allowTools,
                maxTurns,
                rootsOverride: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
              });
            }, { reentrant: opts.depth > 0 })
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
                    : { ok: true, result: result.value.finalText || "the subagent finished without a final message" });
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
              });
            // NOTE: only {agentId, status} — never the AbortController/registry entry itself —
            // ever reaches the model, via this tool_result JSON.
            spawnOutcomes.set(call.callId, {
              output: JSON.stringify({ agentId: childId, status: "running" }),
              isError: false,
            });
            return; // Promise.all resolves without waiting on the detached chain above
          }

          // Nested-spawn saturation fix (T3 review): `opts.depth` is THIS spawning thread's own
          // depth — >0 means it already holds a concurrency slot (it's itself a child), so this
          // run() call is a REENTRANT acquire. SubagentManager bounds a reentrant wait
          // (acquireTimeoutMs) instead of queueing unbounded, so pool saturation under nesting
          // fails fast with a typed error instead of stalling for the full per-run timeoutMs
          // (300s) — see SubagentManager.acquire's doc comment. A depth-0 (top-level) spawn is
          // never reentrant and keeps its existing unbounded queueing behind busy siblings.
          try {
            const result = await this.cfg.subagents!.run(async (childSignal) => {
              const childLoaded = new Set<string>();
              const instructionsFull = this.buildInstructionsFull(def.instructions, childCwd, childLoaded, childPolicy, sessionId);
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
                signal: childSignal,
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
            spawnOutcomes.set(call.callId, !result.ok
              ? { output: `subagent (${agentType ?? "general-purpose"}) ${result.error}`, isError: true }
              : result.value.stopReason === "error"
                ? { output: `subagent (${agentType ?? "general-purpose"}) failed: ${result.value.errorMessage ?? "provider error"}`, isError: true }
                : { output: result.value.finalText || "the subagent finished without a final message", isError: false });
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

      for (const call of calls) {
        this.emit(sessionId, { type: "tool_call", sessionId, threadId, callId: call.callId, name: call.name, argsJson: call.argsJson });
        input.push({ type: "function_call", callId: call.callId, name: call.name, argsJson: call.argsJson });

        let outcome: { output: string; isError: boolean; deniedByHuman?: boolean };
        const spawnOutcome = spawnOutcomes.get(call.callId);
        if (spawnOutcome) {
          outcome = spawnOutcome;
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
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

        // A human explicitly denied this action → end the turn now and return control to the
        // user (Claude Code parity). The denied tool_result is already persisted above, so the
        // NEXT turn's context shows "you tried X, the user denied it" alongside whatever the
        // user then says. Any later calls in this same batch were never emitted/pushed (the
        // loop pushes function_call + tool_result one at a time), so nothing is left dangling.
        if (outcome.deniedByHuman) {
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "end_turn", ...usage });
          if (opts.depth === 0 && this.cfg.titler) void this.cfg.titler.maybeTitle(sessionId);
          return { finalText: lastText, stopReason: "end_turn" };
        }
      }
    }

    const capMessage = `tool-iteration cap (${effectiveMaxIterations}) reached`;
    this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: capMessage });
    this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
    return { finalText: lastText, stopReason: "error", errorMessage: capMessage };
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
