import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Drives the PURE reducer directly (same pattern as SessionModelTests). Helper builders
/// mirror that file's event construction — wire-shaped JSON decoded through the real
/// `SessionEvent` decoder, so tests stay honest to the protocol.
final class ActivityCaptureTests: XCTestCase {
    // MARK: Event factory helpers (mirrors SessionModelTests idioms; extended locally for the
    // thread/worktree/question events this file needs — never in production code)

    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func userMessage(_ text: String, seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)","clientName":"cli"}"#)
    }
    func turnStarted(seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func turnCompleted(seq: Int = 9, stopReason: String = "end_turn") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"\#(stopReason)","inputTokens":1,"outputTokens":1}"#)
    }
    func toolCall(_ name: String, seq: Int = 3, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"c\#(seq)","name":"\#(name)","argsJson":"{}"}"#)
    }
    func taskUpdated(id: String, subject: String, status: String, seq: Int = 6, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"task_updated","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","task":{"id":"\#(id)","subject":"\#(subject)","status":"\#(status)"}}"#)
    }
    func threadStarted(agentType: String, seq: Int = 4, thread: String = "th_1") -> SessionEvent {
        ev(#"{"type":"thread_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","parentThreadId":"main","agentType":"\#(agentType)","prompt":"go"}"#)
    }
    func threadCompleted(seq: Int = 5, thread: String = "th_1") -> SessionEvent {
        ev(#"{"type":"thread_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","stopReason":"end_turn"}"#)
    }
    func worktreeEntered(branch: String, seq: Int = 6, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"worktree_entered","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","name":"wt","path":"/tmp/wt","branch":"\#(branch)"}"#)
    }
    func worktreeExited(name: String, seq: Int = 7, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"worktree_exited","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","name":"\#(name)","action":"merged","removed":true}"#)
    }
    func approvalRequested(summary: String, callId: String = "a1", seq: Int = 8) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"bash","summary":"\#(summary)"}"#)
    }
    func questionAsked(_ question: String, callId: String = "q1", seq: Int = 9) -> SessionEvent {
        ev(#"{"type":"question_asked","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","questions":[{"question":"\#(question)","header":"h","options":[],"multiSelect":false}]}"#)
    }
    func planPresented(callId: String = "p1", seq: Int = 10) -> SessionEvent {
        ev(#"{"type":"plan_presented","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","plan":"the plan"}"#)
    }

    /// Build a state with one open exchange (userMessage + turnStarted), main thread.
    private func openTurnState() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        return s
    }

    private func lastActivity(_ s: OrbSessionState) -> [ActivityItem] {
        s.exchanges.last?.activity ?? []
    }

    // MARK: Tool capture

    func testToolCallAppendsActivity() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash"))])
        // Existing side effect preserved: .toolCall(main) still drives status.
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
    }

    func testConsecutiveDuplicateToolsCollapse() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        s = SessionReducer.reduce(s, toolCall("read", seq: 5))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .tool(name: "bash")),
            ActivityItem(kind: .tool(name: "read")),
        ])
    }

    // MARK: Task transitions

    func testTaskTransitionAppendsOnlyOnStatusChange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 3))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .task(subject: "Do X", status: "in_progress"))])

        // Same id + same status again → the upsert changed nothing → NO new item.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 4))
        XCTAssertEqual(lastActivity(s).count, 1)

        // Status actually transitions → append.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "completed", seq: 5))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .task(subject: "Do X", status: "in_progress")),
            ActivityItem(kind: .task(subject: "Do X", status: "completed")),
        ])
        // Existing side effect preserved: the upsert still landed in tasks.
        XCTAssertEqual(s.tasks, [TaskItem(id: "1", subject: "Do X", status: "completed")])
    }

    // MARK: Subagents, worktree, interactions

    func testSubagentAndWorktreeAndInteractionCapture() {
        var s = openTurnState()
        // thread_started/completed arrive with CHILD threadIds by nature — captured anyway
        // (guarded on turnRunning, not threadId).
        s = SessionReducer.reduce(s, threadStarted(agentType: "general", seq: 3))
        s = SessionReducer.reduce(s, threadCompleted(seq: 4))
        s = SessionReducer.reduce(s, worktreeEntered(branch: "fix-x", seq: 5))
        s = SessionReducer.reduce(s, worktreeExited(name: "wt", seq: 6))
        s = SessionReducer.reduce(s, approvalRequested(summary: "rm -rf x", callId: "a1", seq: 7))
        s = SessionReducer.reduce(s, questionAsked("Which port?", callId: "q1", seq: 8))
        s = SessionReducer.reduce(s, planPresented(callId: "p1", seq: 9))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .subagent(agentType: "general")),
            ActivityItem(kind: .subagentDone),
            ActivityItem(kind: .worktree(entered: true, detail: "fix-x")),
            ActivityItem(kind: .worktree(entered: false, detail: "wt")),
            ActivityItem(kind: .interaction("rm -rf x")),
            ActivityItem(kind: .interaction("Which port?")),
            ActivityItem(kind: .interaction("plan presented")),
        ])
        // Existing side effects preserved: approval/question/plan still manage pendingApprovalIds.
        XCTAssertEqual(s.pendingApprovalIds, ["a1", "q1", "p1"])
        XCTAssertEqual(s.status, .approvalNeeded(count: 3))
    }

    func testSubagentEventsOutsideRunningTurnIgnored() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1))
        // No turn_started → turnRunning false → thread events must not append.
        s = SessionReducer.reduce(s, threadStarted(agentType: "general", seq: 2))
        s = SessionReducer.reduce(s, threadCompleted(seq: 3))
        XCTAssertEqual(lastActivity(s), [])
    }

    // MARK: Aborted flag

    func testAbortedTurnFlagsExchange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, turnCompleted(seq: 3, stopReason: "aborted"))
        XCTAssertTrue(s.exchanges.last!.aborted)

        var t = openTurnState()
        t = SessionReducer.reduce(t, turnCompleted(seq: 3, stopReason: "end_turn"))
        XCTAssertFalse(t.exchanges.last!.aborted)
    }

    // MARK: Cap (drop-oldest at 200)

    func testActivityCapAt200DropsOldest() {
        var s = openTurnState()
        for i in 1...205 {
            s = SessionReducer.reduce(s, toolCall("t\(i)", seq: i + 2))
        }
        XCTAssertEqual(lastActivity(s).count, 200)
        XCTAssertEqual(lastActivity(s).first, ActivityItem(kind: .tool(name: "t6")))
        XCTAssertEqual(lastActivity(s).last, ActivityItem(kind: .tool(name: "t205")))
    }

    // MARK: Main-thread-only + defensive guards

    func testChildThreadEventsIgnored() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3, thread: "th_child"))
        XCTAssertEqual(lastActivity(s), [])

        // A child-thread taskUpdated still upserts (tasks are session-wide) but adds no activity.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 4, thread: "th_child"))
        XCTAssertEqual(s.tasks.count, 1)
        XCTAssertEqual(lastActivity(s), [])

        // Child-thread worktree events don't append either.
        s = SessionReducer.reduce(s, worktreeEntered(branch: "b", seq: 5, thread: "th_child"))
        XCTAssertEqual(lastActivity(s), [])
    }

    func testNoOpenExchangeIsDefensiveNoop() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 1))
        XCTAssertTrue(s.exchanges.isEmpty) // no crash, nothing appended anywhere

        // turn_completed(aborted) with no exchanges must not crash either.
        s = SessionReducer.reduce(s, turnCompleted(seq: 2, stopReason: "aborted"))
        XCTAssertTrue(s.exchanges.isEmpty)
    }

    // MARK: Steer keeps one exchange

    func testSteerKeepsAccumulatingOnSameExchange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, userMessage("also do Y", seq: 4)) // mid-turn steer
        s = SessionReducer.reduce(s, toolCall("read", seq: 5))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].activity, [
            ActivityItem(kind: .tool(name: "bash")),
            ActivityItem(kind: .tool(name: "read")),
        ])
        // The steer fold itself is untouched (existing behavior byte-preserved).
        XCTAssertEqual(s.exchanges[0].prompt, "hi\n↳ also do Y")
    }

    // MARK: Purity / replay

    func testReplayRebuildsActivity() {
        let events: [SessionEvent] = [
            userMessage("go", seq: 1),
            turnStarted(seq: 2),
            toolCall("bash", seq: 3),
            taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 4),
            threadStarted(agentType: "general", seq: 5),
            threadCompleted(seq: 6),
            worktreeEntered(branch: "fix-x", seq: 7),
            approvalRequested(summary: "rm x", callId: "a1", seq: 8),
            turnCompleted(seq: 9, stopReason: "aborted"),
        ]
        let a = events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
        let b = events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
        XCTAssertEqual(a.exchanges, b.exchanges) // pure/deterministic
        XCTAssertEqual(a.exchanges.count, 1)
        XCTAssertFalse(a.exchanges[0].activity.isEmpty) // the comparison covered real capture
        XCTAssertTrue(a.exchanges[0].aborted)
    }
}
