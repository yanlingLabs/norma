import XCTest
import AppKit
import NormaKit
@testable import Norma

/// Task 5 (2f-ii): the Dashboard window's PURE pieces — pane order/default selection, window
/// centering geometry, and every pane's formatting helper (daemon status, quota, trust sort,
/// peripheral holder/age, session title fallback). SwiftUI bodies (`DashboardView`/`*Pane`) are
/// deliberately NOT exercised here, per this codebase's convention (see `SessionSidebar`/
/// `WorkSidebar` — never unit-tested, only their pure helpers are).
///
/// A `DashboardWindowController`/`AppDelegate.openDashboard()` construction+singleton smoke test
/// closes out the file, mirroring `DetachedWindowTests`/`StandaloneWindowTests`'s own wiring-level
/// coverage for the other window-spawn paths.
@MainActor
final class DashboardTests: XCTestCase {
    // MARK: - dashboardPaneOrder / defaultDashboardPane (PURE)

    func testDashboardPaneOrderContainsAllSixPanesInSpecOrder() {
        // Phase 4d-iii Task 2: `.pluginManager` appended at the END, every pre-existing pane keeps
        // its position (see `dashboardPaneOrder`'s own doc comment).
        XCTAssertEqual(dashboardPaneOrder, [.sessions, .daemonStatus, .quota, .trust, .peripheral, .pluginManager])
        XCTAssertEqual(Set(dashboardPaneOrder), Set(DashboardPane.allCases), "every case must appear exactly once")
    }

    func testDefaultDashboardPaneIsFirstInOrder() {
        XCTAssertEqual(defaultDashboardPane, dashboardPaneOrder.first)
        XCTAssertEqual(defaultDashboardPane, .sessions)
    }

    func testEveryPaneHasATitleAndSystemImage() {
        for pane in dashboardPaneOrder {
            XCTAssertFalse(dashboardPaneTitle(pane).isEmpty, "\(pane) needs a non-empty title")
            XCTAssertFalse(dashboardPaneSystemImage(pane).isEmpty, "\(pane) needs a non-empty SF Symbol name")
        }
    }

    // MARK: - centeredDashboardFrame (PURE)

