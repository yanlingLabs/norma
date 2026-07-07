import Foundation
import NormaProtocol
import NormaKit

struct TaskItem: Equatable {
    let id: String
    var subject: String
    var status: String
    /// The wire's present-tense task description ("Running tests") — dropped entirely until
    /// Task 2 (2e-i); carried straight off `event.task.activeForm`. Defaulted `nil` so existing
    /// `TaskItem(id:subject:status:)` call sites/tests compile unchanged.
    var activeForm: String? = nil
    /// `event.ts` (never a client clock — the reducer stays pure) the moment this task FIRST
    /// entered `in_progress`. Stamped once and preserved across later updates (including a
    /// repeated in_progress) so Task 3's elapsed timer has a stable start; `nil` for a task that
    /// has never been in_progress. Defaulted `nil` for the same compile-compat reason as above.
    var startedTs: Int? = nil
}

/// A single outstanding human-in-the-loop interaction the daemon is waiting on — approval,
/// question, or plan — carrying the payload cards need to render (2d-iii task 1). Replaces the
/// old `pendingApprovalIds: Set<String>`, which tracked only callIds and dropped everything else
/// the wire event carried (toolName/summary/questions/plan). `Equatable` (not `Identifiable`) so
/// reducer tests can assert on values directly, same convention as `ActivityItem`/`TaskItem`.
enum PendingInteraction: Equatable {
    case approval(callId: String, toolName: String, summary: String)
    case question(callId: String, questions: [SessionEvent.Question])
    case plan(callId: String, plan: String)

    var callId: String {
        switch self {
        case .approval(let callId, _, _): return callId
        case .question(let callId, _): return callId
        case .plan(let callId, _): return callId
        }
    }
}

/// One line of "what happened during this exchange" — tools run, task transitions, subagents
/// spawned/finished, worktree enters/exits, and interaction points (approvals/questions/plans).
/// Captured per-exchange by `SessionReducer.reduce` (2d-ii-a task 1) so the transcript can show
/// a turn's activity without re-deriving it from the flat event log; tasks 3/4 render these.
struct ActivityItem: Equatable {
    enum Kind: Equatable {
        /// `detail` (LIVE-GATE G3) is a short, tool-specific hint extracted from the tool call's
        /// `argsJson` by `SessionReducer.extractToolDetail` — the bash command's first line, a
        /// task subject, or a file path/pattern, depending on `name`. `nil` for tools with no
        /// recognized detail field, or when `argsJson` fails to parse (defensive: malformed/
        /// missing JSON never throws, it just yields no detail). Consumed by the transcript's
        /// grouped tool rows (`groupActivity`/`toolGroupLabel` in ChatContent) for the expandable
        /// per-call detail lines — never by `activityGlyphAndLabel`'s single-item fallback path.
        case tool(name: String, detail: String?)
        case task(subject: String, status: String)
        case subagent(agentType: String)
        case subagentDone
        case worktree(entered: Bool, detail: String)
        case interaction(String)
    }
    var kind: Kind
}

/// A user prompt paired with its reply — the field's inline-response shell (2c wave 2 task 3)
/// reads `exchanges.last` instead of the flat `lastReply` string so it can tell "no reply yet"
/// (empty `reply`) apart from "no exchange at all" (empty array), and so a later wave can render
/// prior turns without re-deriving pairing from the flat event log.
struct Exchange: Equatable {
    var prompt: String
    var reply: String
    /// What happened while this exchange's turn ran (2d-ii-a task 1) — appended via
    /// `SessionReducer.appendActivity` (main-transcript events only; adjacent dupes collapse;
    /// capped at 200 drop-oldest). Defaulted so existing `Exchange(prompt:reply:)` call
    /// sites and equality-based tests are untouched.
    var activity: [ActivityItem] = []
    /// True when this exchange's turn ended with `stopReason == "aborted"` (Esc-interrupt) —
    /// the per-exchange sibling of the state-level `lastTurnAborted` flash flag.
    var aborted: Bool = false
}

