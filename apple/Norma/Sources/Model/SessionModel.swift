import Foundation
import NormaProtocol
import NormaKit

struct TaskItem: Equatable {
    let id: String
    var subject: String
    var status: String
}

/// A user prompt paired with its reply — the field's inline-response shell (2c wave 2 task 3)
/// reads `exchanges.last` instead of the flat `lastReply` string so it can tell "no reply yet"
/// (empty `reply`) apart from "no exchange at all" (empty array), and so a later wave can render
/// prior turns without re-deriving pairing from the flat event log.
struct Exchange: Equatable {
    var prompt: String
    var reply: String
}

struct OrbSessionState: Equatable {
    var status: OrbStatus = .disconnected // until markConnected() — M2 contract
    var tasks: [TaskItem] = []
    var pendingApprovalIds: Set<String> = []
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
        case .toolCall(let v) where v.threadId == mainThread:
            if s.pendingApprovalIds.isEmpty { s.status = .toolRunning(name: v.name) }
        case .toolResult(let v) where v.threadId == mainThread:
            if s.pendingApprovalIds.isEmpty { s.status = .thinking }
        case .approvalRequested(let v) where v.threadId == mainThread:
            s.pendingApprovalIds.insert(v.callId)
            s.status = .approvalNeeded(count: s.pendingApprovalIds.count)
        case .questionAsked(let v) where v.threadId == mainThread:
            s.pendingApprovalIds.insert(v.callId)
            s.status = .approvalNeeded(count: s.pendingApprovalIds.count)
        case .planPresented(let v) where v.threadId == mainThread:
            s.pendingApprovalIds.insert(v.callId)
            s.status = .approvalNeeded(count: s.pendingApprovalIds.count)
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
            s.pendingApprovalIds = []
            s.streamingText = ""
            s.status = .idle
            s.queuedSteers = [] // the turn absorbed whatever was queued for it
        case .agentError(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingApprovalIds = []
            s.streamingText = ""
            s.status = .idle
            s.queuedSteers = [] // the turn died with whatever was queued for it
            if let last = s.exchanges.indices.last, s.exchanges[last].reply.isEmpty {
                s.exchanges[last].reply = "⚠︎ \(v.message)"
            }
        case .taskUpdated(let v): // any thread — tasks are session-wide
            if let i = s.tasks.firstIndex(where: { $0.id == v.task.id }) {
                s.tasks[i].subject = v.task.subject
                s.tasks[i].status = v.task.status
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
                s.tasks.append(TaskItem(id: v.task.id, subject: v.task.subject, status: v.task.status))
            }
        default:
            break // messages/deltas/bg/worktree/checkpoint/harness events don't move the orb in 2b
        }
        return s
    }

    static func reduceConnection(_ state: OrbSessionState, _ conn: ConnectionState) -> OrbSessionState {
        var s = state
        switch conn {
        case .disconnected, .reconnecting:
            s.status = .disconnected
        case .connected:
            s.status = s.pendingApprovalIds.isEmpty
                ? (s.turnRunning ? .thinking : .idle)
                : .approvalNeeded(count: s.pendingApprovalIds.count)
        }
        return s
    }

    private static func resolvePending(_ state: OrbSessionState, callId: String) -> OrbSessionState {
        var s = state
        s.pendingApprovalIds.remove(callId)
        if case .approvalNeeded = s.status {
            s.status = s.pendingApprovalIds.isEmpty
                ? (s.turnRunning ? .thinking : .idle)
                : .approvalNeeded(count: s.pendingApprovalIds.count)
        }
        return s
    }
}

@MainActor
final class SessionModel: ObservableObject {
    @Published private(set) var state = OrbSessionState()

    func apply(_ event: SessionEvent) {
        state = SessionReducer.reduce(state, event)
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
}
