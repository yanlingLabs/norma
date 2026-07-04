import XCTest
import NormaProtocol
@testable import NormaKit

final class MethodWrapperTests: XCTestCase {
    /// Connects a client over a scripted transport, answering hello automatically.
    func connected() async throws -> (NormaClient, ScriptedTransport) {
        let t = ScriptedTransport()
        let client = NormaClient(makeTransport: { t }, token: "tok", clientName: "wrap-test")
        async let c: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// Runs one wrapper call, answers with `result`, returns the outbound request object.
    func roundTrip<T>(
        _ t: ScriptedTransport, sentIndex: Int, result: String,
        _ call: @escaping () async throws -> T
    ) async throws -> (request: [String: Any], value: T) {
        async let v = call()
        let sent = try await waitForSent(t, count: sentIndex + 1)
        let req = decodeLine(sent[sentIndex])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(result)}"#)
        return (req, try await v)
    }

    func testCreateAttachSendEncodeCorrectMethodsAndParams() async throws {
        let (client, t) = try await connected()

        let (req1, created) = try await roundTrip(t, sentIndex: 1, result: #"{"sessionId":"s_9","trusted":true}"#) {
            try await client.createSession(scope: "global", cwd: "/tmp/proj")
        }
        XCTAssertEqual(req1["method"] as? String, "session.create")
        XCTAssertEqual((req1["params"] as? [String: Any])?["scope"] as? String, "global")
        XCTAssertEqual((req1["params"] as? [String: Any])?["cwd"] as? String, "/tmp/proj")
        XCTAssertEqual(created.sessionId, "s_9")
        XCTAssertTrue(created.trusted)

        let (req2, serverLast) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"lastSeq":41}"#) {
            try await client.attach(sessionId: "s_9", fromSeq: 40)
        }
        XCTAssertEqual(req2["method"] as? String, "session.attach")
        XCTAssertEqual((req2["params"] as? [String: Any])?["fromSeq"] as? Int, 40)
        XCTAssertEqual(serverLast, 41)

        let (req3, seq) = try await roundTrip(t, sentIndex: 3, result: #"{"seq":42}"#) {
            try await client.send(sessionId: "s_9", text: "hello")
        }
        XCTAssertEqual(req3["method"] as? String, "session.send")
        XCTAssertEqual(seq, 42)
    }

    func testRespondersAndControls() async throws {
        let (client, t) = try await connected()
        let cases: [(String, String, () async throws -> Void)] = [
            ("approval.respond", #"{"ok":true,"alreadyResolved":false}"#, { _ = try await client.approvalRespond(sessionId: "s", callId: "c1", approved: true) }),
            ("ask_user.respond", #"{"ok":true,"alreadyResolved":false}"#, { _ = try await client.askUserRespond(sessionId: "s", callId: "c1", answers: ["Q": "A"]) }),
            ("plan.respond", #"{"ok":true,"alreadyResolved":false}"#, { _ = try await client.planRespond(sessionId: "s", callId: "c1", approved: true, autoAccept: true) }),
            ("session.setPolicy", #"{"ok":true}"#, { try await client.setPolicy(sessionId: "s", policy: "auto") }),
            ("session.steer", #"{"ok":true,"injected":true}"#, { _ = try await client.steer(sessionId: "s", text: "also do X") }),
            ("session.interrupt", #"{"ok":true,"wasRunning":true}"#, { _ = try await client.interrupt(sessionId: "s") }),
            ("daemon.trustDir", #"{"ok":true,"trusted":true}"#, { _ = try await client.trustDir(path: "/tmp/p") }),
        ]
        var idx = 1
        for (method, result, call) in cases {
            let (req, _) = try await roundTrip(t, sentIndex: idx, result: result) { try await call() }
            XCTAssertEqual(req["method"] as? String, method, "wrong wire method for \(method)")
            idx += 1
        }
    }

    func testListDecoders() async throws {
        let (client, t) = try await connected()
        let (_, sessions) = try await roundTrip(t, sentIndex: 1, result: #"{"sessions":[{"sessionId":"s_1","scope":"global","createdAt":5,"lastSeq":9}]}"#) {
            try await client.listSessions()
        }
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].sessionId, "s_1")
        XCTAssertEqual(sessions[0].lastSeq, 9)

        let (_, tasks) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"tasks":[{"id":"1","subject":"do it","status":"pending"}]}"#) {
            try await client.taskList(sessionId: "s_1")
        }
        XCTAssertEqual(tasks[0].subject, "do it")
        XCTAssertNil(tasks[0].activeForm)

        let (_, threads) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true,"threads":[{"threadId":"main","status":"running"}]}"#) {
            try await client.threadList(sessionId: "s_1")
        }
        XCTAssertEqual(threads[0].threadId, "main")
        XCTAssertNil(threads[0].agentType)
    }

    func testAttachSeedsDedupeSoReplayIsNotDropped() async throws {
        let (client, t) = try await connected()
        // attach fromSeq 5: events with seq > 5 must flow, seq <= 5 must be dropped
        async let attached = client.attach(sessionId: "s_1", fromSeq: 5)
        let sent = try await waitForSent(t, count: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":8}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        // stale duplicate (already seen before disconnect) — dropped
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":5,"sessionId":"s_1","ts":1,"threadId":"main"}}"#)
        // fresh replay — delivered
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_message","seq":6,"sessionId":"s_1","ts":2,"threadId":"main","text":"done"}}"#)
        guard case .session(.assistantMessage(let m)) = await iter.next() else { return XCTFail("stale event not dropped or fresh not delivered") }
        XCTAssertEqual(m.seq, 6)
        // transient delta with seq == lastSeq still flows (dedupe exemption)
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_delta","seq":6,"sessionId":"s_1","ts":3,"threadId":"main","delta":"x"}}"#)
        guard case .session(.assistantDelta) = await iter.next() else { return XCTFail("delta wrongly deduped") }
    }
}
