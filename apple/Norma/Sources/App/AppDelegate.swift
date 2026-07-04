import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var menuBar: MenuBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard !Self.isRunningUnitTests else { return }
        _ = boot()
    }

    /// Everything after activation policy. Split out so tests can drive it without
    /// a real app launch. Returns true when boot completed.
    @discardableResult
    func boot() -> Bool {
        let mb = MenuBarController(
            statusLine: { "starting…" },
            toggleOrb: { },
            quit: { NSApp.terminate(nil) }
        )
        mb.install()
        menuBar = mb
        return true
    }

    static var isRunningUnitTests: Bool {
        NSClassFromString("XCTestCase") != nil
    }
}
