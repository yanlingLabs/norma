import AppKit
import SwiftUI

/// v1 PointerOverlayWindow's key/main refusal pattern (GlassFieldWindow.swift GlassFieldPanel,
/// verbatim): a borderless NSPanel defaults BOTH to true, and AppKit auto-promotes orderable
/// key-capable windows on close/deactivate/Space changes. Collapsed (orb) keeps 2b's refusal;
/// expanded (field) types.
private final class KeyableNonActivatingPanel: NSPanel {
    var acceptsKeyInput = false
    override var canBecomeKey: Bool { acceptsKeyInput }
    override var canBecomeMain: Bool { acceptsKeyInput }
}

/// Owns the orb/field panel. Task B (v1 field transplant, window choreography): the panel is no
/// longer a single fixed size — mirroring v1's real `GlassFieldWindowController` (`show()`/
/// `showCollapsedOrb()`/`hide()`), it is `morphModel.collapsedWindowSize` (240×140) while
/// collapsed and `morphModel.windowSize` (480×440) while expanded, resized at exactly two
/// instants: `expandToField()` resizes UP (with v1's origin math) BEFORE starting the morph
/// (mirrors v1 `show()`'s order — the frame never changes DURING the morph, only content
/// geometry does); `finishCollapse()` resizes DOWN only once the collapse morph has fully
/// SETTLED (mirrors v1 `hide()`'s `settleCollapsedOrb()`). Both resizes keep the SAME physical
/// glass-anchor screen point (`currentGlassAnchor()`) — the panel expands/collapses IN PLACE,
/// never jumping. ARCHITECTURE NOTE (v1's converged lesson) still holds: this panel IS the field
/// window's collapsed state — expansion happens in place so the glassEffectID morph stays inside
/// one GlassEffectContainer (now owned by `NormaFieldView` itself). Do not add a second window
/// for the field.
///
/// EDGE FENCE (user directive, replaces v1's per-corner switching): `morphModel.corner` stays
/// `.topLeft` FOREVER — `OrbFollower`'s tracking spring fences its target anchor instead
/// (`fenceAnchorForTopLeftCorner`) so the expanded frame always fits on-screen from wherever the
/// anchor ends up, even while collapsed. `follower.isExpanded` mirrors `surface` exactly (see
/// `OrbFollower`'s own doc) so its continuous per-frame `setFrameOrigin` always targets whichever
/// size the panel is ACTUALLY sized to right now.
@MainActor
final class OrbWindowController: ObservableObject {
    enum Surface { case orb, field, window }

    let follower: OrbFollower
    let morphModel: MorphModel
    /// Task-3 fix wave: the fluid orb's own dedicated model (split off `MorphModel` — see
    /// `FluidModel`'s doc, `FieldKit/FluidOrbView.swift`), created alongside `morphModel` and
    /// passed down the same path (`GlassRootView` → `NormaFieldView` → `FluidOrbSlot`).
    /// `OrbFollower` also holds this reference to write its per-tick acceleration tap directly
    /// onto it instead of onto `morphModel`.
    let fluidModel = FluidModel()
    private let panel: KeyableNonActivatingPanel
    private(set) var isVisible = false
    /// Derived, not driven directly by callers: `.field` the instant an expand STARTS,
    /// `.orb` only once a collapse COMPLETES (the morph spring settles at 0). Kept as
    /// `@Published` purely for input/draft logic (GlassRootView's `onChange` + the Esc
    /// monitor's key-routing) — rendering reads `morphModel.progress`, not this.
    @Published private(set) var surface: Surface = .orb

    /// Test-only convenience — `morphModel.progress` is already reachable via `@testable
    /// import`, but tests read through this name so they don't reach past the controller's
    /// public surface into its collaborator's internals.
    var morphProgressForTesting: Double { morphModel.progress }

    /// Test-only counter (gate fix — Esc-interrupt live-gate finding): `MorphTimerReentrancyTests`
    /// asserts this stays at 1 after a stale/duplicate `morphTick()` fires post-settle — see
    /// `morphTick()`'s re-entry guard doc for the bug this locks in against.
    private(set) var finishCollapseCallCountForTesting = 0

    /// Test-only counter (Finding-2, gate 2): every synchronous `makePanelKeyWinningLateActivation`
    /// pass increments this — a re-summon must re-assert key focus, so a test drives
    /// expand→collapse→re-expand and asserts this went UP on the second expand (see that method's
    /// doc for the key-window race it defends against).
    private(set) var keyAssertionCountForTesting = 0

    /// Test-only read-through — lets a test observe whether the panel actually became the key
    /// window after a summon (the Finding-2 smoking gun). Key status depends on a live WindowServer
    /// session, so tests that assert on it must tolerate a headless host where it stays false.
    var panelIsKeyForTesting: Bool { panel.isKeyWindow }

