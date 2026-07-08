import AppKit
import ApplicationServices
import Combine
import NormaKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var menuBar: MenuBarController?
    private(set) var appModel: AppModel?
    private(set) var orbController: OrbWindowController?
    private var stickiness: StickinessEngine?
    private var startTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    /// Task 3 (2d-ii-b) registry: every currently-open detached window. Task 4's detach
    /// choreography appends via `registerDetachedWindow` on spawn; `onClosed` (wired there) removes
    /// it again on either a programmatic `close()` or the user's own red traffic light — the list
    /// never accumulates closed controllers.
    private(set) var detachedWindows: [DetachedWindowController] = []

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
    /// "+ New session" already reuse (`startFreshSessionAfterDetach`). Its orb-focus side effect
    /// isn't separable from the create here, and is harmless: the orb's next summon simply lands on
    /// this same fresh session too. Then a detached window on that id, centered on the main screen
    /// via `centeredStandaloneFrame` — unlike the other two spawn paths (yellow-light detach,
    /// sidebar's ⌘-click), this one is never offset from an existing window/orb frame.
    ///
    /// Defensive, same posture as `openSessionInNewDetachedWindow`'s own guard (line 58 precedent):
    /// no `appModel`, `startFreshSessionAfterDetach` producing no focused session (RPC failure), or
    /// `makeDetachedFeed` nil (missing token, checked inside `openSessionInNewDetachedWindow`) all
    /// resolve to `OrbDebug.log` + no-op, never a crash or a half-open window.
    func openStandaloneNormaWindow() {
        guard let model = appModel else {
            OrbDebug.log("openStandaloneNormaWindow: no appModel — spawn aborted")
            return
        }
        Task { @MainActor [weak self] in
            await model.startFreshSessionAfterDetach()
            guard let self, let sid = model.focusedSessionId else {
                OrbDebug.log("openStandaloneNormaWindow: startFreshSessionAfterDetach produced no focused session — spawn aborted")
                return
            }
            let visible = NSScreen.main?.visibleFrame ?? .zero
            self.openSessionInNewDetachedWindow(sid, frame: centeredStandaloneFrame(visibleFrame: visible))
        }
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
        // Best-effort: each detached window's own feed/socket must not survive the app (spec §5
        // D9 — a closed window leaves nothing running; termination is a harder stop than that).
        detachedWindows.forEach { $0.close() }
    }

    static var isRunningUnitTests: Bool {
        NSClassFromString("XCTestCase") != nil
    }
}
