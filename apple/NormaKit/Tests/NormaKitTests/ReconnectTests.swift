import XCTest
@testable import NormaKit

final class ReconnectTests: XCTestCase {
    func testReconnectReattachesFromLastSeq() async throws {
        // factory hands out transport A, then transport B
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = NormaClient(makeTransport: { box.next() }, token: "tok", clientName: "rc", requestTimeout: .seconds(2))

        async let connected: Void = client.connect()
        let helloA = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloA)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        // attach and see one event at seq 6
        async let attached = client.attach(sessionId: "s_1", fromSeq: 0)
        let sentA = try await waitForSent(tA, count: 2)
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sentA[1])["id"] as! Int),"result":{"ok":true,"lastSeq":6}}"#)
        _ = try await attached
        var iter = client.events.makeAsyncIterator()
        // NOTE (amendment 1/2): connect() no longer yields .connection(.connected) — removed in
        // Task 7 because AsyncStream pre-iterator FIFO buffering made it the first value every
        // iterator observed, contradicting these tests. So there is no .connected event to skip
        // here; the first iter.next() below is the turn_started session event.
        tA.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":6,"sessionId":"s_1","ts":1,"threadId":"main"}}"#)
        guard case .session? = await iter.next() else { return XCTFail() }

        // drop A → client must reconnect via B: hello then re-attach fromSeq=6
        tA.dropConnection()
        // BRIEF BUG (adjudicated, see report): brief has `count: 2` here, but the re-attach line
        // cannot exist yet — connect() awaits the hello *response* (fed below) before returning,
        // and only then does reconnectLoop call attach(). Structurally only 1 line (hello) can be
        // sent to tB at this point; proven empirically (5s timeout stuck at 1 line). Fixed to
        // count: 1 — the second waitForSent(tB, count: 2) below (after feeding the hello
        // response) is where the re-attach line actually appears.
        let sentB = try await waitForSent(tB, count: 1, timeout: 5)
        let helloB = decodeLine(sentB[0])
        XCTAssertEqual(helloB["method"] as? String, "protocol.hello")
        tB.feed(#"{"jsonrpc":"2.0","id":\#(helloB["id"] as! Int),"result":{"ok":true}}"#)
        let reattach = decodeLine(try await waitForSent(tB, count: 2)[1])
        XCTAssertEqual(reattach["method"] as? String, "session.attach")
        XCTAssertEqual((reattach["params"] as? [String: Any])?["fromSeq"] as? Int, 6)
        tB.feed(#"{"jsonrpc":"2.0","id":\#(reattach["id"] as! Int),"result":{"ok":true,"lastSeq":6}}"#)

        // events observed: disconnected → reconnecting(1) → connected
        var states: [ConnectionState] = []
        for _ in 0..<3 {
            if case .connection(let s)? = await iter.next() { states.append(s) }
        }
        XCTAssertEqual(states.first, .disconnected)
        XCTAssertEqual(states.last, .connected)
        XCTAssertTrue(states.contains(.reconnecting(attempt: 1)))
    }

    func testDeliberateCloseDoesNotReconnect() async throws {
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = NormaClient(makeTransport: { box.next() }, token: "tok", clientName: "rc2")
        async let connected: Void = client.connect()
        let hello = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        await client.close()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(tB.sent.isEmpty, "close() must not trigger reconnection")
    }
}

/// Thread-safe FIFO of scripted transports for the reconnect factory.
final class TransportBox: @unchecked Sendable {
    private let lock = NSLock()
    private var transports: [ScriptedTransport]
    init(transports: [ScriptedTransport]) { self.transports = transports }
    func next() -> ScriptedTransport {
        lock.lock(); defer { lock.unlock() }
        return transports.isEmpty ? ScriptedTransport() : transports.removeFirst()
    }
}
