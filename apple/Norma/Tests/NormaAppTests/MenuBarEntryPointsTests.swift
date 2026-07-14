import XCTest
import AppKit
@testable import Norma

/// Task 3 (2e-iv): the menu bar's two new entry points — "Open CLI" (`CliLauncher.openCli`, Task 1)
/// and "Open Norma App" (`AppDelegate.openStandaloneNormaWindow`, Task 2). No prior MenuBarController
/// test file existed (grepped Tests/ — only `ScaffoldTests.testBootInstallsMenuBar`, which just
/// asserts `menuBar` is non-nil after `boot()`), so this is a new file.
///
/// `statusItem` and the two new items (`openCliItem`/`openNormaAppItem`) are exposed as internal
/// (not `private`) stored properties on `MenuBarController` specifically so this file — via
/// `@testable import Norma` — can walk the real built `NSMenu` for order and fire the items'
/// `target`/`action` directly for the closure-firing assertions, exactly like a real menu click
/// would (`NSApplication.sendAction`), without needing to call the `@objc private` methods by name.
@MainActor
final class MenuBarEntryPointsTests: XCTestCase {
    private func makeController(
        openCli: @escaping () -> Void = {},
        openNormaApp: @escaping () -> Void = {},
        openDashboard: @escaping () -> Void = {},
        openPluginManager: @escaping () -> Void = {},
        loginItemController: LoginItemController? = nil,
        panic: @escaping () -> Void = {},
        quit: @escaping () -> Void = {},
        onReallyQuit: @escaping () -> Void = {}
    ) -> MenuBarController {
        MenuBarController(
            statusLine: { "idle" },
            toggleOrb: {},
            summonField: {},
            openCli: openCli,
            openNormaApp: openNormaApp,
            openDashboard: openDashboard,
            openPluginManager: openPluginManager,
            // A fresh, uniquely-named `UserDefaults` suite per call — never `UserDefaults.standard`,
            // so these menu-shape/closure-firing tests (which don't care about login-item
            // persistence) never leave a stray key behind in the real xctest-host defaults domain.
            loginItemController: loginItemController
                ?? LoginItemController(service: FakeLoginItemService(), defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!),
            panic: panic,
            quit: quit,
            onReallyQuit: onReallyQuit
        )
    }

    // MARK: - Menu shape / order

    func testMenuContainsOpenCliAndOpenNormaAppAfterSummonField() {
        let controller = makeController()
        controller.install()

        let items = controller.statusItem?.menu?.items ?? []
        let titles = items.map(\.title)

        XCTAssertTrue(titles.contains("Open CLI"))
        XCTAssertTrue(titles.contains("Open Norma App"))

        guard let summonIdx = titles.firstIndex(of: "Summon Field"),
              let cliIdx = titles.firstIndex(of: "Open CLI"),
              let appIdx = titles.firstIndex(of: "Open Norma App"),
              let quitIdx = titles.firstIndex(of: "Quit Norma") else {
            XCTFail("expected all four items present, got \(titles)")
            return
        }

        XCTAssertLessThan(summonIdx, cliIdx, "Open CLI must come after Summon Field")
        XCTAssertLessThan(cliIdx, appIdx, "Open Norma App must come right after Open CLI")
        XCTAssertLessThan(appIdx, quitIdx, "both new items must precede Quit Norma")

        // Exactly one separator between Summon Field and Open CLI (the new one this task inserts),
        // and Open CLI/Open Norma App are adjacent (no separator between them).
        XCTAssertEqual(cliIdx, summonIdx + 2, "expected exactly one separator between Summon Field and Open CLI")
        XCTAssertEqual(appIdx, cliIdx + 1, "Open CLI and Open Norma App must be adjacent, no separator between them")
        XCTAssertTrue(items[summonIdx + 1].isSeparatorItem)
    }

    // MARK: - Task 5 (2f-ii): "Dashboard…" — same section, mirrors Open CLI/Open Norma App exactly.

