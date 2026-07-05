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
    func delta(_ text: String, seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"assistant_delta","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","delta":"\#(text)"}"#)
    }
    func assistantMessage(_ text: String, seq: Int = 5, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"assistant_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)"}"#)
    }
    func userMessage(_ text: String, seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)","clientName":"cli"}"#)
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

    // MARK: Task list current-run scoping (gate wave-4 item 2 — "tasks never clear")

    /// (a) A brand-new task id arriving right after the current list finished completely (no
    /// in_progress, everything completed) is the start of a new batch — the finished batch's
    /// counts must not carry forward and inflate the new list's total.
    func testNewTaskAfterFullCompletionResetsCounts() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "pending", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "pending", seq: 8))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 9))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "completed", seq: 10))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "completed", seq: 11))
        XCTAssertEqual(s.taskCounts.done, 3)
        XCTAssertEqual(s.taskCounts.total, 3)

        // Next run's first task_create (a brand-new, never-seen id) arrives — must reset, not
        // accumulate onto the finished 3/3 batch.
        s = SessionReducer.reduce(s, taskUpdated(id: "4", subject: "d", status: "pending", seq: 12))
        XCTAssertEqual(s.tasks.map(\.id), ["4"])
        XCTAssertEqual(s.taskCounts.done, 0)
        XCTAssertEqual(s.taskCounts.total, 1)

        // The rest of the new batch arriving doesn't resurrect the old one either.
        s = SessionReducer.reduce(s, taskUpdated(id: "5", subject: "e", status: "pending", seq: 13))
        s = SessionReducer.reduce(s, taskUpdated(id: "6", subject: "f", status: "pending", seq: 14))
        XCTAssertEqual(s.taskCounts.done, 0)
        XCTAssertEqual(s.taskCounts.total, 3)
    }

    /// (b) Once the turn that finished the tasks actually completes (idle), the "☑ n/m working…"
    /// pill must disappear entirely, not linger at "n/n". `FieldStateAdapter.statusText` is the
    /// thing the collapsed orb's pill visibility (`hasStatusPill`) actually reads.
    @MainActor
    func testIdleAfterFullCompletionHasNoWorkingPillText() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        session.apply(taskUpdated(id: "1", subject: "a", status: "pending"))
        session.apply(taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 7))
        session.apply(taskUpdated(id: "1", subject: "a", status: "completed", seq: 8))
        let adapter = FieldStateAdapter(session: session)
        // Still turnRunning (turn_completed hasn't arrived yet) — the "all done" pill is
        // expected here (spec: only IDLE hides it), not a regression this test guards.
        XCTAssertEqual(adapter.statusText, "☑ 1/1 working…")

        session.apply(turnCompleted(seq: 9))
        XCTAssertEqual(adapter.statusText, "")
    }

    /// (c) A new task created MID-RUN (something from the current batch still in_progress) must
    /// NOT be treated as a new batch — it just grows the current list normally.
    func testMidRunTaskAddDoesNotResetCounts() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "pending", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 8))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "pending", seq: 9))
        XCTAssertEqual(s.tasks.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(s.taskCounts.done, 0)
        XCTAssertEqual(s.taskCounts.total, 3)

        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 10))
        // Task 1 done, task 2 still merely pending (not in_progress) — NOT "no task in_progress
        // AND all completed" (task 2/3 aren't completed), so a new id here still must not reset.
        s = SessionReducer.reduce(s, taskUpdated(id: "4", subject: "d", status: "pending", seq: 11))
        XCTAssertEqual(s.tasks.map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(s.taskCounts.done, 1)
        XCTAssertEqual(s.taskCounts.total, 4)
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

    func testReconnectPreservesPendingApprovalStatus() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "c1"))
        s = SessionReducer.reduceConnection(s, .disconnected)
        XCTAssertEqual(s.status, .disconnected)
        s = SessionReducer.reduceConnection(s, .connected)
        XCTAssertEqual(s.status, .approvalNeeded(count: 1)) // pending survives the reconnect
    }

    func testWorkingPillText() {
        XCTAssertEqual(workingPillText(done: 0, total: 4), "☑ 1/4 working…")
        XCTAssertEqual(workingPillText(done: 3, total: 4), "☑ 4/4 working…")
        XCTAssertEqual(workingPillText(done: 4, total: 4), "☑ 4/4 working…")
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

    func testDeltasAccumulateAndFinalSwaps() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("Hel"))
        s = SessionReducer.reduce(s, delta("lo", seq: 3))
        XCTAssertEqual(s.streamingText, "Hello")
        s = SessionReducer.reduce(s, assistantMessage("Hello there"))
        XCTAssertEqual(s.lastReply, "Hello there")
        XCTAssertEqual(s.streamingText, "")
    }

    func testNewTurnClearsStreamingKeepsLastReply() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("old"))
        s = SessionReducer.reduce(s, assistantMessage("old answer"))
        s = SessionReducer.reduce(s, turnCompleted())
        s = SessionReducer.reduce(s, turnStarted(seq: 10))
        XCTAssertEqual(s.streamingText, "")
        XCTAssertEqual(s.lastReply, "old answer") // visible until the new reply streams
    }

    func testChildThreadDeltasIgnored() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("child", thread: "th_1"))
        XCTAssertEqual(s.streamingText, "")
    }

    func testAbortedTurnClearsStreamingText() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("partial"))
        s = SessionReducer.reduce(s, turnCompleted()) // abort/end without assistant_message
        XCTAssertEqual(s.streamingText, "")
        XCTAssertFalse(s.turnRunning)

        s = SessionReducer.reduce(s, turnStarted(seq: 10))
        s = SessionReducer.reduce(s, delta("more", seq: 11))
        s = SessionReducer.reduce(s, ev(#"{"type":"agent_error","seq":12,"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#))
        XCTAssertEqual(s.streamingText, "")
    }

    // MARK: Exchange pairing (2c wave 2 task 3 — inline response reads exchanges, not lastReply)

    func testUserAndAssistantMessagePairIntoOneExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi there"))
        s = SessionReducer.reduce(s, assistantMessage("hello!", seq: 2))
        XCTAssertEqual(s.exchanges, [Exchange(prompt: "hi there", reply: "hello!")])
    }

    func testAssistantMessageWithoutPriorUserMessageCreatesEmptyPromptExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, assistantMessage("orphan reply"))
        XCTAssertEqual(s.exchanges, [Exchange(prompt: "", reply: "orphan reply")])
    }

    func testTwoTurnsProduceTwoOrderedExchanges() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("first", seq: 1))
        s = SessionReducer.reduce(s, assistantMessage("first reply", seq: 2))
        s = SessionReducer.reduce(s, userMessage("second", seq: 3))
        s = SessionReducer.reduce(s, assistantMessage("second reply", seq: 4))
        XCTAssertEqual(s.exchanges, [
            Exchange(prompt: "first", reply: "first reply"),
            Exchange(prompt: "second", reply: "second reply"),
        ])
    }

    /// Real wire order (send appends the user_message BEFORE the turn starts): user_message("A")
    /// arrives while turnRunning is still false (idle from the previous turn), so it correctly
    /// starts a fresh exchange. Then turn_started flips turnRunning true. A steer mid-turn is a
    /// SECOND user_message(main) with no intervening turn_started — it must fold into the SAME
    /// exchange (grow the prompt) rather than open a second one, so the eventual reply lands on
    /// the exchange the user was actually looking at.
    func testMidTurnSteerFoldsIntoSameExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("A", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, userMessage("B", seq: 3)) // steer: turnRunning already true
        s = SessionReducer.reduce(s, assistantMessage("done", seq: 4))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].prompt, "A\n↳ B")
        XCTAssertEqual(s.exchanges[0].reply, "done")
    }

    /// Regression: two sequential (non-steer) turns — each user_message arrives with turnRunning
    /// false (the prior turn already completed) — still produce two separate exchanges.
    func testSequentialTurnsAfterCompletionStillProduceTwoExchanges() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("first", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, assistantMessage("first reply", seq: 3))
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        s = SessionReducer.reduce(s, userMessage("second", seq: 5))
        s = SessionReducer.reduce(s, turnStarted(seq: 6))
        s = SessionReducer.reduce(s, assistantMessage("second reply", seq: 7))
        XCTAssertEqual(s.exchanges, [
            Exchange(prompt: "first", reply: "first reply"),
            Exchange(prompt: "second", reply: "second reply"),
        ])
    }

    /// An errored turn (agent_error, no assistant_message) fills the still-empty exchange's
    /// reply with the error message instead of leaving it blank forever.
    func testAgentErrorFillsEmptyReplyOnLastExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("do the thing", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, ev(#"{"type":"agent_error","seq":3,"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#))
        XCTAssertEqual(s.exchanges, [Exchange(prompt: "do the thing", reply: "⚠︎ boom")])
    }
}