    func testCenteredDashboardFrame() {
        let f = centeredDashboardFrame(visibleFrame: NSRect(x: 0, y: 0, width: 2000, height: 1200))
        XCTAssertEqual(f.size, dashboardDefaultSize)
        XCTAssertEqual(f.midX, 1000, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    /// A non-origin visible frame (secondary monitor / menu-bar inset) must still center correctly
    /// — proves the math uses midX/midY of the given rect, not a bare width/height halving from
    /// (0, 0). Mirrors `StandaloneWindowTests.testCenteredStandaloneFrameOffsetVisibleFrame`.
    func testCenteredDashboardFrameOffsetVisibleFrame() {
        let f = centeredDashboardFrame(visibleFrame: NSRect(x: 500, y: 100, width: 1600, height: 1000))
        XCTAssertEqual(f.size, dashboardDefaultSize)
        XCTAssertEqual(f.midX, 1300, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    // MARK: - sessionDisplayTitle (PURE, SessionsPane.swift)

    func testSessionDisplayTitleFallsBackToNewSessionForNilEmptyOrWhitespace() {
        XCTAssertEqual(sessionDisplayTitle(nil), "New session")
        XCTAssertEqual(sessionDisplayTitle(""), "New session")
        XCTAssertEqual(sessionDisplayTitle("   \n  "), "New session")
    }

    func testSessionDisplayTitleTrimsAndKeepsARealTitle() {
        XCTAssertEqual(sessionDisplayTitle("  Fix the parser  "), "Fix the parser")
        XCTAssertEqual(sessionDisplayTitle("Already trimmed"), "Already trimmed")
    }

    // MARK: - formatDaemonStatus (PURE, DaemonStatusPane.swift)

    func testFormatDaemonStatusWithFullProvider() {
        let d = formatDaemonStatus(version: "0.1.0", uptimeMs: 123_000, socketPath: "/tmp/norma.sock", providerId: "conn_1", providerModel: "gpt-5", sessionsCount: 3, pluginsCount: 0)
        XCTAssertEqual(d.version, "0.1.0")
        XCTAssertEqual(d.uptime, formatElapsed(123_000)) // "2m 3s" — reuses the shared task-display helper
        XCTAssertEqual(d.uptime, "2m 3s")
        XCTAssertEqual(d.socketPath, "/tmp/norma.sock")
        XCTAssertEqual(d.provider, "conn_1 (gpt-5)")
        XCTAssertEqual(d.sessionsCount, "3")
        XCTAssertEqual(d.pluginsCount, "0")
    }

    func testFormatDaemonStatusWithNoProvider() {
        let d = formatDaemonStatus(version: "0.1.0", uptimeMs: 3_840_000, socketPath: "/tmp/norma.sock", providerId: nil, providerModel: nil, sessionsCount: 0, pluginsCount: 0)
        XCTAssertEqual(d.provider, "none")
        XCTAssertEqual(d.uptime, "1h 4m")
    }

    /// A providerId present without a model (contract doesn't guarantee they're always paired) —
    /// falls back to the bare id rather than dropping the provider entirely.
    func testFormatDaemonStatusWithProviderIdOnly() {
        let d = formatDaemonStatus(version: "0.1.0", uptimeMs: 14_000, socketPath: "/tmp/norma.sock", providerId: "conn_1", providerModel: nil, sessionsCount: 1, pluginsCount: 0)
        XCTAssertEqual(d.provider, "conn_1")
        XCTAssertEqual(d.uptime, "14s")
    }

    // MARK: - formatQuotaState (PURE, QuotaPane.swift)

    func testFormatQuotaStateOK() {
        let q = formatQuotaState(kind: "ok", resumeAt: nil, inputTokens: 842, outputTokens: 10_600, nowMs: 1_000)
        XCTAssertEqual(q.statusLine, "OK")
        XCTAssertEqual(q.tokensLine, "↑ 842 ↓ 10.6k tokens") // reuses the shared formatTokens helper
    }

    func testFormatQuotaStateLimitedWithFutureResumeAt() {
        let q = formatQuotaState(kind: "limited", resumeAt: 125_000, inputTokens: 0, outputTokens: 0, nowMs: 2_000)
        XCTAssertEqual(q.statusLine, "Limited — resumes in \(formatElapsed(123_000))")
        XCTAssertEqual(q.statusLine, "Limited — resumes in 2m 3s")
    }

    /// `resumeAt` already in the past (clock skew, or the daemon hasn't flipped `kind` back yet) —
    /// falls back to the bare "Limited" rather than printing a nonsensical negative duration.
    func testFormatQuotaStateLimitedWithPastResumeAtFallsBackToBareLimited() {
        let q = formatQuotaState(kind: "limited", resumeAt: 1_000, inputTokens: 0, outputTokens: 0, nowMs: 2_000)
        XCTAssertEqual(q.statusLine, "Limited")
    }

    func testFormatQuotaStateLimitedWithNoResumeAt() {
        let q = formatQuotaState(kind: "limited", resumeAt: nil, inputTokens: 0, outputTokens: 0, nowMs: 2_000)
        XCTAssertEqual(q.statusLine, "Limited")
    }

    /// An unrecognized `kind` string fails safe toward "OK" rather than alarming the user over
    /// something the client doesn't understand.
    func testFormatQuotaStateUnrecognizedKindReadsAsOK() {
        let q = formatQuotaState(kind: "weird", resumeAt: nil, inputTokens: 0, outputTokens: 0, nowMs: 0)
        XCTAssertEqual(q.statusLine, "OK")
    }

    // MARK: - sortedTrustPaths (PURE, TrustPane.swift)

    func testSortedTrustPathsIsAlphabetical() {
        XCTAssertEqual(sortedTrustPaths(["/z", "/a", "/m"]), ["/a", "/m", "/z"])
    }

    func testSortedTrustPathsEmpty() {
        XCTAssertEqual(sortedTrustPaths([]), [])
    }

    // MARK: - holderDisplay / peripheralLeaseAgeText (PURE, PeripheralPane.swift)

    func testHolderDisplay() {
        XCTAssertEqual(holderDisplay(kind: "session", id: "s_1"), "session:s_1")
        XCTAssertEqual(holderDisplay(kind: "plugin", id: "p_7"), "plugin:p_7")
    }

    func testPeripheralLeaseAgeTextStillActive() {
        // 90s remaining → formatElapsed(90_000) == "1m 30s"
        XCTAssertEqual(peripheralLeaseAgeText(expiresAt: 100_000, nowMs: 10_000), "expires in 1m 30s")
    }

    func testPeripheralLeaseAgeTextExpired() {
        XCTAssertEqual(peripheralLeaseAgeText(expiresAt: 5_000, nowMs: 10_000), "expired")
    }

    /// The exact boundary (`nowMs == expiresAt`) reads as expired — matches core's own
    /// `expiredLeases`/`shouldServe`'s inclusive-expired convention (`nowMs < lease.expiresAt`).
    func testPeripheralLeaseAgeTextExactlyAtExpiryReadsExpired() {
        XCTAssertEqual(peripheralLeaseAgeText(expiresAt: 10_000, nowMs: 10_000), "expired")
    }

    // MARK: - DashboardWindowController construction (wiring smoke test)

    func testShowCreatesNativeChromeWindowAtFrame() {
        let client = NormaClientTestFactory.make()
        let directory = SessionDirectory(lister: { [] })
        let peripheral = PeripheralProvider(client: client)
        let helperClient = HelperClient()
        let frame = NSRect(x: 100, y: 80, width: 800, height: 560)
        let controller = DashboardWindowController(client: client, directory: directory, peripheral: peripheral, helperClient: helperClient, onOpenSessionDetached: { _ in }, frame: frame)
        defer { controller.close() }

        controller.show()

        guard let window = controller.windowForTesting else {
            XCTFail("DashboardWindowController must construct a real window")
            return
        }
        XCTAssertTrue(window.styleMask.contains(.titled))
        XCTAssertTrue(window.styleMask.contains(.miniaturizable))
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.styleMask.contains(.closable))
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(window.frame, frame)
        XCTAssertEqual(window.title, "Dashboard")
    }

    // MARK: - AppDelegate.openDashboard() singleton wiring

    /// Defensive-guard precedent (matches `openSessionInNewDetachedWindow`'s own guard): never
    /// booted → no `appModel`/`peripheralProvider` → log + no-op, no crash, no window.
    func testOpenDashboardNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.openDashboard()
        XCTAssertNil(delegate.dashboardWindow)
    }

    /// A second "Dashboard…" invocation must refocus the SAME controller, never construct another.
    func testOpenDashboardTwiceReusesTheSameController() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        guard let first = delegate.dashboardWindow else {
            XCTFail("openDashboard() must construct a controller when booted")
            return
        }
        delegate.openDashboard()
        XCTAssertTrue(delegate.dashboardWindow === first, "a second invocation must reuse the existing controller")
        delegate.dashboardWindow?.close()
    }

    /// The window's `onClosed` hook nils the registry ref out — a THIRD `openDashboard()` after a
    /// close constructs a fresh controller rather than reusing the (now-closed) old one.
    func testClosingDashboardWindowClearsTheSingletonRef() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.openDashboard()
        delegate.dashboardWindow?.close()
        XCTAssertNil(delegate.dashboardWindow, "windowWillClose must clear the singleton ref")
    }
}

/// A minimal `NormaClient` for tests that only need a real instance to satisfy a type signature
/// (constructing `DashboardWindowController` closes over `client.daemonStatus()`/etc. as lazy
/// async closures — none of them are ever awaited in these construction-only tests) — never
/// connects, mirroring `PeripheralProviderTests`' own posture of never touching the network.
enum NormaClientTestFactory {
    static func make() -> NormaClient {
        NormaClient(makeTransport: { NeverOpensTransport() }, token: "test-token", clientName: "dashboard-tests")
    }
}

private final class NeverOpensTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent> = AsyncStream { _ in }
    func open() async throws { throw NSError(domain: "NeverOpensTransport", code: 1) }
    func send(_ data: Data) async throws {}
    func close() {}
}