    func testMenuContainsDashboardRightAfterOpenNormaAppThenPluginManagerThenPreQuitSeparator() {
        let controller = makeController()
        controller.install()

        let items = controller.statusItem?.menu?.items ?? []
        let titles = items.map(\.title)

        guard let appIdx = titles.firstIndex(of: "Open Norma App"),
              let dashboardIdx = titles.firstIndex(of: "Dashboard…"),
              let pluginManagerIdx = titles.firstIndex(of: "Manage Plugins…"),
              let quitIdx = titles.firstIndex(of: "Quit Norma") else {
            XCTFail("expected Open Norma App, Dashboard…, Manage Plugins…, and Quit Norma present, got \(titles)")
            return
        }

        XCTAssertEqual(dashboardIdx, appIdx + 1, "Dashboard… must be adjacent to Open Norma App, no separator between them")
        // Phase 4d-iii Task 2: "Manage Plugins…" is adjacent to Dashboard…, same posture as
        // Dashboard… itself being adjacent to Open Norma App — no separator between them either.
        XCTAssertEqual(pluginManagerIdx, dashboardIdx + 1, "Manage Plugins… must be adjacent to Dashboard…, no separator between them")
        // Lifecycle T4: "Launch Norma at login" sits between Manage Plugins… and the pre-existing
        // pre-Quit separator — still no separator between Manage Plugins… and it.
        guard let loginItemIdx = titles.firstIndex(of: "Launch Norma at login") else {
            return XCTFail("expected Launch Norma at login present, got \(titles)")
        }
        XCTAssertEqual(loginItemIdx, pluginManagerIdx + 1, "Launch Norma at login must be adjacent to Manage Plugins…, no separator between them")
        XCTAssertEqual(quitIdx, loginItemIdx + 2)
        XCTAssertTrue(items[loginItemIdx + 1].isSeparatorItem)
    }

