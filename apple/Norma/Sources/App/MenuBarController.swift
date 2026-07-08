import AppKit

@MainActor
final class MenuBarController {
    private let statusLine: () -> String
    private let toggleOrb: () -> Void
    private let summonField: () -> Void
    private let openCli: () -> Void
    private let openNormaApp: () -> Void
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

    init(
        statusLine: @escaping () -> String,
        toggleOrb: @escaping () -> Void,
        summonField: @escaping () -> Void,
        openCli: @escaping () -> Void,
        openNormaApp: @escaping () -> Void,
        quit: @escaping () -> Void
    ) {
        self.statusLine = statusLine
        self.toggleOrb = toggleOrb
        self.summonField = summonField
        self.openCli = openCli
        self.openNormaApp = openNormaApp
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
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit Norma", action: #selector(didQuit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
        refresh()
    }

    func refresh() {
        stateItem.title = statusLine()
    }

    func setOrbVisible(_ visible: Bool) {
        orbItem.title = visible ? "Hide Orb" : "Show Orb"
    }

    @objc private func didToggleOrb() { toggleOrb() }
    @objc private func didSummonField() { summonField() }
    @objc private func didOpenCli() { openCli() }
    @objc private func didOpenNormaApp() { openNormaApp() }
    @objc private func didQuit() { quitApplication() }
}
