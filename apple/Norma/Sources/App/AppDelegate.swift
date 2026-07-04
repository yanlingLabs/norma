import AppKit
import ApplicationServices
import NormaKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var menuBar: MenuBarController?
    private(set) var appModel: AppModel?
    private(set) var orbController: OrbWindowController?
    private var stickiness: StickinessEngine?
    private var startTask: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard !Self.isRunningUnitTests else { return }
        _ = boot()
    }

    /// Everything after activation policy. Split out so tests can drive it without
    /// a real app launch. Returns true when boot completed (even degraded: a missing
    /// daemon token must not prevent the orb from appearing).
    @discardableResult
    func boot() -> Bool {
        // AX permission: stickiness needs it; ask once, run degraded until granted.
        // Never prompt during unit tests (ScaffoldTests drives boot() directly); prompt once in real runs.
        let axTrusted = Self.isRunningUnitTests
            ? false
            : AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            )

        // A missing harness token means the daemon has never run — connecting would fail
        // hello forever. Boot the orb disconnected with an actionable menu line instead
        // of a hopeless retry loop; the user relaunches after `norma daemon run`.
        // Never touch the Keychain during unit tests either: the xctest host is not in the
        // token item's ACL, so SecItemCopyMatching blocks on a securityd consent dialog
        // (observed: testBootInstallsMenuBar hung 394s). Tests exercise the degraded path.
        let production = Self.isRunningUnitTests ? nil : (try? AppModel.production())
        let model = production ?? AppModel(
            makeTransport: { UnixSocketTransport(path: NormaPaths.socketPath()) },
            token: "missing-token"
        )
        let tokenMissing = production == nil
        appModel = model

        let orb = OrbWindowController(session: model.session)
        orbController = orb

        let sticky = StickinessEngine(onTarget: { [weak orb] target in
            orb?.follower.setMagneticTarget(target)
        })
        stickiness = sticky
        if axTrusted { sticky.start() }
        orb.follower.onCursorLocationChange = { [weak sticky] location in
            sticky?.updateCursorLocation(location)
        }

        let mb = MenuBarController(
            statusLine: { [weak model] in
                tokenMissing ? "no daemon token — run `norma daemon run`, then relaunch"
                             : (model?.connectionSummary ?? "starting…")
            },
            toggleOrb: { [weak self] in
                self?.orbController?.toggle()
                self?.menuBar?.setOrbVisible(self?.orbController?.isVisible ?? false)
            },
            quit: { NSApp.terminate(nil) }
        )
        mb.install()
        menuBar = mb

        orb.show()
        mb.setOrbVisible(true)

        if !tokenMissing {
            startTask = Task { [weak model, weak mb] in
                await model?.start()
                mb?.refresh()
            }
        }
        // Refresh the menu state line periodically (cheap; 2b has no binding plumbing to NSMenu).
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak mb] _ in
            Task { @MainActor in mb?.refresh() }
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        startTask?.cancel()
        appModel?.stop()
    }

    static var isRunningUnitTests: Bool {
        NSClassFromString("XCTestCase") != nil
    }
}