struct OrbSessionState: Equatable {
    var status: OrbStatus = .disconnected // until markConnected() — M2 contract
    var tasks: [TaskItem] = []
    /// Ordered (oldest first), replay-rebuildable list of outstanding approvals/questions/plans —
    /// 2d-iii task 1. `*_requested`/`*_asked`/`*_presented` append (skipping a callId already
    /// present, so a replayed duplicate event is a no-op, not a second card); the matching
    /// `*_resolved` removes by callId; `turn_completed`/`agent_error` clear it entirely. Tasks
    /// 2-4 render this as the HITL cards; `status`'s `.approvalNeeded(count:)` is always
    /// `pendingInteractions.count`.
    var pendingInteractions: [PendingInteraction] = []
    var turnRunning = false
    var streamingText = ""
    var lastReply: String? = nil
    /// Ordered prompt/reply pairs, oldest first. `user_message(main)` appends a new exchange
    /// with an empty reply; `assistant_message(main)` fills in the LAST exchange's reply (or, if
    /// none exists yet, appends one with an empty prompt) — see `SessionReducer.reduce`.
    var exchanges: [Exchange] = []
    /// Wave-5 gate item 2: messages sent while a turn is already running go down `session.steer`
    /// — the daemon queues them and drains at the next round boundary, and the reducer folds each
    /// one into the current exchange's growing prompt ("↳ text", see the `.userMessage` case
    /// below) so the eventual reply lands on the exchange the user was actually looking at. That
    /// fold is silent from the UI's perspective though — nothing showed the user their message
    /// had actually been accepted and was waiting, not lost. This mirrors the fold 1:1 (appended
    /// in the same branch) so it's always in sync with what got folded, and clears whenever the
    /// turn the queued text was riding on ends — absorbed (`turnCompleted`) or died
    /// (`agentError`) — since a queued steer never survives past the turn it was queued for.
    var queuedSteers: [String] = []

    /// Interrupt-feedback gate polish: true exactly when the MOST RECENT `turn_completed(main)`
    /// carried `stopReason == "aborted"` (an Esc-interrupt) — false for any other stop reason
    /// ("end_turn", tool-limit, etc.) and cleared back to false the instant the NEXT turn starts.
    /// This is pure reducer state (no timers, no view concerns) — `FieldStateAdapter` below is
    /// what turns a false→true transition into a transient, self-clearing UI flash; the reducer
    /// itself just tracks "was the last completed turn an interrupt," nothing more.
    var lastTurnAborted: Bool = false

    /// CC-style whimsical working verb for the current turn (wave 6 gate item 1) — e.g.
    /// "Reticulating", "Noodling" (see `WorkingVerbs`). The REDUCER never sets this (it must stay
    /// pure, no randomness) — `SessionModel.apply` rolls it right after `reduce` on
    /// `turnStarted(main)`, so it's stable for the whole turn and only re-rolled at the next one.
    /// Tests that drive `SessionReducer.reduce` directly (not through `SessionModel`) can set this
    /// field themselves to test composition without depending on randomness.
    var workingVerb: String = ""

    /// Wave-6 gate item 2: whether the pill's "☑ n/m" task-count suffix should show at all — ONLY
    /// while at least one task is actively `.in_progress`. A task list that exists but is idle
    /// (nothing in progress yet) or one where every task is already `.completed` shows the bare
    /// verb with no counts (the wave-4 batch-reset above already handles clearing a finished
    /// batch's counts once the NEXT run's first task arrives; this additionally hides the suffix
    /// for the current batch's own idle/tail-end moments).
    var hasActiveTask: Bool {
        tasks.contains { $0.status == "in_progress" }
    }

    var taskCounts: (done: Int, total: Int) {
        (tasks.filter { $0.status == "completed" }.count, tasks.count)
    }
}

/// PURE state derivation — every UI face (orb now; field/chat in 2c/2e) reads this.
enum SessionReducer {
    private static let mainThread = "main"