    func testDashboardItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openDashboard: { fired += 1 })
        controller.install()

        let item = controller.dashboardItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testPluginManagerItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openPluginManager: { fired += 1 })
        controller.install()

        let item = controller.pluginManagerItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    /// Firing "Manage Plugins…" must never fire "Dashboard…" (and vice versa) — same independence
    /// guarantee as `testOpenCliAndOpenNormaAppClosuresAreIndependent`.
    func testDashboardAndPluginManagerClosuresAreIndependent() {
        var dashboardFired = 0
        var pluginManagerFired = 0
        let controller = makeController(
            openDashboard: { dashboardFired += 1 },
            openPluginManager: { pluginManagerFired += 1 }
        )
        controller.install()

        let pluginManagerItem = controller.pluginManagerItem
        NSApp.sendAction(pluginManagerItem.action!, to: pluginManagerItem.target, from: pluginManagerItem)

        XCTAssertEqual(pluginManagerFired, 1)
        XCTAssertEqual(dashboardFired, 0)
    }

    func testInstallIsIdempotentForNewItems() {
        // Matches install()'s existing `guard statusItem == nil else { return }` idempotence —
        // a second install() call must not duplicate the new items either.
        let controller = makeController()
        controller.install()
        controller.install()
        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertEqual(titles.filter { $0 == "Open CLI" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Open Norma App" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Dashboard…" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Manage Plugins…" }.count, 1)
        XCTAssertEqual(titles.filter { $0 == "Launch Norma at login" }.count, 1)
    }

    // MARK: - Closure firing

    func testOpenCliItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openCli: { fired += 1 })
        controller.install()

        let item = controller.openCliItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    func testOpenNormaAppItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(openNormaApp: { fired += 1 })
        controller.install()

        let item = controller.openNormaAppItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    /// Firing one item must never fire the other.
    func testOpenCliAndOpenNormaAppClosuresAreIndependent() {
        var cliFired = 0
        var appFired = 0
        let controller = makeController(openCli: { cliFired += 1 }, openNormaApp: { appFired += 1 })
        controller.install()

        let cliItem = controller.openCliItem
        NSApp.sendAction(cliItem.action!, to: cliItem.target, from: cliItem)

        XCTAssertEqual(cliFired, 1)
        XCTAssertEqual(appFired, 0)
    }

    // MARK: - Task 4 (2f): panic item mount/unmount

    /// The red panic item must not exist in the menu at all until a lease is active — unlike
    /// `orbItem`'s title-flip, this is a true add/remove (spec §A4: "mounts/unmounts with
    /// active-lease count").
    func testPanicItemNotMountedByDefault() {
        let controller = makeController()
        controller.install()
        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertFalse(titles.contains("Stop Norma's Control"), "panic item must not be mounted with zero active leases")
    }

    func testSetPanicVisibleMountsRightBeforeQuitAndUnmountsAgain() {
        let controller = makeController()
        controller.install()

        controller.setPanicVisible(true)
        var items = controller.statusItem?.menu?.items ?? []
        var titles = items.map(\.title)
        guard let panicIdx = titles.firstIndex(of: "Stop Norma's Control"),
              let quitIdx = titles.firstIndex(of: "Quit Norma") else {
            return XCTFail("expected panic item mounted before Quit Norma, got \(titles)")
        }
        XCTAssertEqual(quitIdx, panicIdx + 2, "expected panic item then the pre-existing separator then Quit Norma")
        XCTAssertTrue(items[panicIdx + 1].isSeparatorItem)

        controller.setPanicVisible(false)
        items = controller.statusItem?.menu?.items ?? []
        titles = items.map(\.title)
        XCTAssertFalse(titles.contains("Stop Norma's Control"), "panic item must be fully removed once no leases are active")
    }

    func testSetPanicVisibleIsIdempotent() {
        let controller = makeController()
        controller.install()
        controller.setPanicVisible(true)
        controller.setPanicVisible(true)
        let titles = controller.statusItem?.menu?.items.map(\.title) ?? []
        XCTAssertEqual(titles.filter { $0 == "Stop Norma's Control" }.count, 1, "a repeated setPanicVisible(true) must not duplicate the item")
    }

    func testPanicItemFiresInjectedClosure() {
        var fired = 0
        let controller = makeController(panic: { fired += 1 })
        controller.install()
        controller.setPanicVisible(true)

        let item = controller.panicItem
        XCTAssertNotNil(item.target)
        XCTAssertNotNil(item.action)
        NSApp.sendAction(item.action!, to: item.target, from: item)

        XCTAssertEqual(fired, 1)
    }

    // MARK: - Lifecycle T4: reallyQuit arming order

    /// The ONE true-quit contract: `onReallyQuit()` must fire BEFORE `quitApplication()` — a real
    /// `NSApp.terminate` call synchronously re-enters `applicationShouldTerminate`, so if the order
    /// were reversed the flag would still read `false` there and the menu-bar Quit itself would be
    /// cancelled.
    func testQuitItemFiresOnReallyQuitBeforeQuitApplication() {
        var order: [String] = []
        let controller = makeController(
            quit: { order.append("quit") },
            onReallyQuit: { order.append("reallyQuit") }
        )
        controller.install()

        let item = controller.statusItem?.menu?.items.first { $0.title == "Quit Norma" }
        XCTAssertNotNil(item)
        NSApp.sendAction(item!.action!, to: item!.target, from: item!)

        XCTAssertEqual(order, ["reallyQuit", "quit"])
    }

    // MARK: - Lifecycle T4: "Launch Norma at login" checkbox

    func testLoginItemCheckboxReflectsControllerStateAfterInstall() {
        let fake = FakeLoginItemService()
        let controller = LoginItemController(service: fake, defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!)
        let menuBar = makeController(loginItemController: controller)

        menuBar.install()
        XCTAssertEqual(menuBar.loginItemItem.state, .off)

        controller.setEnabled(true)
        menuBar.refresh()
        XCTAssertEqual(menuBar.loginItemItem.state, .on)
    }

    func testLoginItemCheckboxTogglesTheControllerOnClick() {
        let fake = FakeLoginItemService()
        let controller = LoginItemController(service: fake, defaults: UserDefaults(suiteName: "MenuBarEntryPointsTests.\(UUID().uuidString)")!)
        let menuBar = makeController(loginItemController: controller)
        menuBar.install()

        let item = menuBar.loginItemItem
        NSApp.sendAction(item.action!, to: item.target, from: item)
        XCTAssertTrue(fake.isEnabled)
        XCTAssertEqual(item.state, .on)

        NSApp.sendAction(item.action!, to: item.target, from: item)
        XCTAssertFalse(fake.isEnabled)
        XCTAssertEqual(item.state, .off)
    }
}
