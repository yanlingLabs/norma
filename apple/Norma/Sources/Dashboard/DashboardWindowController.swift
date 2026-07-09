import AppKit
import NormaKit
import SwiftUI

// MARK: - Task 5 (2f-ii): standalone-window spawn geometry, same pure pattern as
// `centeredStandaloneFrame` (`WindowSurfaceGeometry.swift`) — kept as its own tiny function here
// rather than parameterizing that one: the Dashboard's size is independent of the chat window's
// `chatWindowDefaultSize`, and this file's own boundary shouldn't grow FieldKit's shared geometry
// surface for a one-off constant only the Dashboard needs.

/// Spec §B: the Dashboard window's approved content size.
let dashboardDefaultSize = CGSize(width: 800, height: 560)

/// `dashboardDefaultSize` CENTERED in `visibleFrame`. PURE (no `NSScreen` dependency) so the
/// centering math is unit-tested directly, same posture as `centeredStandaloneFrame`.
func centeredDashboardFrame(visibleFrame: CGRect) -> CGRect {
    let size = dashboardDefaultSize
    return CGRect(
        x: visibleFrame.midX - size.width / 2,
        y: visibleFrame.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

/// Task 5 (2f-ii): the Dashboard — a native window with a left pane sidebar hosting five
/// self-contained panes (Sessions, Daemon status, Quota, Trust, Peripheral). Follows
/// `DetachedWindowController`'s construction style (titled+closable+miniaturizable+resizable+
/// fullSizeContentView, unified-toolbar posture for the inset-traffic-lights look) — but UNLIKE
/// that window, this one's content is plain opaque UI (sidebar + detail), not a glass chat shell:
/// no hidden title, no transparent titlebar, no clear background.
///
/// Singleton per `AppDelegate` (see `AppDelegate.openDashboard()`): this controller owns exactly
/// one window for the app's whole lifetime once opened; a second "Dashboard…" invocation just
/// refocuses the existing window rather than constructing another `DashboardWindowController`.
///
/// The mountable-pane contract (spec §B): every pane is a `View` taking only injected data/
/// closures — never a `NormaClient` directly (mirrors `SessionDirectory`'s own `lister` closure
/// convention) — see `DashboardWiring` (`DashboardView.swift`). This controller is the one place
/// that closes over the real `NormaClient` to build those closures, exactly like
/// `DetachedWindowController.init` builds its own `SessionDirectory.lister` closure around
/// `feed.client`.
@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private var didClose = false

    /// Registry-removal hook (`AppDelegate.openDashboard`'s wiring) — fires exactly once, same
    /// one-shot-latch posture as `DetachedWindowController.onClosed`.
    var onClosed: ((DashboardWindowController) -> Void)?

    /// Test-only read-through, same convention as `DetachedWindowController.windowForTesting`.
    var windowForTesting: NSWindow? { window }

    /// Phase 4d-iii Task 2: `initialPane` defaults to `defaultDashboardPane` so the pre-existing
    /// "Dashboard…" call site (`AppDelegate.openDashboard`) is unaffected; the new "Manage
    /// Plugins…" entry point passes `.pluginManager` instead — see `AppDelegate.openPluginManager`.
    /// Phase 4d-iii Task 4: `shortcutRegistry` defaults to `nil` — under unit tests
    /// (`testShowCreatesNativeChromeWindowAtFrame`, `DashboardTests.swift`) `AppDelegate` never
    /// constructs a real `ShortcutRegistry` (it's built only outside `!isRunningUnitTests`, same
    /// gate as `MultitouchTrigger`/`HotkeyTrigger`), so every existing call site that omits this
    /// param keeps compiling unchanged. `ShortcutBindingEditorModel.capture(...)` still persists a
    /// binding either way; only the live Carbon re-registration no-ops when this is `nil`.
    init(client: NormaClient, directory: SessionDirectory, peripheral: PeripheralProvider, helperClient: HelperClient, shortcutRegistry: ShortcutRegistry? = nil, onOpenSessionDetached: @escaping (String) -> Void, frame: NSRect, initialPane: DashboardPane = defaultDashboardPane) {
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Dashboard"
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime
        window.minSize = NSSize(width: 640, height: 420)
        // Same Safari-style unified-toolbar technique `DetachedWindowController` uses for inset
        // traffic lights (an empty toolbar + `.unified` style) — but titleVisibility stays default
        // (visible): the Dashboard is plain opaque chrome, not a glass shell hiding its title
        // under bled-up content.
        let toolbar = NSToolbar(identifier: "norma.dashboard.toolbar")
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        self.window = window

        super.init()

        window.delegate = self

        // Phase 4d-iii Task 2: constructed fresh here (not passed in like `peripheral`/
        // `helperClient`, which outlive any single dashboard window) — the plugin list has no
        // other owner across the app's lifetime, and `PluginManagerView.task` refreshes it on
        // every appearance anyway, so a fresh model per window-open is the simplest correct thing.
        let pluginManager = PluginManagerModel(client: client)
        // Phase 4d-iii Task 4: same "constructed fresh here, per window-open" posture as
        // `pluginManager` above — the tiles strip / shortcut editor have no other owner across the
        // app's lifetime either, and both re-seed themselves (`.task`) on every appearance.
        let tilesModel = TilesStripModel(client: client)
        let shortcutsModel = ShortcutBindingEditorModel(client: client, shortcutRegistry: shortcutRegistry)
        let wiring = DashboardWiring(
            directory: directory,
            onOpenSessionDetached: onOpenSessionDetached,
            daemonStatus: { try await client.daemonStatus() },
            quotaState: { try await client.quotaState() },
            trustList: { try await client.trustList() },
            trustRemove: { try await client.trustRemove(path: $0) },
            peripheral: peripheral,
            helperClient: helperClient,
            pluginManager: pluginManager,
            tilesModel: tilesModel,
            shortcutsModel: shortcutsModel
        )
        window.contentView = NSHostingView(rootView: DashboardView(wiring: wiring, initialPane: initialPane))
        window.setFrame(frame, display: true)
    }

    /// Orders the window front — called both for the initial open AND (idempotently) whenever the
    /// menu bar's "Dashboard…" item fires while the window already exists (`AppDelegate`'s
    /// singleton-focus behavior).
    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Programmatic close (`AppDelegate.applicationWillTerminate`) — goes through the SAME AppKit
    /// `windowWillClose` path the user's own red traffic light does, same posture as
    /// `DetachedWindowController.close()`. The Dashboard owns no socket/feed of its own (its
    /// `NormaClient` is the app's shared main client — `AppDelegate.openDashboard` never spawns a
    /// second harness), so there is nothing else here to tear down.
    func close() {
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        onClosed?(self)
    }
}
