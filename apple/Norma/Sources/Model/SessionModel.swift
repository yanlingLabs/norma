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
    let prompt: String
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
            s.exchanges.append(Exchange(prompt: v.text, reply: ""))
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
        case .agentError(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingApprovalIds = []
            s.streamingText = ""
            s.status = .idle
        case .taskUpdated(let v): // any thread — tasks are session-wide
            if let i = s.tasks.firstIndex(where: { $0.id == v.task.id }) {
                s.tasks[i].subject = v.task.subject
                s.tasks[i].status = v.task.status
            } else {
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
