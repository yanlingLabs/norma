import AppKit
import ApplicationServices
import Combine
import NormaKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var menuBar: MenuBarController?
    private(set) var appModel: AppModel?
    private(set) var orbController: OrbWindowController?
    /// Task 4 (2f): owns the peripheral capability provider, constructed against `appModel.client`
    /// — the app's MAIN feed client/socket (the daemon rule: THE provider = the most-recent-
    /// advertiser CONNECTION, so this must never be a second/detached-window client).
    private(set) var peripheralProvider: PeripheralProvider?
    /// Task 4 (4c): owns the `com.norma.helper` SMAppService lifecycle + XPC connection — read by
    /// both `hardwareBridge` (the approval gate) and the Dashboard's Peripheral pane (the
    /// helper-status row). Constructed unconditionally in `boot()` (its `status` read is safe
    /// anytime); only the real `register()` call is gated behind `!isRunningUnitTests` below.
    private(set) var helperClient: HelperClient?
    /// Task 4 (4c): answers `hardware_requested` pushes (battery charge-limit verbs) by routing
    /// through `helperClient`'s XPC calls — composed into the SAME `onPeripheralEvent` hook
    /// `peripheralProvider` uses, alongside it, never replacing it.
    private(set) var hardwareBridge: HardwareBridge?
    /// Task 5 (2f-ii): the Dashboard's singleton window controller — `nil` until first opened,
    /// nil'd again via `onClosed` (same one-shot-latch/registry-removal convention as
    /// `registerDetachedWindow`'s `onClosed`). `openDashboard()` below is what enforces the
    /// "second invocation focuses the existing window" contract off this single stored ref.
    private(set) var dashboardWindow: DashboardWindowController?
    /// Phase 4d-iii Task 1: the plugin-shortcut multi-hotkey registry — additive to
    /// `HotkeyTrigger.shared` (Hyper+Space summon) and `peripheralProvider`'s panic hotkey, never
    /// touching either. `nil` under unit tests (constructed only inside `boot()`'s
    /// `!isRunningUnitTests` gate below, same posture as `HotkeyTrigger.shared.start()`).
    /// `private(set)` so the Task 4 shortcut-editor UI can call `.reload(_:)` on it after the user
    /// edits a binding, without this file growing an editor-specific API.
    private(set) var shortcutRegistry: ShortcutRegistry?
    private var stickiness: StickinessEngine?
    private var startTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    /// Task 3 (2e-iv): owns the CLI launcher the menu bar's "Open CLI" item drives.
    private let cliLauncher = CliLauncher()

    /// Task 3 (2d-ii-b) registry: every currently-open detached window. Task 4's detach
    /// choreography appends via `registerDetachedWindow` on spawn; `onClosed` (wired there) removes
    /// it again on either a programmatic `close()` or the user's own red traffic light — the list
    /// never accumulates closed controllers.
    private(set) var detachedWindows: [DetachedWindowController] = []

    /// Test-only seam (DEFECT FIX regression, `StandaloneWindowTests`): `boot()`'s unit-test path
    /// always constructs a degraded (no-token) `AppModel` whose transport never opens — every RPC,
    /// including the very FIRST `createSession`, fails immediately. That makes it impossible to
    /// reach a state with a REAL prior focused session before a LATER createSession failure, which
    /// is exactly the scenario the defect fix targets. This wires in a scripted-transport
    /// `AppModel` (already focused on a real session) directly, bypassing `boot()` entirely — same
    /// "expose a narrow seam, don't fake the whole app" posture as `SessionModel.applyForTesting`/
    /// `OrbWindowController.setSurfaceForTesting`.
    func setAppModelForTesting(_ model: AppModel) {
        appModel = model
    }

    /// Registers a freshly spawned detached window and wires its one-shot `onClosed` to remove it
    /// from `detachedWindows` again. Called by `orb.onWindowDetach`'s closure below (Task 4's
    /// detach choreography — yellow on the morph window) and by `spawnDetachedWindow` (Task 5,
    /// 2e-iii — the sidebar's own "open in a new window" spawn).
    func registerDetachedWindow(_ controller: DetachedWindowController) {
        detachedWindows.append(controller)
        controller.onClosed = { [weak self] closed in
            self?.detachedWindows.removeAll { $0 === closed }
        }
        // Task 5 (2e-iii): the (Task-6-mounted) sidebar's ⌘-click "open in a new window" — spawns
        // ANOTHER detached window pinned to an explicit sessionId, via the SAME construction path
        // `onWindowDetach`'s yellow-light spawn below uses, just parameterized by an id instead of
        // the currently-focused session. Every detached window (including ones spawned this way)
        // gets this same hook wired, so its OWN sidebar can keep opening further windows too.
        controller.onOpenSessionDetached = { [weak self, weak controller] sessionId in
            guard let self, let model = self.appModel,
                  let (feed, session) = model.makeDetachedFeed(sessionId: sessionId) else {
                OrbDebug.log("onOpenSessionDetached: no appModel or makeDetachedFeed nil — spawn aborted")
                return
            }
            let sourceFrame = controller?.currentFrame ?? NSRect(origin: .zero, size: chatWindowDefaultSize)
            self.spawnDetachedWindow(feed: feed, session: session, frame: sourceFrame.offsetBy(dx: 24, dy: -24), title: "Norma")
        }
    }

    /// Task 5 (2e-iii): the shared spawn body BOTH detach paths use — construct, register, show.
    /// Callers own their OWN feed-creation guard above this (so each can log its own
    /// context-specific failure message) and hand the already-built feed/session in.
    /// Task 6 (2e-iii, CARRIED ITEM 3): the MORPH window's left sidebar ⌘-click "open in a new
    /// window" for an ARBITRARY session id — the mirror of `DetachedWindowController`'s
    /// `onOpenSessionDetached`, reusing the SAME `makeDetachedFeed` + `spawnDetachedWindow`
    /// machinery. The morph panel has no production frame accessor, so the new window spawns
    /// centered on the main screen (the user can move it); a `nil` model or missing daemon token
    /// aborts with a log, same posture as the yellow-light and detached-side spawns.
    /// Task 2 (2e-iv): `frame` override lets `openStandaloneNormaWindow()` below reuse this exact
    /// body instead of duplicating it. `nil` (every pre-existing caller) keeps the original
    /// behavior — centered on the main screen — now computed via the shared pure
    /// `centeredStandaloneFrame` instead of the inline midX/midY math this method used before.
    private func openSessionInNewDetachedWindow(_ sessionId: String, frame: NSRect? = nil) {
        guard let model = appModel,
              let (feed, session) = model.makeDetachedFeed(sessionId: sessionId) else {
            OrbDebug.log("openSessionInNewDetachedWindow: no appModel or makeDetachedFeed nil — spawn aborted")
            return
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let resolvedFrame = frame ?? centeredStandaloneFrame(visibleFrame: visible)
        spawnDetachedWindow(feed: feed, session: session, frame: resolvedFrame, title: "Norma")
    }

    /// Task 2 (2e-iv): the menu bar's "Open Norma App" entry (`NSMenuItem` wiring is Task 3) — a
    /// brand-new session via the SAME create+focus primitive the detach choreography and sidebar's
    /// "+ New session" already reuse (`AppModel.startFreshSession`). Its orb-focus side effect
    /// isn't separable from the create here, and is harmless: the orb's next summon simply lands on
    /// this same fresh session too. Then a detached window on that id, centered on the main screen
    /// via `centeredStandaloneFrame` — unlike the other two spawn paths (yellow-light detach,
    /// sidebar's ⌘-click), this one is never offset from an existing window/orb frame.
    ///
    /// Defensive, same posture as `openSessionInNewDetachedWindow`'s own guard (line 58 precedent):
    /// no `appModel`, `startFreshSession` returning `nil` (RPC failure), or `makeDetachedFeed` nil
    /// (missing token, checked inside `openSessionInNewDetachedWindow`) all resolve to
    /// `OrbDebug.log` + no-op, never a crash or a half-open window.
    ///
    /// DEFECT FIX (reviewed defect): this used to await the void `startFreshSessionAfterDetach()`
    /// and then read `model.focusedSessionId` — which, on a `createSession` RPC failure, silently
    /// stayed whatever it already was (a STALE PRIOR session, in the orb's normal running state),
    /// so the guard below wrongly passed and spawned the standalone window on that stale session
    /// instead of no-op-ing. Reading `startFreshSession()`'s RETURN VALUE instead — never
    /// `focusedSessionId` — closes that: `nil` on failure is unambiguous regardless of any prior
    /// focus, so a failed create can no longer be mistaken for a fresh one.
    func openStandaloneNormaWindow() {
        guard let model = appModel else {
            OrbDebug.log("openStandaloneNormaWindow: no appModel — spawn aborted")
            return
        }
        Task { @MainActor [weak self] in
            guard let self, let sid = await model.startFreshSession() else {
                OrbDebug.log("openStandaloneNormaWindow: startFreshSession produced no session (RPC failure) — spawn aborted")
                return
            }
            let visible = NSScreen.main?.visibleFrame ?? .zero
            self.openSessionInNewDetachedWindow(sid, frame: centeredStandaloneFrame(visibleFrame: visible))
        }
    }

    /// Task 5 (2f-ii): the menu bar's "Dashboard…" entry — singleton behavior per the brief: a
    /// second invocation while the window is already open just refocuses it (`show()` is
    /// idempotent — `makeKeyAndOrderFront` on an already-front window is a no-op), never
    /// constructing a second `DashboardWindowController`. Defensive, same posture as
    /// `openSessionInNewDetachedWindow`'s guard: no `appModel`/`peripheralProvider` (never booted)
    /// resolves to a log + no-op, never a crash or a half-wired window.
    /// Phase 4d-iii Task 2: `initialPane` lets `openPluginManager()` below reuse this exact body
    /// (same "shared spawn body" posture as `openSessionInNewDetachedWindow`'s own `frame`
    /// override) instead of duplicating the guard/construction. Only matters for a FRESH window —
    /// a second invocation while one is already open just refocuses it via `show()` (singleton
    /// behavior, unchanged), it does NOT re-select the pane on the already-open window.
    func openDashboard(initialPane: DashboardPane = defaultDashboardPane) {
        if let dashboardWindow {
            dashboardWindow.show()
            return
        }
        guard let model = appModel, let peripheral = peripheralProvider, let helper = helperClient else {
            OrbDebug.log("openDashboard: no appModel/peripheralProvider/helperClient — spawn aborted")
            return
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let controller = DashboardWindowController(
            client: model.client,
            directory: model.directory,
            peripheral: peripheral,
            helperClient: helper,
            shortcutRegistry: shortcutRegistry,
            onOpenSessionDetached: { [weak self] sid in self?.openSessionInNewDetachedWindow(sid) },
            frame: centeredDashboardFrame(visibleFrame: visible),
            initialPane: initialPane
        )
        controller.onClosed = { [weak self] _ in self?.dashboardWindow = nil }
        dashboardWindow = controller
        controller.show()
    }

    /// Phase 4d-iii Task 2: the menu bar's "Manage Plugins…" entry — opens the SAME singleton
    /// Dashboard window `openDashboard()` owns, landed on `.pluginManager` when a fresh window is
    /// spawned (mirrors that method's own doc comment on the refocus-vs-fresh-window distinction).
    func openPluginManager() {
        openDashboard(initialPane: .pluginManager)
    }

    @discardableResult
    private func spawnDetachedWindow(feed: SessionFeed, session: SessionModel, frame: NSRect, title: String) -> DetachedWindowController {
        let detached = DetachedWindowController(feed: feed, session: session, frame: frame, title: title.isEmpty ? "Norma" : title)
        registerDetachedWindow(detached)
        detached.show()
        return detached
    }

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
            token: AppModel.missingTokenSentinel
        )
        let tokenMissing = production == nil
        appModel = model
        OrbDebug.log("boot: axTrusted=\(axTrusted) tokenMissing=\(tokenMissing)")

        // Task 4 (2f): the peripheral provider — constructed against `model.client`, the app's
        // MAIN feed client/socket (NOT a detached window's own client — the daemon rule pins THE
        // provider to the most-recent-advertiser CONNECTION). Wired into AppModel's feed hooks
        // (`onPeripheralEvent`/`onClientConnected`) so lease/call events reach it regardless of
        // what session the orb happens to be focused on.
        let peripheral = PeripheralProvider(client: model.client)
        peripheralProvider = peripheral

        // Task 4 (4c): the hardware bridge — battery charge-limit verbs, routed through
        // `HelperClient`'s XPC connection to `NormaHelper`. Composed onto the SAME
        // `onPeripheralEvent` hook `peripheral` uses below (both are side-observers of the raw
        // event stream fired for every `.session` event — see `AppModel.init`'s `feed.onEvent`),
        // never restructuring that plumbing. `HelperClient()`'s own init only reads
        // `service.status` (safe anytime, no prompt/registration side effect); the real
        // `register()` call is gated below, same `!isRunningUnitTests` posture as
        // `peripheral.registerPanicSurfaces()`.
        let helper = HelperClient()
        helperClient = helper
        let hardware = HardwareBridge(client: model.client, helperClient: helper)
        hardwareBridge = hardware

        model.onPeripheralEvent = { [weak peripheral, weak hardware] event in
            await peripheral?.handle(event)
            await hardware?.handle(event)
        }
        model.onClientConnected = { [weak peripheral] in Task { await peripheral?.advertiseIfConnected() } }

        let orb = OrbWindowController(session: model.session)
        orbController = orb

        // Gate r7 (ARCHITECTURE PIVOT): the window is now a THIRD morph target of the orb panel
        // itself (`OrbWindowController.presentWindowSurface()`), not a separate `ChatWindowController`
        // panel — the whole `ChatWindow/*` layer is deleted. Expand-to-window is driven entirely
        // inside the controller (chevron → `requestExpandToWindow()`), so there is no cross-controller
        // `onExpandToWindow`/`onClose` wiring left to do.

        orb.onSubmit = { [weak self] text in
            guard let model = self?.appModel else { return false }
            let ok = await model.sendOrSteer(text)
            if ok { Haptics.messageSent() }
            return ok
        }
        orb.onEsc = { [weak self] in
            let running = self?.appModel?.session.state.turnRunning
            OrbDebug.log("AppDelegate.onEsc: fired appModel=\(self?.appModel != nil ? "present" : "nil") turnRunning=\(String(describing: running))")
            guard let self, self.appModel?.session.state.turnRunning == true else { return false }
            Task { await self.appModel?.interruptTurn() }
            return true
        }

        // Task 3 (2d-iii): the same seam as `onSubmit` above — the orb's own focused-session
        // respond RPCs, mirrored one-for-one onto `AppModel`'s three new methods.
        orb.onApprovalRespond = { [weak self] callId, approved in
            await self?.appModel?.respondApproval(callId: callId, approved: approved) ?? false
        }
        orb.onQuestionRespond = { [weak self] callId, answers in
            await self?.appModel?.respondQuestion(callId: callId, answers: answers) ?? false
        }
        orb.onPlanRespond = { [weak self] callId, approved, autoAccept, feedback in
            await self?.appModel?.respondPlan(callId: callId, approved: approved, autoAccept: autoAccept, feedback: feedback) ?? false
        }

        // Task 4 (2d-iii): the ⋯ menu's approval-mode picker — same seam as the three respond
        // closures above.
        orb.onSetPolicy = { [weak self] policy in
            await self?.appModel?.setSessionPolicy(policy) ?? false
        }

        // Task 4 (detach choreography): the yellow traffic light. `requestWindowDetach()` OWNS the
        // ordering — it fires this closure (spawning the detached window SYNCHRONOUSLY via
        // `show()`, before this closure returns) and only THEN runs its own no-animation exit
        // (`exitWindowModeForDetach()`), so there is never a frame with neither surface visible.
        // This closure therefore only spawns the window and kicks the fresh-session Task.
        //
        // I1 fix (review): returns whether a window actually spawned — `requestWindowDetach()`
        // gates its exit-to-orb on this. Two bail paths return `false` (no window, nothing to
        // exit into): no focused session yet (reachable via summon→expand→yellow before any
        // message has ever been sent), and `makeDetachedFeed` returning nil (missing daemon
        // token). Both leave the window surface exactly as it was — the user just keeps their
        // open window instead of losing it into the orb with nothing to show for it.
        orb.onWindowDetach = { [weak self] frame in
            guard let self, let model = self.appModel else {
                OrbDebug.log("onWindowDetach: no self/appModel — spawn aborted, window surface kept")
                return false
            }
            let sid = model.focusedSessionId // capture BEFORE the fresh session flips it
            guard let sid, let (feed, session) = model.makeDetachedFeed(sessionId: sid) else {
                OrbDebug.log("onWindowDetach: no focused session or makeDetachedFeed nil — spawn aborted, window surface kept")
                return false
            }
            let title = model.session.state.exchanges.first.map { String($0.prompt.prefix(40)) } ?? "Norma"
            // detached window VISIBLE first — the orb panel is still `.window` here
            self.spawnDetachedWindow(feed: feed, session: session, frame: frame, title: title)
            Task { await model.startFreshSessionAfterDetach() } // orb's next summon = clean slate
            return true
        }

        // Task 6 (2e-iii): the morph window's width-responsive sidebars. `onSelect` refocuses the
        // orb's own follow-focus feed in place (`focusSession`); `onNewSession` creates+focuses a
        // fresh session (the same create+focus primitive the detach path reuses); `onOpenDetached`
        // spawns a NEW detached window for an arbitrary session id (CARRIED ITEM 3 — no such path
        // existed before this task). `currentSessionId` reads `focusedSessionId` fresh each render.
        orb.sidebars = SidebarWiring(
            directory: model.directory,
            currentSessionId: { [weak model] in model?.focusedSessionId },
            onSelect: { [weak model] sid in Task { await model?.focusSession(sid) } },
            onOpenDetached: { [weak self] sid in self?.openSessionInNewDetachedWindow(sid) },
            onNewSession: { [weak model] in Task { await model?.startFreshSessionAfterDetach() } }
        )

        let sticky = StickinessEngine(onTarget: { [weak orb] target in
            orb?.follower.setMagneticTarget(target)
        })
        stickiness = sticky
        if axTrusted { sticky.start() }
        OrbDebug.log("boot: stickiness \(axTrusted ? "STARTED" : "NOT started (no AX)")")
        orb.follower.onCursorLocationChange = { [weak sticky] location in
            sticky?.updateCursorLocation(location)
        }

        // Trigger sources + Combine wiring: never armed under unit tests. MultitouchTrigger
        // dlopens a private framework the xctest host shouldn't touch, and these sinks have
        // nothing to observe in the degraded test boot path anyway.
        if !Self.isRunningUnitTests {
            MultitouchTrigger.shared.start()
            HotkeyTrigger.shared.start()

            // Phase 4d-iii Task 1: the plugin-shortcut hotkey registry. Additive — never touches
            // `HotkeyTrigger.shared`'s own registration above. Bindings are edited by the Task 4
            // shortcut-editor UI (not built yet); this just loads whatever's already persisted
            // (empty on a fresh install) and arms it. A fired hotkey pushes straight to the owning
            // plugin via NormaKit's `shortcut.invoke` RPC (`shortcutInvoke`) — fire-and-forget from
            // the app's perspective, same posture as the menu bar's other client-call sites; a
            // failure (plugin not connected, unknown plugin, RPC error) is logged, not surfaced,
            // since there's no UI surface here to show it on.
            let shortcuts = ShortcutRegistry()
            shortcuts.onFire = { [weak model] pluginId, shortcutId in
                guard let client = model?.client else { return }
                Task {
                    do {
                        let outcome = try await client.shortcutInvoke(pluginId: pluginId, shortcutId: shortcutId)
                        if outcome != .ok {
                            OrbDebug.log("shortcutRegistry.onFire: shortcutInvoke pluginId=\(pluginId) shortcutId=\(shortcutId) outcome=\(outcome)")
                        }
                    } catch {
                        OrbDebug.log("shortcutRegistry.onFire: shortcutInvoke failed pluginId=\(pluginId) shortcutId=\(shortcutId) error=\(error)")
                    }
                }
            }
            shortcuts.reload(ShortcutSettingsStore.load())
            shortcutRegistry = shortcuts

            // Task 4 (2f): the panic hotkey/screen-lock observer and the TCC-change poll are
            // real Carbon/DistributedNotificationCenter/Timer registrations — same
            // `!isRunningUnitTests` gate as the two triggers above, for the same reason (a real
            // global hotkey grab and a real distributed-notification observer have no place in a
            // unit-test process). `PeripheralProviderTests` exercises `handle`/`panic`/
            // `shouldServe` directly against a scripted client instead.
            peripheral.registerPanicSurfaces()
            peripheral.startTCCPolling()

            // Task 4 (4c): register the NormaHelper daemon with SMAppService at launch. A real
            // registration call (servicemanagementd round-trip) — same `!isRunningUnitTests` gate
            // as above; the `NormaAppTests` bundle loader IS the real `Norma.app`, so an
            // ungated call here would attempt to register an actual privileged daemon from the
            // test process. Live approval (System Settings > Login Items) is Task 6's gate —
            // `helper.status` degrades to `.requiresApproval` until the user acts, which
            // `hardwareBridge`/the dashboard row both already handle.
            helper.register()

            TriggerHub.shared.didTrigger
                .sink { [weak orb] in
                    Haptics.gestureRecognized()
                    guard let orb else { return }
                    // Gate r7: the window surface is the SAME panel now, so window-open == orb visible
                    // with `surface == .window`. A 4-finger tap while the window is open collapses it
                    // back to the orb (the SAME 140/22 spring the morph uses); otherwise toggle field.
                    switch summonToggleAction(surface: orb.surface, windowVisible: orb.isVisible) {
                    case .closeWindow: orb.collapseWindowToOrb()
                    case .toggleField: orb.toggleField()
                    }
                }
                .store(in: &cancellables)

            var lastPendingApprovalCount = model.session.state.pendingInteractions.count
            model.session.$state
                .sink { state in
                    let count = state.pendingInteractions.count
                    if count > lastPendingApprovalCount {
                        Haptics.approvalRequested()
                    }
                    lastPendingApprovalCount = count
                }
                .store(in: &cancellables)
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
            summonField: {
                TriggerHub.shared.fire(from: "menu")
            },
            openCli: { [weak self] in self?.cliLauncher.openCli() },
            openNormaApp: { [weak self] in self?.openStandaloneNormaWindow() },
            openDashboard: { [weak self] in self?.openDashboard() },
            openPluginManager: { [weak self] in self?.openPluginManager() },
            panic: { [weak peripheral] in peripheral?.panic() },
            quit: { NSApp.terminate(nil) }
        )
        mb.install()
        menuBar = mb

        // Task 4 (2f): the red panic item mounts/unmounts as `activeLeases` crosses zero. Safe to
        // wire unconditionally (not gated by `isRunningUnitTests`) — `activeLeases` only ever
        // changes via real lease events, which never arrive in the degraded/no-socket test boot
        // path, so this subscription simply never fires there.
        peripheral.$activeLeases
            .receive(on: DispatchQueue.main)
            .sink { [weak self] leases in
                self?.menuBar?.setPanicVisible(!leases.isEmpty)
            }
            .store(in: &cancellables)

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
        // Task 4 (2f): best-effort revoke-all BEFORE `appModel?.stop()` closes the socket below —
        // `terminate()`'s revoke RPC is fired on an unstructured Task, so ordering it first gives
        // it the best (still not guaranteed) chance to reach the daemon before the connection dies.
        peripheralProvider?.terminate()
        appModel?.stop()
        // Best-effort: each detached window's own feed/socket must not survive the app (spec §5
        // D9 — a closed window leaves nothing running; termination is a harder stop than that).
        detachedWindows.forEach { $0.close() }
        dashboardWindow?.close()
    }

    static var isRunningUnitTests: Bool {
        NSClassFromString("XCTestCase") != nil
    }
}