    static func reduce(_ state: OrbSessionState, _ event: SessionEvent) -> OrbSessionState {
        var s = state
        switch event {
        case .userMessage(let v) where v.threadId == mainThread:
            if s.turnRunning, let last = s.exchanges.indices.last, s.exchanges[last].reply.isEmpty {
                // Mid-turn steer: same turn, same exchange — the prompt grows (one turn = one exchange).
                s.exchanges[last].prompt += "\n↳ \(v.text)"
                // Wave-5 gate item 2: surface the queued message separately from the fold above
                // so the UI can show it as visibly "queued" rather than silently absorbed.
                s.queuedSteers.append(v.text)
            } else {
                s.exchanges.append(Exchange(prompt: v.text, reply: ""))
            }
        case .turnStarted(let v) where v.threadId == mainThread:
            s.turnRunning = true
            s.status = .thinking
            s.streamingText = ""
            s.lastTurnAborted = false // a fresh turn clears any prior interrupt flag
        case .toolCall(let v) where v.threadId == mainThread:
            if s.pendingInteractions.isEmpty { s.status = .toolRunning(name: v.name) }
            appendActivity(.tool(name: v.name, detail: extractToolDetail(name: v.name, argsJson: v.argsJson)), to: &s)
        case .toolResult(let v) where v.threadId == mainThread:
            if s.pendingInteractions.isEmpty { s.status = .thinking }
        case .approvalRequested(let v) where v.threadId == mainThread:
            appendPending(.approval(callId: v.callId, toolName: v.toolName, summary: v.summary), to: &s)
            appendActivity(.interaction(v.summary), to: &s)
        case .questionAsked(let v) where v.threadId == mainThread:
            appendPending(.question(callId: v.callId, questions: v.questions), to: &s)
            appendActivity(.interaction(v.questions.first?.question ?? "question"), to: &s)
        case .planPresented(let v) where v.threadId == mainThread:
            appendPending(.plan(callId: v.callId, plan: v.plan), to: &s)
            appendActivity(.interaction("plan presented"), to: &s)
        case .approvalResolved(let v):
            s = resolvePending(s, callId: v.callId)
        case .questionResolved(let v):
            s = resolvePending(s, callId: v.callId)
        case .planResolved(let v):
            s = resolvePending(s, callId: v.callId)
        case .assistantDelta(let v) where v.threadId == mainThread:
            s.streamingText += v.delta
        case .assistantMessage(let v) where v.threadId == mainThread:
            s.lastReply = v.text
            s.streamingText = ""
            if s.exchanges.isEmpty {
                s.exchanges.append(Exchange(prompt: "", reply: v.text))
            } else {
                s.exchanges[s.exchanges.count - 1].reply = v.text
            }
        case .turnCompleted(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingInteractions = []
            s.streamingText = ""
            s.status = .idle
            s.queuedSteers = [] // the turn absorbed whatever was queued for it
            s.lastTurnAborted = (v.stopReason == "aborted") // Esc-interrupt feedback (gate polish)
            if v.stopReason == "aborted", !s.exchanges.isEmpty {
                // Per-exchange record of the interrupt (2d-ii-a task 1) — unlike the transient
                // lastTurnAborted flash above, this stays on the exchange for the transcript.
                s.exchanges[s.exchanges.count - 1].aborted = true
            }
        case .agentError(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingInteractions = []
            s.streamingText = ""
            s.status = .idle
            s.queuedSteers = [] // the turn died with whatever was queued for it
            if let last = s.exchanges.indices.last, s.exchanges[last].reply.isEmpty {
                s.exchanges[last].reply = "⚠︎ \(v.message)"
            }
        case .taskUpdated(let v): // any thread — tasks are session-wide
            // 2d-ii-a task 1: remember the PRE-upsert status so activity capture below can
            // append only when this event actually transitioned the task (nil = brand-new
            // task, which counts as a change). The helper's adjacent-dupe collapse is a
            // second net, not the primary dedupe.
            let previousStatus = s.tasks.first(where: { $0.id == v.task.id })?.status
            if let i = s.tasks.firstIndex(where: { $0.id == v.task.id }) {
                s.tasks[i].subject = v.task.subject
                s.tasks[i].status = v.task.status
                s.tasks[i].activeForm = v.task.activeForm
                // Task 2 (2e-i): stamp startedTs the moment this task FIRST enters in_progress —
                // previousStatus != "in_progress" covers both "was pending" and "was absent until
                // the branch above just wrote status" (previousStatus is read BEFORE this
                // mutation). A repeated in_progress update (previousStatus already "in_progress")
                // must NOT reset the timer, so startedTs is left untouched in that case —
                // event.ts only, never a client clock, keeps the reducer pure.
                if v.task.status == "in_progress", previousStatus != "in_progress" {
                    s.tasks[i].startedTs = v.ts
                }
            } else {
                // GATE-4 FIX (item 2 — "tasks never clear"): `v.task.id` not being in `s.tasks`
                // means the daemon just called `task_create`, never `task_update` (see
                // `packages/core/src/agent/tools/tasks.ts`: only `task_create` can mint a new
                // id; `task_update` 404s on an unknown one — `TaskStore.create`'s ids are a
                // monotonic session-wide counter, `String(m.size + 1)`, so they're never reused
                // either). The daemon's `TaskStore` never removes tasks (no delete op exists —
                // see its doc) and the wire protocol has no "deleted" status
                // (`TaskSchema.status` is pending/in_progress/completed only,
                // packages/protocol/src/events.ts) — by design, session task HISTORY is kept
                // forever for CLI/replay purposes. That's correct for the CLI, but this orb pill
                // is a CURRENT-RUN indicator, not a session history view: upserting forever into
                // one flat array made `taskCounts` (done/total) accumulate across every task
                // list the session ever had, so completing one 3-task run and starting a new one
                // showed "☑ 4/6 working…" instead of "☑ 1/3 working…" — the old, finished batch
                // visually never went away.
                //
                // Fix, scoped entirely to this reducer (no daemon change — see wave-4 report for
                // why a daemon-side "deleted" status is out of scope this wave): a brand-new
                // task id arriving while the CURRENT list has nothing in_progress and every
                // existing task is already completed is exactly "the start of a new batch" —
                // there is no in-flight work the old entries could still be tracking. Clear the
                // finished batch before appending the new task, so the pill's counts reset to
                // just the new list. A new task id arriving mid-run (something still
                // pending/in_progress) is NOT a batch boundary and must NOT reset — the two
                // conditions below are individually sufficient (an all-completed list trivially
                // has nothing in_progress) but both are spelled out to match that reasoning
                // explicitly rather than relying on one to imply the other.
                if !s.tasks.isEmpty,
                   !s.tasks.contains(where: { $0.status == "in_progress" }),
                   s.tasks.allSatisfy({ $0.status == "completed" }) {
                    s.tasks.removeAll()
                }
                s.tasks.append(TaskItem(
                    id: v.task.id,
                    subject: v.task.subject,
                    status: v.task.status,
                    activeForm: v.task.activeForm,
                    // Brand-new task (previousStatus nil, i.e. "absent") — same "absent OR not
                    // already in_progress" rule as the upsert branch above.
                    startedTs: v.task.status == "in_progress" ? v.ts : nil
                ))
            }
            // Transcript activity is MAIN-thread only (child-thread task churn still upserts
            // above — tasks are session-wide — but must not pollute the main transcript).
            if v.threadId == mainThread, previousStatus != v.task.status {
                appendActivity(.task(subject: v.task.subject, status: v.task.status), to: &s)
            }
        case .worktreeEntered(let v) where v.threadId == mainThread:
            appendActivity(.worktree(entered: true, detail: v.branch), to: &s)
        case .worktreeExited(let v) where v.threadId == mainThread:
            appendActivity(.worktree(entered: false, detail: v.name), to: &s)
        case .threadStarted(let v):
            // Subagent lifecycle events carry CHILD threadIds by nature, so a main-thread guard
            // would drop all of them — yet they ARE main-transcript-relevant ("spawned an agent").
            // Guard on turnRunning instead: only capture while the main turn is actually going.
            if s.turnRunning { appendActivity(.subagent(agentType: v.agentType), to: &s) }
        case .threadCompleted:
            if s.turnRunning { appendActivity(.subagentDone, to: &s) }
        default:
            break // messages/deltas/bg/checkpoint/harness + child-thread events don't move state
        }
        return s
    }

    /// Appends a new pending interaction and re-derives `status`'s count — 2d-iii task 1. Replay
    /// dedupe: an `*_requested`/`*_asked`/`*_presented` event for a callId already in the list
    /// (the daemon replaying its event log from the top) is a no-op, not a second card — mirrors
    /// how `taskUpdated` above treats a re-seen id as an update rather than a duplicate.
    private static func appendPending(_ item: PendingInteraction, to state: inout OrbSessionState) {
        guard !state.pendingInteractions.contains(where: { $0.callId == item.callId }) else { return }
        state.pendingInteractions.append(item)
        state.status = .approvalNeeded(count: state.pendingInteractions.count)
    }

    /// Appends to the exchange currently being built. Transcript capture is MAIN-thread only
    /// and defensive: no open exchange → drop. Adjacent duplicates collapse — EXCEPT `.tool`
    /// (LIVE-GATE G3): every tool call is now its own item, even back-to-back calls to the same
    /// tool, so the transcript can show an accurate per-call count/detail list (grouping into
    /// "Ran N shell commands" etc. is the VIEW's job, `groupActivity` in ChatContent, not the
    /// reducer's). Capped at 200 (drop-oldest) so a marathon turn can't balloon memory (spec §1).
    private static func appendActivity(_ kind: ActivityItem.Kind, to state: inout OrbSessionState) {
        guard !state.exchanges.isEmpty else { return }
        let last = state.exchanges.count - 1
        if case .tool = kind {
            // no adjacent-dupe collapse — see doc comment above.
        } else if state.exchanges[last].activity.last?.kind == kind {
            return
        }
        state.exchanges[last].activity.append(ActivityItem(kind: kind))
        if state.exchanges[last].activity.count > 200 {
            state.exchanges[last].activity.removeFirst(state.exchanges[last].activity.count - 200)
        }
    }

    /// LIVE-GATE G3: a short, tool-specific hint pulled from the tool call's raw `argsJson` —
    /// pure JSON parsing, no throwing (malformed/missing JSON, or a field of the wrong type,
    /// all fall through to `nil`; this must never crash the reducer). `bash` → the command's
    /// first line, clipped to 100 chars (long heredocs/scripts stay one line). `task_create`/
    /// `task_update` → the task's `subject`. `read`/`write`/`edit`/`glob`/`grep` → whichever of
    /// `file_path`/`path`/`pattern` is present (different tools use different field names for
    /// "the thing this call touched"). Anything else → `nil` — not every tool has a useful
    /// one-line summary, and that's fine, the group just renders with no detail lines.
    private static func extractToolDetail(name: String, argsJson: String) -> String? {
        guard let data = argsJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        switch name {
        case "bash":
            guard let command = obj["command"] as? String, !command.isEmpty else { return nil }
            let firstLine = command.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                .first.map(String.init) ?? command
            return String(firstLine.prefix(100))
        case "task_create", "task_update":
            guard let subject = obj["subject"] as? String, !subject.isEmpty else { return nil }
            return subject
        case "read", "write", "edit", "glob", "grep", "ls":
            if let path = obj["file_path"] as? String, !path.isEmpty { return path }
            if let path = obj["path"] as? String, !path.isEmpty { return path }
            if let pattern = obj["pattern"] as? String, !pattern.isEmpty { return pattern }
            return nil
        default:
            return nil
        }
    }

    static func reduceConnection(_ state: OrbSessionState, _ conn: ConnectionState) -> OrbSessionState {
        var s = state
        switch conn {
        case .disconnected, .reconnecting:
            s.status = .disconnected
        case .connected:
            s.status = s.pendingInteractions.isEmpty
                ? (s.turnRunning ? .thinking : .idle)
                : .approvalNeeded(count: s.pendingInteractions.count)
        }
        return s
    }

    private static func resolvePending(_ state: OrbSessionState, callId: String) -> OrbSessionState {
        var s = state
        s.pendingInteractions.removeAll { $0.callId == callId }
        if case .approvalNeeded = s.status {
            s.status = s.pendingInteractions.isEmpty
                ? (s.turnRunning ? .thinking : .idle)
                : .approvalNeeded(count: s.pendingInteractions.count)
        }
        return s
    }
}

@MainActor
final class SessionModel: ObservableObject {
    @Published private(set) var state = OrbSessionState()

    func apply(_ event: SessionEvent) {
        state = SessionReducer.reduce(state, event)
        // Store-level impurity seam (wave 6, item 1): `SessionReducer.reduce` must stay pure —
        // no `Bool`/`Int`/`Array.randomElement` inside it, or two calls with identical inputs
        // could produce different outputs, which breaks the reducer's testability/replay
        // contract. So the ONE random roll a turn needs happens HERE, right after the pure
        // reduce, keyed off the same `turnStarted(main)` case the reducer used to flip
        // `turnRunning`/`status` — this is the one and only place `workingVerb` is assigned by
        // production code; `OrbSessionState.workingVerb`'s doc comment points back here.
        if case .turnStarted(let v) = event, v.threadId == "main" {
            state.workingVerb = WorkingVerbs.random()
        }
    }

    func apply(connection: ConnectionState) {
        state = SessionReducer.reduceConnection(state, connection)
    }

    /// M2 contract: NormaClient.connect() yields NO initial `.connected` event —
    /// the app layer calls this after connect() returns.
    func markConnected() {
        state = SessionReducer.reduceConnection(state, .connected)
    }

    /// New focus target: drop per-session state before replaying another session.
    func reset() {
        let wasConnected = state.status != .disconnected
        state = OrbSessionState()
        if wasConnected { state.status = .idle }
    }

    /// Test-only mutation seam (Task 2, fluid state derivation tests): lets tests set arbitrary
    /// `OrbSessionState` fields directly (e.g. `turnRunning`, `tasks`) without constructing a full
    /// `SessionEvent`/`SessionReducer` round trip for state combinations the real event stream
    /// wouldn't produce on its own (e.g. "turnRunning with no tasks"). Internal, not `public` —
    /// reachable from `FluidStateTests` via `@testable import Norma`, same convention as
    /// `OrbWindowController.morphProgressForTesting`.
    func applyForTesting(_ mutate: (inout OrbSessionState) -> Void) {
        mutate(&state)
    }
}
