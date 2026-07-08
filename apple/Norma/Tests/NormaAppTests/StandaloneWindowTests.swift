import XCTest
import AppKit
@testable import Norma

/// Task 2 (2e-iv): "Open Norma App" — the pure centering geometry (`centeredStandaloneFrame`) plus
/// a wiring-level smoke test for `AppDelegate.openStandaloneNormaWindow()`. The successful spawn
/// path itself (feed → controller → native window) is already covered end-to-end by
/// `DetachedWindowTests` — deliberately not duplicated here.
@MainActor
final class StandaloneWindowTests: XCTestCase {
    // MARK: - centeredStandaloneFrame (PURE)

    func testCenteredStandaloneFrame() {
        let f = centeredStandaloneFrame(visibleFrame: NSRect(x: 0, y: 0, width: 2000, height: 1200))
        XCTAssertEqual(f.size, chatWindowDefaultSize)
        XCTAssertEqual(f.midX, 1000, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    /// A non-origin visible frame (secondary monitor / menu-bar inset) must still center correctly
    /// — proves the math uses midX/midY of the given rect, not a bare width/height halving from
    /// (0, 0).
    func testCenteredStandaloneFrameOffsetVisibleFrame() {
        let f = centeredStandaloneFrame(visibleFrame: NSRect(x: 500, y: 100, width: 1600, height: 1000))
        XCTAssertEqual(f.size, chatWindowDefaultSize)
        XCTAssertEqual(f.midX, 1300, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    // MARK: - AppDelegate.openStandaloneNormaWindow() wiring

    /// Defensive-guard precedent (matches `openSessionInNewDetachedWindow`'s line-58 guard): never
    /// booted → no `appModel` → log + no-op, no crash, no window.
    func testOpenStandaloneNormaWindowNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.openStandaloneNormaWindow()
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
    }

    /// Booted but degraded (unit-test boot never starts the feed, so `client.transport` stays nil):
    /// `startFreshSessionAfterDetach()`'s `createSession` RPC throws immediately, the
    /// `focusedSessionId` guard catches it, and no window spawns — the whole chain (create → guard
    /// → would-be spawn) runs end-to-end without crashing or hanging.
    func testOpenStandaloneNormaWindowNoOpsWhenSessionCreateFails() async throws {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        XCTAssertNotNil(delegate.appModel, "boot() must produce an AppModel even in the degraded (no-token) test path")

        delegate.openStandaloneNormaWindow()
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(delegate.detachedWindows.isEmpty, "a failed session-create must never spawn a window")
    }
}