    /// Test-only seam: `surface` is `private(set)` because production callers only ever move it
    /// via `expandToField()`/`collapseToOrb()`/`enterWindowMode()`/`exitWindowMode()`'s own
    /// guarded transitions — but `SurfaceWindowTests` needs to plant `.window` directly to test
    /// `exitWindowMode()` in isolation, without first driving a real field→window handoff.
    func setSurfaceForTesting(_ s: Surface) { surface = s }

    /// Wired in Task 6: the controller exposes callbacks, it does NOT import AppModel.
    /// Returns send success — GlassRootView's submit() gates the draft clear on this so a
    /// failed/disconnected send never loses the composed text (spec §6).
    var onSubmit: ((String) async -> Bool)?
    var onInterrupt: (() -> Void)?
    /// Returns true when the key was consumed as an interrupt (turn running); false → collapse.
    var onEsc: (() -> Bool)?

    /// Wave-5 gate item 4: the composer-hop seam — `handleAcceptedSwipe` below needs to know
    /// whether the shell is CURRENTLY showing the composer (`FieldStateAdapter.showingDraft`) to
    /// decide the swipe against the field's full position space (history ⟷ response ⟷ composer,
    /// see `navigateFieldSwipe`), but that flag lives on the adapter `GlassRootView` owns, not
    /// here (the controller doesn't import FieldKit's adapter type). Wired idempotently by
    /// `GlassRootView.wireCallbacks()`, same pattern/lifecycle as `FieldStateAdapter`'s own
    /// `onSubmit`/`onClearMessage`/`onCollapse` closures.
    var isShowingDraft: (() -> Bool)?
    /// Wired by `GlassRootView.wireCallbacks()` to `adapter.showingDraft = `. The other half of
    /// the composer-hop seam above.
    var setShowingDraft: ((Bool) -> Void)?

    /// Wave 2c task 4: which historical exchange (index into `session.state.exchanges`) the
    /// field's shell is pinned to via an accepted 2-finger swipe — `nil` = live/draft view
    /// (`ExchangeNavigation.swift`'s convention). `private(set)`: only `handleAcceptedSwipe`
    /// below (from the scroll monitor) and `finishCollapse()` move it from inside this class;
    /// `resetExchangeIndex()` is the one external hook (`GlassRootView.submit()` calls it on a
    /// successful send — the same place the draft-clear-on-success logic already lives).
    /// `GlassRootView` additionally resets it the instant a new turn actually STARTS, mirroring
    /// the draft-cache reset rule, via `.onChange(of: session.state.turnRunning)`.
    @Published private(set) var exchangeIndex: Int?

    func resetExchangeIndex() {
        exchangeIndex = nil
    }

    // MARK: - Thinking-minimize choreography (wave-3 gate item 2)

    /// One-shot latch: `GlassRootView.submit()` arms this on a send that succeeds WHILE THE
    /// SESSION WAS IDLE (a genuine new-turn submit, not a mid-turn steer) — distinguishing "this
    /// turn-start followed the field's OWN submit" (item 2a: auto-collapse) from "a turn started
    /// for some other reason while the field happens to be open" (e.g. the user summoned the
    /// field DURING an already-running turn to watch/steer — that path never arms this, and a
    /// steer submit doesn't either, since `wasIdle` is false). `consumeCollapseOnTurnStart()` is
    /// the only reader — it always clears the flag so a stale arm from an earlier submit can
    /// never fire on a LATER, unrelated turn-start.
    var collapseOnTurnStart = false

    /// Consumes (and always clears) `collapseOnTurnStart` — one-shot by construction: a second
    /// turn-start without a fresh submit in between returns `false`.
    @discardableResult
    func consumeCollapseOnTurnStart() -> Bool {
        defer { collapseOnTurnStart = false }
        return collapseOnTurnStart
    }

    /// One-shot latch: `GlassRootView`'s turn-completion handler arms this immediately before
    /// calling `expandToField()` to reveal a finished answer (item 2b) — without it, the
    /// existing summon-home-state rule (`summonShowsComposer`, v1 semantics: every summon opens
    /// the COMPOSER unless a turn is actively streaming) would flip `showingDraft` back to
    /// `true` on this very expand, since by definition the turn has already finished
    /// (`turnRunning == false`) — hiding the very answer this auto-expand exists to reveal.
    var expandForAnswerReveal = false

    /// Consumes (and always clears) `expandForAnswerReveal` — one-shot, same shape as
    /// `consumeCollapseOnTurnStart()` above.
    @discardableResult
    func consumeExpandForAnswerReveal() -> Bool {
        defer { expandForAnswerReveal = false }
        return expandForAnswerReveal
    }

    /// Task 2d-i.2: the ONE FieldStateAdapter both surfaces (field + chat window) observe.
    /// Owned here — not by GlassRootView — so the chat window shares drafts, replies, and
    /// focus state with the field for free.
    let fieldAdapter: FieldStateAdapter

