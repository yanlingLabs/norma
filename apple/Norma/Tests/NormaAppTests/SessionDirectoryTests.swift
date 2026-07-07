import XCTest
import NormaProtocol
@testable import Norma

/// Stub `lister` — a mutable box test cases swap the returned rows on, mirroring the
/// scripted-transport doubles' mutable-state convention used elsewhere in this test target
/// (`AppScriptedTransport`/`FeedScriptedTransport`), just for `SessionDirectory`'s own
/// injected dependency instead of a socket.
final class StubSessionLister {
    var rows: [SessionSummary] = []
    var delayNanoseconds: UInt64 = 0
    private(set) var callCount = 0

    func list() async throws -> [SessionSummary] {
        callCount += 1
        if delayNanoseconds > 0 { try await Task.sleep(nanoseconds: delayNanoseconds) }
        return rows
    }
}

@MainActor
func waitUntilDirectory(_ timeout: TimeInterval = 3, _ cond: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !cond() && Date() < deadline {
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

@MainActor
final class SessionDirectoryTests: XCTestCase {
    // Event factory — same convention as SessionModelTests.ev: wire-shaped JSON decoded through
    // SessionEvent's real Codable conformance (its memberwise inits aren't public).
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func sessionCreated(sessionId: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"session_created","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"scope":"global"}"#)
    }
    func sessionTitled(sessionId: String, title: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"session_titled","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"threadId":"main","title":"\#(title)"}"#)
    }

    func testRefreshSortsRowsNewestFirst() async {
        let stub = StubSessionLister()
        stub.rows = [
            SessionSummary(sessionId: "old", title: nil, createdAt: 1, scope: "global", cwd: nil),
            SessionSummary(sessionId: "newest", title: nil, createdAt: 3, scope: "global", cwd: nil),
            SessionSummary(sessionId: "mid", title: nil, createdAt: 2, scope: "global", cwd: nil),
        ]
        let directory = SessionDirectory(lister: stub.list)
        XCTAssertTrue(directory.rows.isEmpty, "no rows before the first refresh")

        await directory.refresh()
        XCTAssertEqual(directory.rows.map(\.sessionId), ["newest", "mid", "old"])
    }

    func testRefreshKeepsOldRowsOnListerError() async {
        struct ListerFailure: Error {}
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertEqual(directory.rows.count, 1)

        let failingDirectory = SessionDirectory(lister: { throw ListerFailure() })
        // Seed via the working stub first is irrelevant here — this proves a THROWING lister simply
        // leaves whatever rows already existed (empty, in this fresh instance) rather than crashing
        // or clearing state unexpectedly.
        await failingDirectory.refresh()
        XCTAssertTrue(failingDirectory.rows.isEmpty)
    }

    func testHandleSessionCreatedKicksARefresh() async {
        let stub = StubSessionLister()
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertTrue(directory.rows.isEmpty)

        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        directory.handle(sessionCreated(sessionId: "s1"))

        await waitUntilDirectory { directory.rows.count == 1 }
        XCTAssertEqual(directory.rows.first?.sessionId, "s1")
    }

    func testHandleSessionTitledKicksARefresh() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertNil(directory.rows.first?.title)

        stub.rows = [SessionSummary(sessionId: "s1", title: "server title", createdAt: 1, scope: "global", cwd: nil)]
        directory.handle(sessionTitled(sessionId: "s1", title: "server title"))

        await waitUntilDirectory { directory.rows.first?.title == "server title" }
        XCTAssertEqual(directory.rows.first?.title, "server title")
    }

    /// The titled event must patch the KNOWN row's title in place, SYNCHRONOUSLY inside `handle` —
    /// not merely as a side effect of the refresh() round trip it also kicks off. Proven with a
    /// deliberately slow lister: the assertion runs immediately after `handle` returns, before the
    /// kicked-off `Task { await refresh() }` could possibly have completed.
    func testHandleSessionTitledPatchesInPlaceBeforeRefreshCompletes() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh() // fast seed
        XCTAssertNil(directory.rows.first?.title)

        stub.delayNanoseconds = 2_000_000_000 // any refresh kicked off below hangs well past this test
        directory.handle(sessionTitled(sessionId: "s1", title: "fresh title"))

        XCTAssertEqual(directory.rows.first?.title, "fresh title",
                        "title patch must be synchronous, not wait on the refresh round-trip")
    }

    /// FINAL-REVIEW FIX (M1): `startInitialLoad()` is the exact method `AppModel.init` and
    /// `DetachedWindowController.init` call right after constructing their own `directory` (see
    /// those files' "FINAL-REVIEW FIX (M1)" comments) instead of inlining a bare
    /// `Task { await refresh() }` at each call site — pinning ITS contract here (exactly one lister
    /// call, rows populated from empty) means this test goes red if `startInitialLoad()`'s body is
    /// ever gutted back to a no-op, the same regression the finding calls out ("SessionDirectory
    /// never does its INITIAL load").
    func testStartInitialLoadKicksExactlyOneRefresh() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: "hi", createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        XCTAssertTrue(directory.rows.isEmpty, "no rows before the initial load")

        directory.startInitialLoad()

        await waitUntilDirectory { directory.rows.count == 1 }
        XCTAssertEqual(directory.rows.first?.sessionId, "s1")
        try? await Task.sleep(nanoseconds: 150_000_000) // settle: prove it doesn't double-fire
        XCTAssertEqual(stub.callCount, 1, "startInitialLoad must kick exactly one lister call")
    }

    func testHandleSessionTitledForUnknownRowStillKicksRefresh() async {
        let stub = StubSessionLister()
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertTrue(directory.rows.isEmpty)

        // A titled event for a row this directory hasn't seen yet (e.g. arrived before its own
        // session_created broadcast) must not crash — just fall through to the refresh kick.
        stub.rows = [SessionSummary(sessionId: "s9", title: "server title", createdAt: 5, scope: "global", cwd: nil)]
        directory.handle(sessionTitled(sessionId: "s9", title: "server title"))

        await waitUntilDirectory { directory.rows.count == 1 }
        XCTAssertEqual(directory.rows.first?.sessionId, "s9")
    }
}
