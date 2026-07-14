import AppKit

@MainActor
final class MenuBarController {
    private let statusLine: () -> String
    private let toggleOrb: () -> Void
    private let summonField: () -> Void
    private let openCli: () -> Void
    private let openNormaApp: () -> Void
    private let openDashboard: () -> Void
    private let openPluginManager: () -> Void
    private let panicAction: () -> Void
    private let quitApplication: () -> Void
    // Lifecycle T4: arms the ONE true-quit gate (`AppDelegate.reallyQuitting`) — fired BEFORE
    // `quitApplication()` in `didQuit()` below. An injected closure (not a direct `AppDelegate`
    // reference) so this controller stays decoupled from the app delegate, same posture as every
    // other closure in this initializer.
    private let onReallyQuit: () -> Void
    private let loginItemController: LoginItemController
    // Task 3 (2e-iv): internal (not private), same stored-`let` pattern as `stateItem` below, so
    // `MenuBarEntryPointsTests` (`@testable import Norma`) can walk `statusItem`'s built menu for
    // order and fire these items' actions via their `target`/`action` directly.
    var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
    private let orbItem = NSMenuItem(title: "Hide Orb", action: #selector(didToggleOrb), keyEquivalent: "o")
    private let summonFieldItem = NSMenuItem(title: "Summon Field", action: #selector(didSummonField), keyEquivalent: "")
    let openCliItem = NSMenuItem(title: "Open CLI", action: #selector(didOpenCli), keyEquivalent: "")
    let openNormaAppItem = NSMenuItem(title: "Open Norma App", action: #selector(didOpenNormaApp), keyEquivalent: "")
    // Task 5 (2f-ii): the Dashboard entry — same section/adjacency convention as `openCliItem`/
    // `openNormaAppItem` (2e-iv), mirrored exactly.
    let dashboardItem = NSMenuItem(title: "Dashboard…", action: #selector(didOpenDashboard), keyEquivalent: "")
    // Phase 4d-iii Task 2: "Manage Plugins…" — same 4-touch-point precedent as `dashboardItem`,
    // placed right after it (opens the Dashboard window focused on `.pluginManager`).
    let pluginManagerItem = NSMenuItem(title: "Manage Plugins…", action: #selector(didOpenPluginManager), keyEquivalent: "")
    // Task 4 (2f): the red "Stop Norma's Control" panic item — mounted/unmounted (not just
    // shown/hidden, unlike `orbItem`'s title-flip via `setOrbVisible`) with the active-lease count.
    // `internal`, same testability posture as `openCliItem`/`openNormaAppItem` above.
    let panicItem = NSMenuItem(title: "Stop Norma's Control", action: #selector(didPanic), keyEquivalent: "")
    private let preQuitSeparator = NSMenuItem.separator()
    private let quitItem = NSMenuItem(title: "Quit Norma", action: #selector(didQuit), keyEquivalent: "q")
    // Lifecycle T4: the "Launch Norma at login" checkbox, bound to `loginItemController`. `internal`
    // (not `private`), same testability posture as `openCliItem`/`panicItem` above.
    let loginItemItem = NSMenuItem(title: "Launch Norma at login", action: #selector(didToggleLoginItem), keyEquivalent: "")
    private var panicMounted = false

    init(
        statusLine: @escaping () -> String,
        toggleOrb: @escaping () -> Void,
        summonField: @escaping () -> Void,
        openCli: @escaping () -> Void,
        openNormaApp: @escaping () -> Void,
        openDashboard: @escaping () -> Void,
        openPluginManager: @escaping () -> Void,
        loginItemController: LoginItemController,
        panic: @escaping () -> Void,
        quit: @escaping () -> Void,
        onReallyQuit: @escaping () -> Void
    ) {
        self.statusLine = statusLine
        self.toggleOrb = toggleOrb
        self.summonField = summonField
        self.openCli = openCli
        self.openNormaApp = openNormaApp
        self.openDashboard = openDashboard
        self.openPluginManager = openPluginManager
        self.loginItemController = loginItemController
        self.panicAction = panic
        self.quitApplication = quit
        self.onReallyQuit = onReallyQuit
    }

    func install() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "circle.circle", accessibilityDescription: "Norma")

        let menu = NSMenu()
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        orbItem.target = self
        menu.addItem(orbItem)
        summonFieldItem.target = self
        menu.addItem(summonFieldItem)
        menu.addItem(.separator())
        openCliItem.target = self
        menu.addItem(openCliItem)
        openNormaAppItem.target = self
        menu.addItem(openNormaAppItem)
        dashboardItem.target = self
        menu.addItem(dashboardItem)
        pluginManagerItem.target = self
        menu.addItem(pluginManagerItem)
        loginItemItem.target = self
        menu.addItem(loginItemItem)
        menu.addItem(preQuitSeparator)
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
        panicItem.target = self
        panicItem.attributedTitle = NSAttributedString(
            string: panicItem.title, attributes: [.foregroundColor: NSColor.systemRed]
        )
        refresh()
    }

    func refresh() {
        stateItem.title = statusLine()
        // Lifecycle T4: the checkbox tracks `SMAppService.mainApp`'s live status (e.g. the user
        // can flip it from System Settings > Login Items directly, outside this menu entirely),
        // so it's re-synced on the SAME periodic cadence as the state line above rather than only
        // right after a click.
        loginItemItem.state = loginItemController.isEnabled ? .on : .off
    }

    func setOrbVisible(_ visible: Bool) {
        orbItem.title = visible ? "Hide Orb" : "Show Orb"
    }

    /// Task 4 (2f): mounts (inserts, right above the pre-Quit separator) or unmounts (removes) the
    /// red panic item as the active-lease count crosses zero — a true add/remove, unlike
    /// `setOrbVisible`'s title-flip, since the item must not exist at all while nothing is leased.
    /// Idempotent (`panicMounted` guard) and safe to call before `install()` (no-op — nothing to
    /// mount into yet; `install()` doesn't re-derive panic visibility, so a caller that flips this
    /// before `install()` and expects it mounted would need to call `setPanicVisible` again after —
    /// not a scenario any current caller hits, since `activeLeases` starts empty at boot).
    func setPanicVisible(_ visible: Bool) {
        guard visible != panicMounted else { return }
        guard let menu = statusItem?.menu else { panicMounted = visible; return }
        if visible {
            let idx = menu.index(of: preQuitSeparator)
            if idx >= 0 { menu.insertItem(panicItem, at: idx) }
        } else {
            menu.removeItem(panicItem)
        }
        panicMounted = visible
    }

    @objc private func didToggleOrb() { toggleOrb() }
    @objc private func didSummonField() { summonField() }
    @objc private func didOpenCli() { openCli() }
    @objc private func didOpenNormaApp() { openNormaApp() }
    @objc private func didOpenDashboard() { openDashboard() }
    @objc private func didOpenPluginManager() { openPluginManager() }
    @objc private func didPanic() { panicAction() }

    // Lifecycle T4: `reallyQuitting` MUST be armed before `quitApplication()` runs — reversed
    // order would let `NSApp.terminate`'s synchronous `applicationShouldTerminate` round-trip read
    // the still-false flag and cancel the menu-bar Quit itself (the ONE true-quit source, per
    // `AppDelegate.reallyQuitting`'s doc comment).
    @objc private func didQuit() {
        onReallyQuit()
        quitApplication()
    }

    @objc private func didToggleLoginItem() {
        loginItemController.setEnabled(!loginItemController.isEnabled)
        loginItemItem.state = loginItemController.isEnabled ? .on : .off
    }
}