    private let session: SessionModel
    private let swipeRecognizer = TrackpadHorizontalSwipeRecognizer()
    private var keyMonitor: Any?
    private var scrollMonitor: Any?
    private var externalFocus: ExternalFocusSnapshot?

    // MARK: Morph spring (60Hz Timer — v1 GlassFieldWindow.swift:1795-1845)

    private var morphTimer: Timer?
    private var lastMorphTick = CACurrentMediaTime()
    private var morphVelocity: Double = 0
    private var morphTarget: Double = 0

    init(session: SessionModel) {
        self.session = session
        self.fieldAdapter = FieldStateAdapter(session: session)
        let morph = MorphModel()
        self.morphModel = morph
        self.follower = OrbFollower(morphModel: morph, fluidModel: fluidModel)

        // v1 PointerOverlayWindow configuration, verbatim, except the panel now starts sized to
        // the COLLAPSED geometry (task B: the panel resizes between `collapsedWindowSize` and
        // `windowSize` as the field expands/collapses — see the type doc above).
        panel = KeyableNonActivatingPanel(
            contentRect: NSRect(origin: .zero, size: morph.collapsedWindowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.ignoresMouseEvents = true
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false

        follower.onWindowOriginChange = { [weak self] origin in
            guard let self, isVisible else { return }
            panel.setFrameOrigin(origin)
        }
        // Guarded by collapseToOrb() itself (no-op unless surface == .field) — see OrbFollower's
        // doc on why this fires unconditionally on every fast-flick sample.
        follower.onFastFlick = { [weak self] in
            self?.collapseToOrb()
        }

        // ARCHITECTURE NOTE above: GlassRootView (not OrbView) is the panel's content — it hosts
        // `NormaFieldView` (FieldKit), which owns its own `GlassEffectContainer` and renders the
        // whole orb↔field morph off `morphModel.progress`.
        panel.contentView = NSHostingView(
            rootView: GlassRootView(
                session: session, controller: self, morphModel: morph,
                fluidModel: fluidModel, adapter: fieldAdapter
            )
        )
    }

    func show() {
        guard !isVisible else { return }
        isVisible = true
        panel.orderFrontRegardless()
        follower.start()
    }

    func hide() {
        guard isVisible else { return }
        if surface == .field {
            // Nobody will see the last bit of the collapse morph once the panel is ordered
            // out — snap it to settled rather than leaving an orphaned Timer + monitor + key
            // panel running behind a hidden window.
            cancelMorphTimer()
            morphModel.progress = 0
            morphVelocity = 0
            finishCollapse()
        }
        isVisible = false
        follower.stop()
        panel.orderOut(nil)
    }

    func toggle() { isVisible ? hide() : show() }

    /// Expands the collapsed orb into the field IN PLACE: captures external focus, makes the
    /// panel keyable and key, flips `surface` to `.field` immediately (so a fast Esc/flick can
    /// reverse the morph before it settles), and starts the morph spring toward 1.
    ///
    /// Task B: mirrors v1 `show()`'s exact order (GlassFieldWindow.swift:695-773) — the panel is
    /// resized UP to `morphModel.windowSize` at the current glass-anchor point BEFORE the morph
    /// starts (the frame itself never changes DURING the morph, only the content geometry does);
    /// only afterward does `morphTarget` flip to 1. `follower.isExpanded = true` right after the
    /// resize keeps the tracking spring's per-frame target consistent with the panel's new real
    /// size, and `follower.snapWindowOrigin(to:)` avoids a one-frame "catch up" jump from the
    /// spring's stale pre-resize position.
    func expandToField() {
        // RETARGET (v1 parity — GlassFieldWindow.swift:765-772's `midHide` re-show): a
        // re-summon arrived while a collapse morph is still in flight. `surface` is still
        // `.field` here — it only flips to `.orb` inside `finishCollapse()`, which itself
        // only runs once the morph SETTLES with `morphTarget == 0` (see `morphTick()`).
        // Teardown therefore never ran: the panel is still keyable, still key, still sized
        // to `morphModel.windowSize`, and the focus snapshot and key monitor are still live.
        // So there is nothing to re-acquire (no resize either — the panel is already the
        // right size) — just reverse the spring's target back toward 1 from wherever
        // `progress` currently sits (no snap, no discontinuity) and bail out before any of
        // the "cold start" setup below re-runs. Flipping `morphTarget` here doubles as
        // clearing the pending collapse completion: `finishCollapse()` is gated on
        // `morphTarget == 0` read FRESH at settle time (there's no captured completion
        // closure to go stale), so once the target is 1 the stale collapse-teardown can
        // never fire — it settles at 1 instead of 0.
        if surface == .field && morphTarget == 0 {
            startMorph(target: 1)
            // Finding-2 (belt): teardown never ran on this path, so the panel is still keyable and
            // still key and NO `restore()` fired this cycle — so unlike the cold path below there's
            // no live race to beat here. Re-assert only DEFERRED (next runloop tick), purely to
            // catch an EARLIER collapse cycle's `restore()` activation that might still be in
            // flight. Deliberately NOT synchronous: this retarget sequence feeds a timing-sensitive
            // 60Hz morph spring (see `MorphTimerReentrancyTests`), and a synchronous
            // `orderFrontRegardless()`/`makeKey()` inline here perturbs that spring's settle timing.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.surface == .field, !self.panel.isKeyWindow else { return }
                self.makePanelKeyWinningLateActivation()
            }
            OrbDebug.log("expandToField: retarget mid-collapse re-summon, morphTarget=1")
            return
        }

        guard surface == .orb else { return }

        // Gate-3 fix (F1): the collapsed orb now tracks the cursor across the FULL screen
        // (`OrbFollower.targetOrigin()` no longer over-fences it against the expanded frame's
        // size — see that type's doc). That means the orb can genuinely be sitting right at a
        // screen edge when the user expands, so the raw anchor is re-fenced HERE, against the
        // real `windowSize` about to be applied, before computing the resize origin — otherwise
        // a bottom/edge-hugging orb could expand partially off-screen on this one hard
        // `setFrame` cut (the follower's own per-frame fence only kicks in on the NEXT tick).
        let anchor = fenceAnchorForTopLeftCorner(
            currentGlassAnchor(),
            expandedSize: morphModel.windowSize,
            haloPadding: morphModel.haloPadding,
            navOffset: morphModel.navPillHeight + morphModel.interPillGap,
            visibleFrame: (panel.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
        )
        let origin = morphModel.corner.windowOrigin(
            glassAnchor: anchor,
            morph: morphModel,
            windowSize: morphModel.windowSize,
            surface: .composer
        )
        panel.setFrame(NSRect(origin: origin, size: morphModel.windowSize), display: false)
        // Gate-3 fix (F1, root cause #2): keep `NormaFieldView`'s outer `.frame(...)` request in
        // lockstep with this resize — see `MorphModel.activeWindowSize`'s doc for why (NSHostingView
        // otherwise silently resizes this panel back to whatever the SwiftUI content requests).
        morphModel.activeWindowSize = morphModel.windowSize
        follower.isExpanded = true
        follower.snapWindowOrigin(to: origin)

        externalFocus = ExternalFocusSnapshot.captureCurrent()
        panel.acceptsKeyInput = true
        panel.ignoresMouseEvents = false
        surface = .field
        // Finding-2 fix (gate 2): make the panel key AND keep it key against a late external-app
        // reactivation — see `makePanelKeyWinningLateActivation`'s doc. `surface = .field` is set
        // FIRST so the belt in the key monitor (and the retry's `surface == .field` guard) sees the
        // right surface immediately.
        makePanelKeyWinningLateActivation()
        startMorph(target: 1)

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self else { return event }
            // Finding-2 belt (gate 2, wave-9 parity): a LOCAL monitor only ever sees OUR app's own
            // events, and this accessory app has exactly ONE window a keyDown could be meant for
            // while the field is open — the field panel. So route Esc on the SURFACE, not on
            // `event.window === panel`: a re-summon key race can leave the keyDown bound to a
            // stale/nil window (exactly what wave-9 found for synthesized scrolls), and the old
            // window-identity guard then silently dropped a perfectly good Esc. `escMonitorAction`
            // is the pure, table-tested decision (window identity is deliberately not one of its
            // inputs). NOTE the residual case this belt canNOT cover: if the panel isn't key AND
            // our app isn't active at all, no local monitor fires — that path is closed by
            // `makePanelKeyWinningLateActivation()` making the panel key on every summon.
            let running = self.session.state.turnRunning
            switch escMonitorAction(
                keyCode: event.keyCode,
                surface: self.surface,
                escConsumed: { self.onEsc?() == true }
            ) {
            case .passThrough:
                return event
            case .interrupt:
                OrbDebug.log("key monitor: Esc → interrupt isPanel=\(event.window === panel) panelKey=\(panel.isKeyWindow) turnRunning=\(running)")
                return nil
            case .collapse:
                OrbDebug.log("key monitor: Esc → collapse isPanel=\(event.window === panel) panelKey=\(panel.isKeyWindow) turnRunning=\(running)")
                self.collapseToOrb()
                return nil
            }
        }

        // Wave 2c task 4: same lifecycle as the Esc monitor above — installed only while
        // `.field`, torn down on collapse completion (`finishCollapse()`). Window-scoped like
        // the key monitor so a swipe elsewhere in the app (there's only ever this one panel,
        // but the filter costs nothing) never gets routed here.
        swipeRecognizer.reset()
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            guard let self else { return event }
            // Real trackpad events arrive bound to the panel (`event.window === panel` — proven
            // live in wave 8: 80 consecutive real samples). Synthesized scroll events
            // (accessibility/automation tooling, and this project's own CGEvent verification
            // probes) can NEVER take that path: macOS's window server refuses to route a
            // synthesized scroll to a borderless nonactivating panel (verified empirically in
            // wave 9 — `.cghidEventTap` and `.cgSessionEventTap` posts over the panel's visible
            // pixels with the cursor warped there never reached this app at all), and
            // `CGEventPostToPid` delivers them with NO window binding (`event.window == nil`,
            // `windowNumber == 0`). A nil-window scroll event reaching this single-panel app has
            // no other possible target — AppKit drops it after monitors run — so treating one as
            // panel-directed while the cursor is actually inside the panel's frame is safe and
            // makes the surface driveable by synthetic events, same spirit as v1's
            // ScrollRedirector consuming raw CGEvents that never had a window at all.
            let panelDirected = event.window === panel
                || (event.window == nil && panel.frame.contains(NSEvent.mouseLocation))
            guard panelDirected else {
                // Wave-9 diagnostic (debug-gated, permanent): without this branch a rejected
                // sample vanished silently, leaving "no log lines" ambiguous between "no events
                // arrived at the app" and "events arrived but failed the window guard".
                OrbDebug.log("scroll monitor: NON-PANEL window=\(event.window.map { String(describing: type(of: $0)) } ?? "nil") num=\(event.windowNumber) dy=\(event.scrollingDeltaY)")
                return event
            }
            let result = swipeRecognizer.handle(event)
            result.performAcceptedFeedback { direction in
                self.handleAcceptedSwipe(direction)
            }

            // Wave-9 gate fix (v1 mechanism port — see `MorphModel.responseScrollOffset`'s doc
            // and the wave-9 report): wave 8 proved every vertical-dominant sample reaches this
            // monitor and gets handed back to AppKit (`.ignored` → PASSED, `return event`) — but
            // AppKit's normal hit-test dispatch never actually delivers it to the reply's
            // viewport (`GlassForegroundLegibility`'s `.compositingGroup()` breaks that path,
            // confirmed via synthesized CGEvent probes). v1 never trusted that dispatch either
            // (its composer was permanently `ignoresMouseEvents = true`): its `ScrollRedirector`
            // CGEventTap drove the AppKit clip-view bounds directly off the raw deltas and
            // swallowed the event at the tap. Same idea here, scoped to this monitor: an
            // `.ignored` sample (not part of a horizontal swipe) while the inline response is
            // actually showing drives `responseScrollOffset` directly and is swallowed ourselves,
            // rather than handed back to a dispatch path that silently drops it. A `.ignored`
            // sample while the COMPOSER is showing (or there's no reply at all) still falls
            // through to `return event` unchanged — this fix is scoped to the reply only, per the
            // wave-9 brief.
            var consumed = result.consumesScroll
            if case .ignored = result, self.isShowingInlineResponse() {
                self.applyResponseScroll(deltaY: event.scrollingDeltaY)
                consumed = true
            }

            // Wave-8 gate item 2 empirical evidence hook, extended for wave 9: NORMA_ORB_DEBUG=1
            // traces every scroll-wheel sample's CONSUMED (swallowed here — either swipe-tracking
            // or, new in wave 9, manually driving the reply's scroll offset) vs PASSED (handed
            // back to AppKit unchanged) decision, paired with the raw deltas/phase that drove it
            // and the resulting offset — this is what proves a vertical two-finger drag actually
            // moves the reply now instead of being silently dropped by AppKit's hit-test dispatch.
            OrbDebug.log("scroll monitor: \(consumed ? "CONSUMED" : "PASSED") result=\(result) dx=\(event.scrollingDeltaX) dy=\(event.scrollingDeltaY) phase=\(event.phase) responseScrollOffset=\(self.morphModel.responseScrollOffset)")
            return consumed ? nil : event
        }

        OrbDebug.log("expandToField: morphTarget=1")
    }

