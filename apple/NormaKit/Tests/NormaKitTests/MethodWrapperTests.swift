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

    func testPeripheralAndDashboardWrappers() async throws {
        let (client, t) = try await connected()
        let cases: [(String, String, () async throws -> Void)] = [
            ("peripheral.advertise", #"{"ok":true}"#, { try await client.peripheralAdvertise(classes: [(class: "noop", tccGranted: true)]) }),
            ("peripheral.revoke", #"{"ok":true}"#, { try await client.peripheralRevoke(leaseId: "lease_1", reason: "panic") }),
            ("peripheral.revoke", #"{"ok":true}"#, { try await client.peripheralRevoke(leaseId: nil, reason: "panic") }),
            ("peripheral.respond", #"{"ok":true}"#, { try await client.peripheralRespond(requestId: "req_1", resultJson: "{}", error: nil) }),
        ]
        var idx = 1
        for (method, result, call) in cases {
            let (req, _) = try await roundTrip(t, sentIndex: idx, result: result) { try await call() }
            XCTAssertEqual(req["method"] as? String, method, "wrong wire method for \(method)")
            idx += 1
        }
    }

    func testPeripheralAdvertiseAndRevokeEncodeParamsCorrectly() async throws {
        let (client, t) = try await connected()

        let (advertiseReq, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.peripheralAdvertise(classes: [(class: "screenshot", tccGranted: true), (class: "noop", tccGranted: false)])
        }
        let advertiseClasses = (advertiseReq["params"] as? [String: Any])?["classes"] as? [[String: Any]]
        XCTAssertEqual(advertiseClasses?[0]["class"] as? String, "screenshot")
        XCTAssertEqual(advertiseClasses?[0]["tccGranted"] as? Bool, true)
        XCTAssertEqual(advertiseClasses?[1]["class"] as? String, "noop")
        XCTAssertEqual(advertiseClasses?[1]["tccGranted"] as? Bool, false)

        let (revokeOneReq, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await client.peripheralRevoke(leaseId: "lease_1", reason: "expired")
        }
        let revokeOneParams = revokeOneReq["params"] as? [String: Any]
        XCTAssertEqual(revokeOneParams?["leaseId"] as? String, "lease_1")
        XCTAssertEqual(revokeOneParams?["reason"] as? String, "expired")
        XCTAssertNil(revokeOneParams?["all"])

        let (revokeAllReq, _) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true}"#) {
            try await client.peripheralRevoke(leaseId: nil, reason: "panic")
        }
        let revokeAllParams = revokeAllReq["params"] as? [String: Any]
        XCTAssertEqual(revokeAllParams?["all"] as? Bool, true)
        XCTAssertEqual(revokeAllParams?["reason"] as? String, "panic")
        XCTAssertNil(revokeAllParams?["leaseId"])
    }

    func testDashboardReadWrappers() async throws {
        let (client, t) = try await connected()

        let (statusReq, status) = try await roundTrip(t, sentIndex: 1,
            result: #"{"version":"0.1.0","uptimeMs":42,"socketPath":"/tmp/norma.sock","provider":{"id":"c_1","model":"orb"},"sessionsCount":2,"pluginsCount":0}"#
        ) { try await client.daemonStatus() }
        XCTAssertEqual(statusReq["method"] as? String, "daemon.status")
        XCTAssertEqual(status.version, "0.1.0")
        XCTAssertEqual(status.uptimeMs, 42)
        XCTAssertEqual(status.socketPath, "/tmp/norma.sock")
        XCTAssertEqual(status.providerId, "c_1")
        XCTAssertEqual(status.providerModel, "orb")
        XCTAssertEqual(status.sessionsCount, 2)
        XCTAssertEqual(status.pluginsCount, 0)

        let (quotaReq, quota) = try await roundTrip(t, sentIndex: 2,
            result: #"{"kind":"limited","resumeAt":1700000000000,"inputTokens":10,"outputTokens":5}"#
        ) { try await client.quotaState() }
        XCTAssertEqual(quotaReq["method"] as? String, "quota.state")
        XCTAssertEqual(quota.kind, "limited")
        XCTAssertEqual(quota.resumeAt, 1700000000000)
        XCTAssertEqual(quota.inputTokens, 10)
        XCTAssertEqual(quota.outputTokens, 5)

        let (trustListReq, dirs) = try await roundTrip(t, sentIndex: 3,
            result: #"{"dirs":["/Users/x/proj","/Users/x/other"]}"#
        ) { try await client.trustList() }
        XCTAssertEqual(trustListReq["method"] as? String, "trust.list")
        XCTAssertEqual(dirs, ["/Users/x/proj", "/Users/x/other"])

        let (trustRemoveReq, removed) = try await roundTrip(t, sentIndex: 4,
            result: #"{"removed":true}"#
        ) { try await client.trustRemove(path: "/Users/x/proj") }
        XCTAssertEqual(trustRemoveReq["method"] as? String, "trust.remove")
        XCTAssertEqual((trustRemoveReq["params"] as? [String: Any])?["path"] as? String, "/Users/x/proj")
        XCTAssertTrue(removed)
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

    /// Phase 2f: lease_granted/lease_lost/peripheral_call_requested are TRANSIENT exactly like
    /// assistant_delta (broadcastTransient stamps them with the store's current lastSeq, not their
    /// own) — they must bypass the seq<=lastSeq dedupe gate too, or they'd be silently dropped.
    func testPeripheralLeaseEventsAreTransientLikeAssistantDelta() async throws {
        let (client, t) = try await connected()
        async let attached = client.attach(sessionId: "s_1", fromSeq: 5)
        let sent = try await waitForSent(t, count: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":8}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        let holder = #"{"kind":"session","id":"s_1"}"#
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"lease_granted","seq":8,"sessionId":"s_1","ts":1,"threadId":"main","leaseId":"lease_1","class":"noop","holder":\#(holder),"expiresAt":20,"tokenHash":"\#(String(repeating: "a", count: 64))"}}"#)
        guard case .session(.leaseGranted(let g)) = await iter.next() else { return XCTFail("lease_granted wrongly deduped") }
        XCTAssertEqual(g.leaseId, "lease_1")

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"lease_lost","seq":8,"sessionId":"s_1","ts":2,"threadId":"main","leaseId":"lease_1","class":"noop","holder":\#(holder),"reason":"expired"}}"#)
        guard case .session(.leaseLost(let l)) = await iter.next() else { return XCTFail("lease_lost wrongly deduped") }
        XCTAssertEqual(l.reason, "expired")

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"peripheral_call_requested","seq":8,"sessionId":"s_1","ts":3,"threadId":"main","requestId":"req_1","leaseId":"lease_1","token":"tok_1","class":"noop","payloadJson":"{}"}}"#)
        guard case .session(.peripheralCallRequested(let c)) = await iter.next() else { return XCTFail("peripheral_call_requested wrongly deduped") }
        XCTAssertEqual(c.requestId, "req_1")
    }

    /// G2 live-gate fix: the seq<=lastSeq dedupe/lastSeq bookkeeping is scoped to the attached
    /// session only. A cross-session event (e.g. a fresh `session_created` broadcast for some
    /// OTHER session) must bypass the gate entirely — even while attached elsewhere at a much
    /// higher lastSeq — and must not perturb dedupe for the attached session afterward.
    func testCrossSessionEventBypassesAttachedSessionDedupe() async throws {
        let (client, t) = try await connected()
        // attach to s_1 fromSeq 5, server reports lastSeq 8
        async let attached = client.attach(sessionId: "s_1", fromSeq: 5)
        let sent = try await waitForSent(t, count: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":8}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        // a brand-new OTHER session broadcasts session_created at seq 1 — must NOT be dropped
        // even though 1 <= lastSeq(8) for the attached session.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_2","ts":1,"scope":"global"}}"#)
        guard case .session(.sessionCreated(let created)) = await iter.next() else {
            return XCTFail("cross-session event wrongly dropped by attached-session dedupe")
        }
        XCTAssertEqual(created.sessionId, "s_2")
        XCTAssertEqual(created.seq, 1)

        // dedupe for the ATTACHED session is untouched by the cross-session event: a stale
        // s_1 event (seq 4 <= lastSeq 8) is still dropped.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":4,"sessionId":"s_1","ts":2,"threadId":"main"}}"#)
        // fresh s_1 event to prove the iterator moves past the dropped one.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_message","seq":9,"sessionId":"s_1","ts":3,"threadId":"main","text":"done"}}"#)
        guard case .session(.assistantMessage(let m)) = await iter.next() else {
            return XCTFail("stale attached-session event not dropped, or fresh one not delivered")
        }
        XCTAssertEqual(m.seq, 9)
    }
}
