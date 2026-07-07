import XCTest
import AppKit
import NormaProtocol
import NormaKit
@testable import Norma

/// Local copy of `SessionFeedTests`' scripted-transport double (`FeedScriptedTransport`),
/// `Detached`-prefixed per that file's own established convention (see its header comment) — plus
/// a `closeCallCount` this suite needs to prove `feed.stop()` actually closed the transport
/// (`testCloseStopsFeedAndFiresOnClosedOnce`), which the other copies don't track.
final class DetachedScriptedTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _closeCallCount = 0
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }
    var closeCallCount: Int { lock.lock(); defer { lock.unlock() }; return _closeCallCount }

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
    func close() {
        lock.lock(); _closeCallCount += 1; lock.unlock()
        cont.yield(.closed(nil)); cont.finish()
    }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
}

@MainActor
final class DetachedWindowTests: XCTestCase {
    func waitUntilSent(_ t: DetachedScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    /// Drives a pinned feed's handshake to "connected" (hello, then attach — pinned mode skips
    /// session.list) so `client.transport` is live and RPCs (steer/send/interrupt) actually reach
    /// the wire, mirroring `SessionFeedTests.answerPinnedHandshake`.
    func answerHandshake(_ t: DetachedScriptedTransport, sessionId: String) async {
        await waitUntilSent(t, 1)
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, sessionId)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
    }

    func testShowCreatesNativeChromeWindowAtFrame() {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let frame = NSRect(x: 120, y: 80, width: 560, height: 640)
        let controller = DetachedWindowController(feed: feed, session: session, frame: frame, title: "Test Window")
        defer { controller.close() }

        controller.show()

        guard let window = controller.windowForTesting else {
            XCTFail("show() must construct a real window")
            return
        }
        XCTAssertTrue(window.styleMask.contains(.titled))
        XCTAssertTrue(window.styleMask.contains(.miniaturizable))
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.styleMask.contains(.closable))
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(window.frame, frame)
    }

    func testCloseStopsFeedAndFiresOnClosedOnce() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )

        var closedCount = 0
        controller.onClosed = { _ in closedCount += 1 }

        controller.show()
        await waitUntilSent(t, 1) // a real handshake in flight — a live transport to close

        controller.close()
        XCTAssertEqual(closedCount, 1, "onClosed must fire on the programmatic close path")
        await feedWaitUntil { t.closeCallCount >= 1 }
        XCTAssertGreaterThanOrEqual(t.closeCallCount, 1, "feed.stop() must close the transport")

        controller.close() // already closed — must not double-fire onClosed
        XCTAssertEqual(closedCount, 1)
    }

    func testSubmitSteersWhenTurnRunning() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }

        // Drive turnRunning directly (test-only mutation seam) — no need to round-trip a real
        // turn_started event through the pump just to flip one flag.
        session.applyForTesting { $0.turnRunning = true }

        controller.adapterForTesting.composerDraft = "steer me"
        controller.adapterForTesting.onSubmit("steer me")

        await waitUntilSent(t, 3)
        let steer = feedLineJSON(t.sent[2])
        XCTAssertEqual(steer["method"] as? String, "session.steer")
        XCTAssertEqual((steer["params"] as? [String: Any])?["sessionId"] as? String, "S1")
        XCTAssertEqual((steer["params"] as? [String: Any])?["text"] as? String, "steer me")

        // success clears the draft — mirrors GlassRootView.submit's gating (spec §6)
        t.feed(#"{"jsonrpc":"2.0","id":\#(steer["id"] as! Int),"result":{"injected":true}}"#)
        await feedWaitUntil { controller.adapterForTesting.composerDraft.isEmpty }
        XCTAssertTrue(controller.adapterForTesting.composerDraft.isEmpty)
    }

    func testAppModelMakeDetachedFeedSharesTokenAndTransport() async throws {
        let t = DetachedScriptedTransport()
        let appModel = AppModel(makeTransport: { t }, token: "shared-tok", clientName: "orb")

        guard let (feed, session) = appModel.makeDetachedFeed(sessionId: "S7") else {
            XCTFail("a real token must produce a detached feed")
            return
        }
        _ = session
        XCTAssertEqual(feed.pinnedSessionId, "S7")

        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await waitUntilSent(t, 1)
        let hello = feedLineJSON(t.sent[0])
        XCTAssertEqual(hello["method"] as? String, "protocol.hello")
        XCTAssertEqual((hello["params"] as? [String: Any])?["token"] as? String, "shared-tok",
                       "the detached feed must share AppModel's own harness token")

        // AppDelegate.boot()'s degraded "no daemon token yet" fallback (AppDelegate.swift:40-51)
        // must never let a detached window spin up a harness that can't authenticate.
        let degraded = AppModel(makeTransport: { t }, token: AppModel.missingTokenSentinel, clientName: "orb")
        XCTAssertNil(degraded.makeDetachedFeed(sessionId: "S8"))
    }
}
