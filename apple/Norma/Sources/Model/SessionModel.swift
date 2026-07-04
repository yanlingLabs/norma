import Foundation
import NormaProtocol
import NormaKit

struct TaskItem: Equatable {
    let id: String
    var subject: String
    var status: String
}

struct OrbSessionState: Equatable {
    var status: OrbStatus = .disconnected // until markConnected() — M2 contract
    var tasks: [TaskItem] = []
    var pendingApprovalIds: Set<String> = []
    var turnRunning = false
    var streamingText = ""
    var lastReply: String? = nil

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
        case .turnCompleted(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingApprovalIds = []
            s.status = .idle
        case .agentError(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingApprovalIds = []
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
