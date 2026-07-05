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
    enum Surface { case orb, field }

    let follower: OrbFollower
    let morphModel: MorphModel
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

    /// Wired in Task 6: the controller exposes callbacks, it does NOT import AppModel.
    /// Returns send success — GlassRootView's submit() gates the draft clear on this so a
    /// failed/disconnected send never loses the composed text (spec §6).
    var onSubmit: ((String) async -> Bool)?
    var onInterrupt: (() -> Void)?
    /// Returns true when the key was consumed as an interrupt (turn running); false → collapse.
    var onEsc: (() -> Bool)?

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
        let morph = MorphModel()
        self.morphModel = morph
        self.follower = OrbFollower(morphModel: morph)

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
            rootView: GlassRootView(session: session, controller: self, morphModel: morph)
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
        panel.makeKey()
        surface = .field
        startMorph(target: 1)

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self, event.window === panel else { return event }
            if event.keyCode == 53 { // Esc
                if self.onEsc?() == true { return nil } // consumed as interrupt
                self.collapseToOrb()
                return nil
            }
            return event
        }

        // Wave 2c task 4: same lifecycle as the Esc monitor above — installed only while
        // `.field`, torn down on collapse completion (`finishCollapse()`). Window-scoped like
        // the key monitor so a swipe elsewhere in the app (there's only ever this one panel,
        // but the filter costs nothing) never gets routed here.
        swipeRecognizer.reset()
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            guard let self, event.window === panel else { return event }
            let result = swipeRecognizer.handle(event)
            result.performAcceptedFeedback { direction in
                self.handleAcceptedSwipe(direction)
            }
            return result.consumesScroll ? nil : event
        }

        OrbDebug.log("expandToField: morphTarget=1")
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

    /// v1 parity (MusicDynamicIslandPlugin/MediaDynamicIslandPlugin's `.left → previousTrack()`,
    /// `.right → nextTrack()`) maps `.left` to "older" and `.right` to "newer" here too — swipe
    /// left steps back into history, swipe right steps forward toward (and past, back to nil/
    /// live) the most recent exchange. Returns whether the index actually moved so the haptic
    /// only fires on an ACCEPTED swipe (D6), not on every threshold crossing (e.g. already at
    /// the oldest exchange and swiping further left is a no-op, silently).
    private func handleAcceptedSwipe(_ direction: TrackpadHorizontalSwipeDirection) -> Bool {
        let navDirection: ExchangeNavDirection = direction == .left ? .older : .newer
        let next = navigateExchange(exchangeIndex, direction: navDirection, count: session.state.exchanges.count)
        guard next != exchangeIndex else { return false }
        exchangeIndex = next
        return true
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

    private func morphTick() {
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
