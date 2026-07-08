import AppKit

@MainActor
final class MenuBarController {
    private let statusLine: () -> String
    private let toggleOrb: () -> Void
    private let summonField: () -> Void
    private let openCli: () -> Void
    private let openNormaApp: () -> Void
    private let panicAction: () -> Void
    private let quitApplication: () -> Void
    // Task 3 (2e-iv): internal (not private), same stored-`let` pattern as `stateItem` below, so
    // `MenuBarEntryPointsTests` (`@testable import Norma`) can walk `statusItem`'s built menu for
    // order and fire these items' actions via their `target`/`action` directly.
    var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
    private let orbItem = NSMenuItem(title: "Hide Orb", action: #selector(didToggleOrb), keyEquivalent: "o")
    private let summonFieldItem = NSMenuItem(title: "Summon Field", action: #selector(didSummonField), keyEquivalent: "")
    let openCliItem = NSMenuItem(title: "Open CLI", action: #selector(didOpenCli), keyEquivalent: "")
    let openNormaAppItem = NSMenuItem(title: "Open Norma App", action: #selector(didOpenNormaApp), keyEquivalent: "")
    // Task 4 (2f): the red "Stop Norma's Control" panic item — mounted/unmounted (not just
    // shown/hidden, unlike `orbItem`'s title-flip via `setOrbVisible`) with the active-lease count.
    // `internal`, same testability posture as `openCliItem`/`openNormaAppItem` above.
    let panicItem = NSMenuItem(title: "Stop Norma's Control", action: #selector(didPanic), keyEquivalent: "")
    private let preQuitSeparator = NSMenuItem.separator()
    private let quitItem = NSMenuItem(title: "Quit Norma", action: #selector(didQuit), keyEquivalent: "q")
    private var panicMounted = false

    init(
        statusLine: @escaping () -> String,
        toggleOrb: @escaping () -> Void,
        summonField: @escaping () -> Void,
        openCli: @escaping () -> Void,
        openNormaApp: @escaping () -> Void,
        panic: @escaping () -> Void,
        quit: @escaping () -> Void
    ) {
        self.statusLine = statusLine
        self.toggleOrb = toggleOrb
        self.summonField = summonField
        self.openCli = openCli
        self.openNormaApp = openNormaApp
        self.panicAction = panic
        self.quitApplication = quit
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
    @objc private func didPanic() { panicAction() }
    @objc private func didQuit() { quitApplication() }
}