    /// Finding-2 fix (gate 2 — "Esc from the field is dead after a re-summon"). ROOT CAUSE: after an
    /// auto-collapse, `finishCollapse()` calls `externalFocus?.restore()` →
    /// `NSRunningApplication.activate()` on the app that was frontmost before we summoned. The
    /// WindowServer processes that activation ASYNCHRONOUSLY. A fast re-summon's `panel.makeKey()`
    /// can therefore run and win momentarily, only for the in-flight external activation to LAND a
    /// beat later and steal system key focus back. The panel is then no longer the key window,
    /// physical keyDowns (incl. Esc) route to the external app, and our LOCAL key monitor — which
    /// only ever sees OUR app's own events — never fires at all (no belt can recover an event that
    /// never arrives; that's why the wave-9-style window-agnostic belt in the monitor is necessary
    /// but not SUFFICIENT — this is the sufficient half).
    ///
    /// FIX: assert key now, then RE-ASSERT on the next runloop tick(s). By the next tick the late
    /// external activation has already landed, so our re-`makeKey()` is the last word and wins.
    /// `orderFrontRegardless()` + `makeKey()` (deliberately NOT `NSApp.activate(ignoringOtherApps:)`
    /// — v1's avoided nuclear option; a `.nonactivatingPanel` can hold key focus without activating
    /// the whole app, Spotlight-style). Bounded retries, and each retry bails the instant the panel
    /// is already key or the surface has left `.field`, so it can never spin.
    private func makePanelKeyWinningLateActivation(retriesLeft: Int = 3) {
        keyAssertionCountForTesting += 1
        panel.orderFrontRegardless()
        panel.makeKey()
        let isKey = panel.isKeyWindow
        OrbDebug.log("makePanelKey: panelKey=\(isKey) retriesLeft=\(retriesLeft)")
        guard !isKey, retriesLeft > 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.surface == .field, !self.panel.isKeyWindow else { return }
            self.makePanelKeyWinningLateActivation(retriesLeft: retriesLeft - 1)
        }
    }

    /// The physical screen point where the composer's chosen corner (`morphModel.corner`,
    /// always `.topLeft`) currently sits, derived from the panel's ACTUAL live frame. Stable
    /// across a resize — that's the whole "expand in place" property (see the type doc above):
    /// resizing the panel only adds/removes interior space to the right/below this point, it
    /// never moves the point itself, so this can be read BEFORE either `expandToField()`'s
    /// up-resize or `finishCollapse()`'s down-resize to recover the exact anchor to resize
    /// around, regardless of which size the panel currently is.
    private func currentGlassAnchor() -> CGPoint {
        let origin = panel.frame.origin
        let size = panel.frame.size
        let local = morphModel.corner.orbAnchorInWindow(windowSize: size, morph: morphModel)
        return CGPoint(x: origin.x + local.x, y: origin.y + size.height - local.y)
    }

    /// Wave-5 gate item 4 (user directive, addendum): the v1 music-player convention (`.left →
    /// previousTrack()`, `.right → nextTrack()`) is REPLACED by page-flip/browser-back — physical
    /// `.right` means back/older, `.left` means forward/newer (`exchangeNavDirection(for:)`,
    /// `Field/ExchangeNavigation.swift`). The decision now covers the field's FULL position
    /// space, not just history: swiping "newer" past the live (nil) view hops into the composer;
    /// swiping "older" from the composer hops back to the response, when there's a reply to
    /// return to (`navigateFieldSwipe`, same file — extracted pure so it's table-tested).
    /// Returns whether the swipe actually moved anything so the haptic only fires on an ACCEPTED
    /// swipe (D6), not on every threshold crossing (e.g. already at the oldest exchange and
    /// swiping further "older" is a no-op, silently — same as before this wave).
    private func handleAcceptedSwipe(_ direction: TrackpadHorizontalSwipeDirection) -> Bool {
        let navDirection = exchangeNavDirection(for: direction)
        let showingDraft = isShowingDraft?() ?? false
        let hasReply = session.state.turnRunning
            || !(session.state.exchanges.last?.reply.isEmpty ?? true)
        guard let target = navigateFieldSwipe(
            exchangeIndex: exchangeIndex,
            showingDraft: showingDraft,
            hasReply: hasReply,
            direction: navDirection,
            count: session.state.exchanges.count
        ) else { return false }

        switch target {
        case .exchange(let next):
            if showingDraft { setShowingDraft?(false) }
            exchangeIndex = next
        case .composer:
            setShowingDraft?(true)
        }
        return true
    }

    /// Wave-9 gate fix: mirrors `NormaFieldView.showsInlineResponse` (`hasReply &&
    /// !adapter.showingDraft`) using the state this controller already has direct access to
    /// (`session.state`, and `isShowingDraft` — the same composer-hop seam `handleAcceptedSwipe`
    /// above reads), rather than reaching into `FieldStateAdapter` (which this controller
    /// deliberately doesn't import — see `isShowingDraft`'s own doc). Gates the scroll monitor's
    /// manual `responseScrollOffset` drive to exactly the surface it's meant for: showing the
    /// composer (or nothing at all) leaves an `.ignored` scroll sample untouched (`return event`),
    /// unchanged from before this wave.
    private func isShowingInlineResponse() -> Bool {
        guard isShowingDraft?() != true else { return false }
        return session.state.turnRunning || !(session.state.exchanges.last?.reply.isEmpty ?? true)
    }

    /// Wave-9 gate fix — ported from v1's `GlassFieldWindow.scrollComposer` (manual AppKit
    /// clip-view bounds scroll; see `MorphModel.responseScrollOffset`'s doc for the full
    /// mechanism and why hit-test dispatch can't be trusted here). Drives
    /// `morphModel.responseScrollOffset` directly off the raw vertical delta instead.
    ///
    /// Sign: `NSEvent.scrollingDeltaY` already bakes in the user's System Settings "natural
    /// scrolling" preference — a two-finger drag UP (fingers move toward the top of the trackpad)
    /// reports a NEGATIVE `scrollingDeltaY` under natural scrolling and is the gesture that reveals
    /// content further DOWN the reply (the conventional "scroll down" motion). Revealing content
    /// further down means the visible window into the reply moves further from its top, i.e.
    /// `responseScrollOffset` must INCREASE — hence the negation below (v1's own AppKit clip-origin
    /// convention, `origin.y -= deltaY` in `GlassFieldWindow.scrollComposer`, is the same negation
    /// for the same reason, just expressed in AppKit's bounds-origin terms instead of a SwiftUI
    /// offset). Verified empirically against synthesized CGEvent scroll probes — see the wave-9
    /// report.
    private func applyResponseScroll(deltaY: CGFloat) {
        morphModel.responseScrollOffset = clampedResponseScrollOffset(
            current: morphModel.responseScrollOffset,
            deltaY: deltaY,
            maxOffset: morphModel.maxResponseScrollOffset
        )
    }

    /// Starts the collapse morph toward 0. Teardown (monitor off, keyability off, focus
    /// restore, panel resize DOWN, `surface` → `.orb`) happens on COMPLETION
    /// (`finishCollapse()`), not here — the tracking spring runs throughout so the shrinking
    /// glass keeps riding the cursor instead of detaching mid-collapse (v1's "ghost circle" fix).
    func collapseToOrb() {
        guard surface == .field else { return }
        startMorph(target: 0)
        OrbDebug.log("collapseToOrb: morphTarget=0")
    }

    func toggleField() {
        if !isVisible {
            // Summon while hidden: bring the orb back first, then expand — never
            // expand an ordered-out panel (makeKey on a hidden window + nil screen).
            show()
        }
        if surface == .field && morphTarget == 0 {
            // Mid-collapse re-summon: v1 semantics are that a tap DURING the collapse
            // reopens (see `expandToField()`'s retarget path) rather than being dropped or
            // queuing a second collapse. Only a tap while fully open (or still expanding)
            // closes — that's the `else` below, unchanged.
            expandToField()
        } else if surface == .orb {
            expandToField()
        } else {
            collapseToOrb()
        }
    }

    /// Phase 2d-i: field → window handoff. The field force-finishes its collapse via the
    /// existing hide() path (monitors off, key relinquished, follower stopped — the exact
    /// teardown the 2c gate hardened), the orb panel disappears (spec §2: the window IS
    /// Norma until dismissed), and the chat window grows from where the field was.
    var onExpandToWindow: ((NSRect) -> Void)?

    /// Legal only from `.field`. Ordering is load-bearing: capture `panel.frame` FIRST (before
    /// anything moves it), THEN `hide()` — which force-finishes the in-flight collapse morph
    /// synchronously (`finishCollapse()` resizes the panel back down AND sets `surface = .orb`)
    /// and orders the panel out — THEN overwrite `surface` to `.window`, THEN fire
    /// `onExpandToWindow?` with the frame captured before any of that teardown ran. Reordering
    /// this drops either the source frame (if captured after `hide()` resizes the panel) or
    /// leaves `surface` at the wrong value (if set before `hide()`, since `hide()`'s
    /// `finishCollapse()` unconditionally stamps `.orb`).
    func enterWindowMode() {
        guard surface == .field else { return }
        let sourceFrame = panel.frame
        hide()               // force-finishes collapse → surface = .orb, panel ordered out
        surface = .window
        onExpandToWindow?(sourceFrame)
    }

    /// Task 6 (FieldFocus): public alias for `enterWindowMode()` reachable from
    /// `FieldStateAdapter.onExpandToWindow` — the field's Enter-on-chevron path and the (best-
    /// effort click) chevron overlay both call this indirectly via the adapter, never
    /// `enterWindowMode()` directly (the adapter has no reference to the controller's window-mode
    /// internals beyond this seam).
    func requestExpandToWindow() {
        enterWindowMode()
    }

    /// Legal only from `.window`. Restores the orb: `surface = .orb` first (so the chat window's
    /// `onClose` → this call leaves no window in between where `surface` is stale), then `show()`
    /// re-summons the orb panel at the cursor and restarts the follower.
    func exitWindowMode() {
        guard surface == .window else { return }
        surface = .orb
        show()               // orb reappears at the cursor; follower restarts
    }

    // MARK: Morph spring

    private func startMorph(target: Double) {
        morphTarget = target
        guard morphTimer == nil else { return }
        lastMorphTick = CACurrentMediaTime()
        morphTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.morphTick()
            }
        }
    }

    private func cancelMorphTimer() {
        morphTimer?.invalidate()
        morphTimer = nil
        morphVelocity = 0
    }

    /// Internal (not `private`) purely so `MorphTimerReentrancyTests` can drive a stale tick
    /// directly — see the re-entry guard's doc just below for why that's needed.
    func morphTick() {
        // Re-entry guard (gate fix — Esc-interrupt live-gate finding): `startMorph()` schedules
        // this via `Timer.scheduledTimer` whose closure hops through `Task { @MainActor in
        // self?.morphTick() }` rather than running synchronously. Under main-actor contention
        // (reproduced live during the gate's repro session: rapid, overlapping summon/collapse
        // triggers backed up the main actor enough that SEVEN queued `Task` closures all ran in
        // a burst once it freed up) MULTIPLE Task closures can queue up before any of them runs.
        // Each one independently re-checks the settle condition below and — with no guard here —
        // redundantly re-ran the ENTIRE settle-and-teardown branch, including `finishCollapse()`
        // seven times over for a single collapse (confirmed via `OrbDebug` — see the gate
        // report). `cancelMorphTimer()` sets `morphTimer = nil` the FIRST time this settles, so
        // any later/duplicate tick now bails out here instead of redundantly re-running
        // teardown — cheap insurance against this class of stale-callback bug even though this
        // session's repro of the reported Esc failure itself did not reproduce through this path
        // (see the gate report's "what did and didn't reproduce" section).
        guard morphTimer != nil else { return }

        let now = CACurrentMediaTime()
        let dt = now - lastMorphTick
        lastMorphTick = now

        let (next, velocity) = morphStep(
            progress: morphModel.progress,
            velocity: morphVelocity,
            target: morphTarget,
            dt: dt
        )
        morphModel.progress = next
        morphVelocity = velocity

        let distance = abs(morphTarget - next)
        guard distance < 0.001, abs(velocity) < 0.01 else { return }

        morphModel.progress = morphTarget
        cancelMorphTimer()

        if morphTarget == 0 {
            finishCollapse()
        }
    }

    /// The collapse-completion teardown, shared by the morph settling naturally (`morphTick()`)
    /// and `hide()`'s force-finish path. Task B: mirrors v1 `settleCollapsedOrb()`
    /// (GlassFieldWindow.swift:1493-1525) — resizes the panel back DOWN to
    /// `morphModel.collapsedWindowSize` now that nobody will see the last bit of the morph,
    /// keeping the SAME physical anchor point the field was just occupying (`currentGlassAnchor()`
    /// reads the panel's CURRENT — still big — frame) so the shrink doesn't jump.
    private func finishCollapse() {
        finishCollapseCallCountForTesting += 1
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        panel.acceptsKeyInput = false
        panel.ignoresMouseEvents = true

        let anchor = currentGlassAnchor()
        let origin = morphModel.corner.windowOrigin(
            glassAnchor: anchor,
            morph: morphModel,
            windowSize: morphModel.collapsedWindowSize,
            surface: .composer
        )
        panel.setFrame(NSRect(origin: origin, size: morphModel.collapsedWindowSize), display: false)
        // Gate-3 fix (F1, root cause #2): see the matching line in `expandToField()` +
        // `MorphModel.activeWindowSize`'s doc.
        morphModel.activeWindowSize = morphModel.collapsedWindowSize
        follower.isExpanded = false
        follower.snapWindowOrigin(to: origin)

        externalFocus?.restore()
        externalFocus = nil
        surface = .orb
        exchangeIndex = nil

        OrbDebug.log("collapseToOrb: complete")
    }
}

