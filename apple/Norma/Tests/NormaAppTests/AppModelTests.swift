import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Minimal scripted transport for app-level tests (NormaTransport is public;
/// NormaKit's own test helpers aren't exported, so we keep a local double).
final class AppScriptedTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }

    init() {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }
    func open() async throws {}
    func send(_ data: Data) async throws {
        lock.lock(); defer { lock.unlock() }
        _sent.append(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines))
    }
    func close() { cont.yield(.closed(nil)); cont.finish() }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
}

func lineJSON(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

@MainActor
func waitUntil(_ timeout: TimeInterval = 3, _ cond: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !cond() && Date() < deadline {
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

@MainActor
final class AppModelTests: XCTestCase {
    /// Answers hello + session.list + session.attach as they arrive, then returns.
    func answerHandshake(_ t: AppScriptedTransport, sessions: String) async {
        // hello
        await waitUntilSent(t, 1)
        let hello = lineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        // session.list
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":\#(sessions)}}"#)
    }

    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    func testStartAttachesNewestSessionAndReducesReplay() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":9},{"sessionId":"s_new","scope":"global","createdAt":2,"lastSeq":0}]"#)
        // attach must target s_new (newest createdAt), fromSeq 0
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_new")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await waitUntil { model.session.state.status != .disconnected } // markConnected happened
        XCTAssertEqual(model.session.state.status, .idle)

        // a live event for the attached session reduces
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"s_new","ts":0,"threadId":"main"}}"#)
        await waitUntil { model.session.state.status == .thinking }
        XCTAssertEqual(model.session.state.status, .thinking)
    }

    func testSessionCreatedRefocusesToTheNewSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0}]"#)
        await waitUntilSent(t, 3)
        let attachA = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachA["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        // another harness creates s_b → the orb follows (most-recent focus)
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_b","ts":5,"scope":"global"}}"#)
        await waitUntilSent(t, 4)
        let attachB = lineJSON(t.sent[3])
        XCTAssertEqual(attachB["method"] as? String, "session.attach")
        XCTAssertEqual((attachB["params"] as? [String: Any])?["sessionId"] as? String, "s_b")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachB["id"] as! Int),"result":{"ok":true,"lastSeq":1}}"#)

        // events for s_b now reduce; stale s_a events are ignored
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":2,"sessionId":"s_b","ts":6,"threadId":"main"}}"#)
        await waitUntil { model.session.state.status == .thinking }
        XCTAssertEqual(model.session.state.status, .thinking)

        // stale s_a event after refocus must be ignored (filter is the divergence guard)
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_completed","seq":3,"sessionId":"s_a","ts":7,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(model.session.state.status, .thinking) // s_a's turn_completed did NOT flip us to idle
    }

    func testSendOrSteerCreatesSessionWhenNoneAndSends() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: "[]")
        await waitUntil { model.session.state.status == .idle }

        async let sent = model.sendOrSteer("hello")
        await waitUntilSent(t, 3)
        let create = lineJSON(t.sent[2])
        XCTAssertEqual(create["method"] as? String, "session.create")
        // Orb-created sessions run auto-approval: no approval UI exists in the orb until 2d.
        let createParams = create["params"] as? [String: Any]
        XCTAssertEqual(createParams?["approvalPolicy"] as? String, "auto")
        // REAL daemon wire order: broadcast BEFORE the RPC response.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_new","ts":0,"scope":"global"}}"#)
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new","trusted":true}}"#)
        // exactly ONE attach must follow (either path — never both)
        await waitUntilSent(t, 4)
        let attach = lineJSON(t.sent[3])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":1}}"#)
        // then the send goes out
        await waitUntilSent(t, 5)
        let send = lineJSON(t.sent[4])
        XCTAssertEqual(send["method"] as? String, "session.send")
        t.feed(#"{"jsonrpc":"2.0","id":\#(send["id"] as! Int),"result":{"seq":2}}"#)
        let ok = await sent
        XCTAssertTrue(ok)
        // settle: no SECOND attach/reset thrash may trail in
        try? await Task.sleep(nanoseconds: 300_000_000)
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "double refocus: \(t.sent)")
    }

    func testSendDuringRunningTurnSteers() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"s_1","ts":0,"threadId":"main"}}"#)
        await waitUntil { model.session.state.turnRunning }

        async let sent = model.sendOrSteer("also do X")
        // Finding-1 (gate 2): the orb forces the followed (daemon-created, ask-mode) session to
        // `auto` BEFORE steering — so a setPolicy precedes the steer on the wire.
        await waitUntilSent(t, 4)
        let policy = lineJSON(t.sent[3])
        XCTAssertEqual(policy["method"] as? String, "session.setPolicy")
        XCTAssertEqual((policy["params"] as? [String: Any])?["sessionId"] as? String, "s_1")
        XCTAssertEqual((policy["params"] as? [String: Any])?["policy"] as? String, "auto")
        t.feed(#"{"jsonrpc":"2.0","id":\#(policy["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 5)
        let steer = lineJSON(t.sent[4])
        XCTAssertEqual(steer["method"] as? String, "session.steer")
        t.feed(#"{"jsonrpc":"2.0","id":\#(steer["id"] as! Int),"result":{"ok":true,"injected":true}}"#)
        _ = await sent
    }

    /// Finding-1 (gate 2): the orb almost always DRIVES a session it merely followed (the daemon's
    /// default-`ask` global session), not one it created — so it must force that session to `auto`
    /// before the first send, and do it exactly once per session id (idempotent; daemon persists).
    func testForcesAutoPolicyOnceForFollowedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        // First send forces auto (setPolicy), THEN sends.
        async let first = model.sendOrSteer("one")
        await waitUntilSent(t, 4)
        let policy = lineJSON(t.sent[3])
        XCTAssertEqual(policy["method"] as? String, "session.setPolicy")
        XCTAssertEqual((policy["params"] as? [String: Any])?["sessionId"] as? String, "s_1")
        XCTAssertEqual((policy["params"] as? [String: Any])?["policy"] as? String, "auto")
        t.feed(#"{"jsonrpc":"2.0","id":\#(policy["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 5)
        let send1 = lineJSON(t.sent[4])
        XCTAssertEqual(send1["method"] as? String, "session.send")
        t.feed(#"{"jsonrpc":"2.0","id":\#(send1["id"] as! Int),"result":{"seq":1}}"#)
        _ = await first

        // Second send: policy already forced — straight to send, NO second setPolicy.
        async let second = model.sendOrSteer("two")
        await waitUntilSent(t, 6)
        let send2 = lineJSON(t.sent[5])
        XCTAssertEqual(send2["method"] as? String, "session.send", "second send must not re-emit setPolicy: \(t.sent)")
        t.feed(#"{"jsonrpc":"2.0","id":\#(send2["id"] as! Int),"result":{"seq":2}}"#)
        _ = await second

        let policyCalls = t.sent.filter { lineJSON($0)["method"] as? String == "session.setPolicy" }
        XCTAssertEqual(policyCalls.count, 1, "setPolicy must fire exactly once per session id: \(t.sent)")
    }

    func testInterruptTargetsFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let _: Void = model.interruptTurn()
        await waitUntilSent(t, 4)
        let intr = lineJSON(t.sent[3])
        XCTAssertEqual(intr["method"] as? String, "session.interrupt")
        XCTAssertEqual((intr["params"] as? [String: Any])?["sessionId"] as? String, "s_1")
        t.feed(#"{"jsonrpc":"2.0","id":\#(intr["id"] as! Int),"result":{"ok":true,"wasRunning":true}}"#)
    }

    /// Task 4 (detach choreography): after a detach, the orb's next summon must never keep
    /// talking into the session that just left for a standalone window — so
    /// `startFreshSessionAfterDetach()` creates + refocuses UNCONDITIONALLY, even though a focus
    /// (the just-detached session) already exists.
    func testStartFreshSessionAfterDetachCreatesAndRefocuses() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0}]"#)
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.focusedSessionId, "s_old", "a focus already exists going into the detach")

        async let _: Void = model.startFreshSessionAfterDetach()
        await waitUntilSent(t, 4)
        let create = lineJSON(t.sent[3])
        XCTAssertEqual(create["method"] as? String, "session.create", "must create unconditionally despite the existing focus")
        let createParams = create["params"] as? [String: Any]
        XCTAssertEqual(createParams?["approvalPolicy"] as? String, "auto")

        // REAL daemon wire order: broadcast BEFORE the RPC response.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_new","ts":0,"scope":"global"}}"#)
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new","trusted":true}}"#)

        await waitUntilSent(t, 5)
        let attach = lineJSON(t.sent[4])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_new", "must attach to the NEW id, not stay on s_old")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":1}}"#)

        await waitUntil { model.focusedSessionId == "s_new" }
        XCTAssertEqual(model.focusedSessionId, "s_new")
        // settle: no SECOND attach/create thrash may trail in
        try? await Task.sleep(nanoseconds: 300_000_000)
        let creates = t.sent.filter { lineJSON($0)["method"] as? String == "session.create" }
        XCTAssertEqual(creates.count, 1, "double create: \(t.sent)")
    }

    func testNoSessionsMeansConnectedIdleUnattached() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: "[]")
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.session.state.status, .idle) // connected, nothing to attach
        XCTAssertEqual(t.sent.count, 2) // hello + list only, no attach
    }
}
