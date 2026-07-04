import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

final class SessionModelTests: XCTestCase {
    // Event factory helpers — one place builds wire-shaped JSON and decodes it,
    // so tests construct any variant tersely and stay honest to the protocol.
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func turnStarted(seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func toolCall(_ name: String, seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"c\#(seq)","name":"\#(name)","argsJson":"{}"}"#)
    }
    func toolResult(seq: Int = 3, callId: String = "c2", thread: String = "main") -> SessionEvent {
        ev(#"{"type":"tool_result","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"\#(callId)","output":"ok","isError":false}"#)
    }
    func approvalRequested(callId: String, seq: Int = 4) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"bash","summary":"rm x"}"#)
    }
    func approvalResolved(callId: String, seq: Int = 5) -> SessionEvent {
        ev(#"{"type":"approval_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":true,"by":"cli"}"#)
    }
    func turnCompleted(seq: Int = 9) -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#)
    }
    func taskUpdated(id: String, subject: String, status: String, seq: Int = 6) -> SessionEvent {
        ev(#"{"type":"task_updated","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","task":{"id":"\#(id)","subject":"\#(subject)","status":"\#(status)"}}"#)
    }

    func testTurnLifecycleDrivesStatus() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        XCTAssertEqual(s.status, .thinking)
        XCTAssertTrue(s.turnRunning)
        s = SessionReducer.reduce(s, toolCall("bash"))
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
        s = SessionReducer.reduce(s, toolResult())
        XCTAssertEqual(s.status, .thinking)
        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertEqual(s.status, .idle)
        XCTAssertFalse(s.turnRunning)
    }

    func testApprovalCycleCountsAndRestores() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "c1"))
        s = SessionReducer.reduce(s, approvalRequested(callId: "c2", seq: 5))
        XCTAssertEqual(s.status, .approvalNeeded(count: 2))
        s = SessionReducer.reduce(s, approvalResolved(callId: "c1", seq: 6))
        XCTAssertEqual(s.status, .approvalNeeded(count: 1))
        s = SessionReducer.reduce(s, approvalResolved(callId: "c2", seq: 7))
        XCTAssertEqual(s.status, .thinking) // turn still running
    }

    func testChildThreadEventsDoNotChangeStatusButTasksApply() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, toolCall("read", seq: 7, thread: "th_child"))
        XCTAssertEqual(s.status, .thinking) // child tool never surfaces as main status
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "port orb", status: "in_progress"))
        XCTAssertEqual(s.tasks.count, 1)
    }

    func testTaskUpsertAndCounts() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "in_progress", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 8))
        XCTAssertEqual(s.tasks.count, 2)
        XCTAssertEqual(s.taskCounts.done, 1)
        XCTAssertEqual(s.taskCounts.total, 2)
    }

    func testTurnCompletedClearsPendingApprovals() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "c1"))
        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertEqual(s.status, .idle)
        XCTAssertTrue(s.pendingApprovalIds.isEmpty)
    }

    func testConnectionStatesOverrideAndRestore() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduceConnection(s, .disconnected)
        XCTAssertEqual(s.status, .disconnected)
        s = SessionReducer.reduceConnection(s, .reconnecting(attempt: 1))
        XCTAssertEqual(s.status, .disconnected)
        s = SessionReducer.reduceConnection(s, .connected)
        XCTAssertEqual(s.status, .thinking) // turnRunning was true
    }

    @MainActor
    func testSessionModelStorePublishesAndMarksConnected() {
        let m = SessionModel()
        XCTAssertEqual(m.state.status, .disconnected) // before markConnected: not connected yet
        m.markConnected() // M2: initial connect success IS the signal
        XCTAssertEqual(m.state.status, .idle)
        m.apply(turnStarted())
        XCTAssertEqual(m.state.status, .thinking)
    }
}
