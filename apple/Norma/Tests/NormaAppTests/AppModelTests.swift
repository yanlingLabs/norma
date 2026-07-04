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