/// Finding-2 (gate 2): what the field key monitor should do with a keyDown, extracted pure so it's
/// table-tested (`EscInterruptTests`).
enum EscMonitorAction: Equatable { case passThrough, interrupt, collapse }

/// Esc (keyCode 53) while the field is open is ALWAYS the field's — interrupt a running turn
/// (whatever `escConsumed` reports, i.e. `onEsc()`), else collapse the field. Every other key, and
/// any key while the surface is the collapsed orb, passes through untouched.
///
/// Window identity is deliberately NOT an input: a local monitor only sees OUR app's events, this
/// accessory app has a single window, and a re-summon key race can leave the keyDown bound to a
/// stale/nil window — so routing on the SURFACE (not `event.window === panel`) is what makes the
/// Esc survive the race (same window-agnostic acceptance wave-9 landed for synthesized scrolls).
///
/// `escConsumed` is a closure, not a `Bool`, so `onEsc()`'s interrupt side effect fires ONLY after
/// the keyCode/surface guard passes — never on unrelated keydowns.
func escMonitorAction(
    keyCode: UInt16,
    surface: OrbWindowController.Surface,
    escConsumed: () -> Bool
) -> EscMonitorAction {
    guard keyCode == 53, surface == .field else { return .passThrough }
    return escConsumed() ? .interrupt : .collapse
}

/// 4-finger tap / hotkey routing (spec §4): while the chat window is open the tap closes
/// it; otherwise the existing field toggle. `windowVisible` is the belt against a stale
/// `.window` surface with no live panel — never wedge the summon path.
enum SummonToggleAction: Equatable { case toggleField, closeWindow }

func summonToggleAction(surface: OrbWindowController.Surface, windowVisible: Bool) -> SummonToggleAction {
    (surface == .window && windowVisible) ? .closeWindow : .toggleField
}
