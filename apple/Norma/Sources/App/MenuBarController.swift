import AppKit

@MainActor
final class MenuBarController {
    private let statusLine: () -> String
    private let toggleOrb: () -> Void
    private let quitApplication: () -> Void
    private var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
    private let orbItem = NSMenuItem(title: "Hide Orb", action: #selector(didToggleOrb), keyEquivalent: "o")

    init(statusLine: @escaping () -> String, toggleOrb: @escaping () -> Void, quit: @escaping () -> Void) {
        self.statusLine = statusLine
        self.toggleOrb = toggleOrb
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
    @objc private func didQuit() { quitApplication() }
}
