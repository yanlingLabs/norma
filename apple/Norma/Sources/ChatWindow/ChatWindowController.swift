import AppKit
import SwiftUI

/// Esc routing for the chat window — same shape as the field's `escMonitorAction`
/// (OrbWindowController.swift): interrupt a running turn (window STAYS open so you can
/// watch the stopped feedback), otherwise close back to the orb. Pure for tests.
enum WindowEscAction: Equatable { case interrupt, close }

func windowEscAction(keyCode: UInt16, escConsumed: () -> Bool) -> WindowEscAction? {
    guard keyCode == 53 else { return nil }
    return escConsumed() ? .interrupt : .close
}

/// Phase 2d-i: the third surface. A stationary, draggable, near-opaque glass panel —
/// v1 transplant (AI pointer InteractionController.swift:800-1280,
/// `DetachedChatWindowController`), adapted: v2 has ONE window at a time (no UUID
/// registry), and the panel is created on `show` / destroyed on `close` (D9: closed
/// window = nil panel = zero cost; v1 kept its panels alive).
@MainActor
final class ChatWindowController: NSObject, NSWindowDelegate {
    private let session: SessionModel
    private let adapter: FieldStateAdapter
    private(set) var panel: ChatWindowPanel?
    private var keyMonitor: Any?

    /// Spec §2 position rule: nil until the user drags the window; then re-expands go here.
    private(set) var rememberedFrame: NSRect?
    /// Guards `windowDidMove` so ANIMATED/programmatic frame changes never pollute
    /// `rememberedFrame` — windowDidMove fires for those too, not just user drags.
    private var programmaticMove = false

    /// Frame-animation drive (deliberately NOT `NSAnimationContext`/`.animator().setFrame`):
    /// verified live that AppKit's implicit window-frame animation is unsafe here — a second
    /// `show()`/`close()` cycle starting while a PRIOR panel's animator-driven frame change is
    /// still in flight reliably crashes (SIGBUS, misaligned access deep in AppKit's animation
    /// machinery, reproduced standalone outside XCTest with a minimal two-panel repro; a single
    /// show+close in isolation never crashes). Rapid open/close — exactly what
    /// `ChatWindowControllerTests` does back-to-back, and a plausible real user click pattern —
    /// hits this every time. A manual 60Hz `Timer` interpolating the frame directly (same
    /// mechanism as `OrbWindowController`'s morph spring) reuses the existing `smoothstep`/
    /// `interpolatedRect` pure helpers (`Orb/MorphGeometry.swift`) for the same duration/easing
    /// feel, sidesteps AppKit's implicit-animation state entirely, and survived an 8-round
    /// rapid-fire torture test with zero crashes where the animator approach failed on round 2.
    /// Fix D (anim-fidelity restore): the grow used to be a fixed-duration, smoothstep-eased
    /// interpolation (`growStartTime`/`growDuration`). Replaced with the codebase's own morph
    /// spring (`morphStep`, `Orb/SpringStep.swift`) driving a plain 0→1 scalar. Gate r6 (close-feel
    /// live-gate finding): now at 140/22 — the SAME tuning as the core orb↔field morph's own
    /// default (`morphStep`'s defaulted params, `OrbWindowController.morphTick()`'s call site,
    /// which omits stiffness/damping) — rather than the previous 140/18 (ζ≈0.76), which read as a
    /// touch too soft/floaty next to v1's morph language. Matching the core spring exactly makes
    /// the window's grow/shrink feel like the SAME motion vocabulary as the orb↔field morph.
    /// Gate r3 (W1 — animated close): generalized to drive BOTH directions with the SAME spring —
    /// `growTimer`/`growStart`/`growTarget` etc. renamed `frameAnimTimer`/`frameAnimStart`/
    /// `frameAnimTarget` and a `frameAnimDirection` (`.grow`/`.shrink`) added so `frameAnimTick()`
    /// knows which way is "done" (attach nothing / call `close()`). Everything about the manual-
    /// Timer-not-`.animator()` reasoning above is unchanged and now covers the shrink too.
    /// Gate r4 (fully self-drawn window): the window is now BORDERLESS for its whole life (no
    /// `.titled`, no toolbar, no system traffic-light buttons — `ChatWindowRootView` draws its own),
    /// so there is NO chrome minimum for either direction to fight and NO styleMask change anywhere:
    /// the grow/shrink simply run tiny↔full. This deleted the r2/r3 chrome machinery entirely (the
    /// attach-at-construction toolbar, the `standardWindowButton` alpha ramps, and the r4-draft
    /// chrome-strip-at-close) — see `show(from:)` and the report for the full "why".
    private enum FrameAnimDirection { case grow, shrink }
    private var frameAnimTimer: Timer?
    private var frameAnimDirection: FrameAnimDirection = .grow
    private var frameAnimStart: NSRect = .zero
    private var frameAnimTarget: NSRect = .zero
    private var frameAnimProgress: Double = 0
    private var frameAnimVelocity: Double = 0
    private var lastFrameAnimTick: CFTimeInterval = 0

    /// True while a shrink (`closeAnimated()`) is actively driving frames — `closeAnimated()`
    /// reads this to stay idempotent (a second call while one is already in flight is a no-op).
    private var isShrinking: Bool { frameAnimTimer != nil && frameAnimDirection == .shrink }

    /// Gate fix (F1), generalized by gate r3 (W1) to cover the shrink too: true for the entire
    /// duration of EITHER frame animation (grow or shrink — the initial placement AND every 60Hz
    /// tick that follows), false otherwise. `panel.frameSanitizer` (installed in `show()`) reads
    /// this to bypass its normal 340×360 size floor while true — the grow's source is the COLLAPSED
    /// ORB's small panel size (`chatWindowCollapsedSize`, ~240×140), and the shrink's TARGET is the
    /// even smaller visible orb BUBBLE (`chatWindowOrbBubbleDiameter`, ~20×20 — gate r5), both of
    /// which the floor would otherwise inflate to 340×360, killing the "grows from / melts into a
    /// tiny circle" effect this fix and W1/r5 exist to restore. Position still gets clamped on-screen throughout
    /// (see `clampedChatWindowPosition`) — only the size floor is bypassed. Set true right before
    /// each animation's first frame, cleared in `cancelFrameAnimation()` (both directions' natural
    /// t>=1 finish and `close()`'s mid-flight cancel), same lifecycle as `programmaticMove`.
    private var isAnimatingFrame = false

    /// Gate r4 regression seam (window shrink stall fix), gate r5: the true on-screen frame the
    /// close-shrink actually REACHED at settle, captured right before teardown. Tests assert this
    /// landed at the visible orb-BUBBLE size (`chatWindowOrbBubbleDiameter`, ~20×20 — gate r5 shrinks
    /// to the bubble, not the 240×140 panel) — proving the shrink reaches its target instead of
    /// stalling at a chrome minimum (the r4 defect) or at the big-square panel (the r5 defect). With
    /// the window borderless for life there is no chrome minimum; this stays as a permanent guard
    /// against any future chrome/minimum/target regression. nil until a shrink has settled.
    private(set) var lastShrinkSettledFrameForTesting: NSRect?

    /// Gate r4 (custom green zoom button): the frame to restore to when the manual zoom toggle is
    /// pressed a second time. nil = not currently zoomed. Kept separate from `rememberedFrame`
    /// (drag memory) on purpose — a zoom is a transient toggle, not a new remembered home.
    private var preZoomFrame: NSRect?

    /// Gate r5 (window melts into the orb): during the close-shrink the live SwiftUI content
    /// (`ChatWindowRootView` — an 88pt composer, header band, paddings) CANNOT lay out at ~20pt and
    /// would fight/clip ugly. So at `closeAnimated()` start we render the hosting view to a bitmap
    /// (`installShrinkSnapshot()`), swap the panel's `contentView` to an `NSImageView` showing it
    /// (scaled independently on both axes), and animate THAT instead — buttery scaling with zero
    /// layout-collapse artifacts. Held here so `frameAnimTick()` can ramp its layer's `cornerRadius`
    /// (`chatWindowCornerRadius`, 26pt — gate r6 — → a circle) each frame; nilled in `close()`
    /// (torn down with the panel).
    private var shrinkSnapshotView: NSImageView?

    /// Gate r5 one-shot latch: `onClose` (which re-summons the orb at the cursor) fires EXACTLY once
    /// per show — EARLY, when the shrink crosses `chatWindowOrbHandoffProgress` (~0.7), so the orb
    /// rematerializes WHILE the last of the dissolving circle melts over it. The final settle and
    /// any racing `close()` must NOT re-fire it. Reset in `show()`.
    private var onCloseFired = false

    /// Gate r5 test seam: the shrink `progress` at the tick `onClose` fired the early orb handoff
    /// (nil until it fires, and only set on the shrink's 0.7 crossing — NOT on a synchronous
    /// `close()`). Tests assert this landed in [0.7, 1.0) — i.e. BEFORE the final settle.
    private(set) var onCloseFiredAtProgressForTesting: Double?

    /// Gate r5 test seam: the shrink snapshot layer's `cornerRadius` at the most recent melt tick.
    /// Tests assert it ramps to ≈ `chatWindowOrbBubbleDiameter / 2` (a circle) by settle.
    private(set) var lastShrinkCornerRadiusForTesting: CGFloat = 0

    /// Gate r5 test seam: true once `closeAnimated()`'s content snapshot has replaced the live
    /// SwiftUI hosting view — i.e. the melt is animating a bitmap, not the collapsing composer.
    var isShowingShrinkSnapshotForTesting: Bool { panel?.contentView is NSImageView }

    /// Spec §4: closing the window restores focus to the previously active app — the same
    /// snapshot/restore type the field uses (see OrbWindowController's `externalFocus`).
    private var externalFocus: ExternalFocusSnapshot?

    var onClose: (() -> Void)?
    var onEsc: (() -> Bool)?

    init(session: SessionModel, adapter: FieldStateAdapter) {
        self.session = session
        self.adapter = adapter
        super.init()
    }

    var isVisible: Bool { panel != nil }

    /// Re-entrancy (gate r3, W1): this guard already covers `show()` racing an in-flight
    /// `closeAnimated()` shrink for free — `panel` stays non-nil for the shrink's ENTIRE
    /// duration (it's only nilled by `close()`'s teardown at the very end), so a `show()` call
    /// during a shrink simply no-ops here, same as it always has during a grow. Deliberately not
    /// special-cased further: the summon router (`AppDelegate`) reads `chat?.isVisible == true`
    /// and routes to `.closeWindow` whenever a window exists at all, shrinking or not, so this
    /// path is not expected to be hit by the real UI regardless.
    func show(from sourceFrame: NSRect) {
        guard panel == nil else { return }
        // Gate r5: fresh show → re-arm the one-shot orb-handoff latch and its test seams.
        onCloseFired = false
        onCloseFiredAtProgressForTesting = nil
        lastShrinkCornerRadiusForTesting = 0
        let screen = NSScreen.screens.first { $0.frame.intersects(sourceFrame) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let target = chatWindowTargetFrame(
            sourceFrame: sourceFrame, remembered: rememberedFrame,
            screenVisibleFrame: visible, defaultSize: chatWindowDefaultSize
        )

        // Panel construction: v1 transplant (InteractionController.swift:849-877). Gate r6
        // (v1 parity, live-gate finding): the collectionBehavior below deliberately does NOT
        // include `.canJoinAllSpaces` — see that assignment's own doc for why the chat window and
        // the orb panel differ here on purpose.
        //
        // Gate r4 (fully self-drawn window): the panel is BORDERLESS for its entire life —
        // `[.borderless, .nonactivatingPanel, .resizable]`, exactly v1's approach (v1 drew ALL its
        // UI on borderless panels). No `.titled`, no toolbar, no `standardWindowButton` — the three
        // traffic lights are drawn by `ChatWindowRootView` and wired back here (close/minimize →
        // `closeAnimated()`, green → `zoomToggle()`). This is the root-cause cure for BOTH classes
        // of chrome bug the earlier gates fought: (1) AppKit hard-clamps a titled/toolbar window's
        // frame to its own chrome minimum (~40×220), which STALLED the close-shrink at a big rounded
        // square (r4's original defect); and (2) the r2/r3 "chrome pops at grow-settle" fight. With
        // no system window shape at all, neither exists — the grow/shrink run tiny↔full with zero
        // styleMask changes, and the CONTENT owns its own rounded corners again (`ChatWindowRootView`
        // restores its `RoundedRectangle` clip/fill). `.resizable` is kept so any future native
        // edge-resize works if the OS supports it on borderless (see the resize note in the report);
        // our own 340×360 floor still governs user resizes via `frameSanitizer`. `.nonactivatingPanel`
        // keeps the window from stealing app activation (`ExternalFocusSnapshot` restores focus on
        // close regardless).
        let panel = ChatWindowPanel(
            contentRect: target,
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Norma" // a11y/Dock — no visible titlebar to show it in
        panel.contentMinSize = NSSize(width: 340, height: 360) // governs USER resizes; animations bypass via isAnimatingFrame
        panel.frameSanitizer = { [weak self] proposed, _ in
            // Gate fix (F1, generalized r3/W1 to the shrink too): bypass the SIZE floor while a
            // frame animation (grow OR shrink) is driving frames — see `isAnimatingFrame`'s doc.
            // Position still gets clamped on-screen either way.
            guard let self, !self.isAnimatingFrame else {
                return clampedChatWindowPosition(proposed, screenVisibleFrame: visible)
            }
            return clampedChatWindowFrame(proposed, screenVisibleFrame: visible)
        }
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true // borderless: AppKit's shadow follows the tinted RoundedRectangle content shape
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        // Gate r6 (v1 parity, live-gate finding): NO `.canJoinAllSpaces` here — v1's detached
        // chat panel (`InteractionController.swift:868`) deliberately stayed on the Space it was
        // opened on; the ORB panel (`OrbWindowController.swift`) is the thing that follows the
        // user everywhere and correctly keeps `.canJoinAllSpaces` (untouched by this fix). The
        // chat window is furniture — it stays where you put it, on the Space you put it on, and
        // simply isn't visible if you switch away. A 4-finger tap from ANY Space still closes it
        // and returns the orb (`AppDelegate`'s `summonToggleAction` routes to `.closeWindow`
        // whenever `chat?.isVisible == true`, regardless of which Space is active) — that routing
        // is unaffected by this change and needs no `.canJoinAllSpaces` to work, since it's driven
        // by the global tap/hotkey monitor, not by the window itself being on-screen. See also
        // `closeAnimated()`'s `isOnActiveSpace` guard below, which this change makes reachable.
        panel.collectionBehavior = [.stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true // drag the glass body to move (no titlebar to grab)
        panel.acceptsMouseMovedEvents = true
        // Task-5 review catch: AppKit auto-hides key-capable panels when the app deactivates,
        // and Norma (accessory, non-activating panels) is "deactivated" almost always — without
        // this the window vanishes the moment the user clicks any other app, with close()/
        // onClose never firing. Same explicit opt-out the orb panel carries.
        panel.hidesOnDeactivate = false
        // Gate r4 (hypothesis 2): kill the SYSTEM window-hide fade on `orderOut()` — our spring is
        // the only motion language, no close path should get a system-drawn fade layered on top.
        panel.animationBehavior = .none
        panel.delegate = self

        let hosting = NSHostingView(rootView: ChatWindowRootView(
            adapter: adapter,
            onRequestClose: { [weak self] in self?.closeAnimated() },
            onRequestMinimize: { [weak self] in self?.closeAnimated() },
            onRequestZoom: { [weak self] in self?.zoomToggle() }
        ))
        hosting.autoresizingMask = [.width, .height]
        panel.contentView = hosting
        self.panel = panel

        // Grow animation: start at the field's frame, animate to target. Donor pattern:
        // v1's placement move (InteractionController.swift:1091-1114) — v1's own show()
        // was instant; the grow is ours, per spec §2 handoff.
        // Captured BEFORE we take key: by this point the field's own hide() has already
        // restored ITS snapshot, so "current" is the app the user was really in.
        externalFocus = ExternalFocusSnapshot.captureCurrent()

        // Gate fix (F1): `sourceFrame` is now the COLLAPSED orb's own small panel frame
        // (`OrbWindowController.finishCollapse()`, ~240×140 — smaller than this window's own
        // 340×360 floor in both dimensions), not the field's old expanded frame. Deliberately
        // NOT pre-clamped through `clampedChatWindowFrame` here — that would inflate it to the
        // floor before the grow animation even starts. `isAnimatingFrame` makes the panel's own
        // `setFrame` override bypass that floor (position only, see `frameSanitizer` above) for
        // this placement and every tick that follows; read `panel.frame` back afterward so
        // `frameAnimStart` is the exact (position-clamped) frame actually on-screen at t=0, not the
        // raw un-clamped proposal. Gate r4: the window is borderless now, so there is no AppKit
        // chrome minimum — the start frame keeps the orb's full ~240×140 in BOTH dimensions (r3's
        // "height gets chrome-floored" no longer happens).
        isAnimatingFrame = true
        programmaticMove = true
        panel.setFrame(sourceFrame, display: false)
        let startFrame = panel.frame
        panel.orderFrontRegardless()
        panel.makeKey()
        startFrameAnimation(from: startFrame, to: target, direction: .grow)

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self, self.panel != nil, event.window === self.panel else { return event }
            switch windowEscAction(keyCode: event.keyCode, escConsumed: { self.onEsc?() == true }) {
            case .interrupt: return nil // turn interrupted; window stays (spec §4)
            case .close: self.closeAnimated(); return nil
            case nil: return event
            }
        }
    }

    /// Instant, synchronous teardown — the programmatic/internal path. Deliberately left
    /// UNANIMATED (gate r3 kept this exactly as it was): removes the key monitor, orders the
    /// panel out, nils it, restores external focus, fires `onClose` exactly once. Many existing
    /// tests (and `closeAnimated()`'s own settle branch, below) depend on this synchronous,
    /// idempotent contract — guarded on `panel` already being nil, so calling this while a
    /// `closeAnimated()` shrink is in flight tears down immediately and safely races ahead of it
    /// (the shrink's own later settle tick finds `panel` nil and bails, see `frameAnimTick()`'s
    /// own guard — no double `onClose`).
    ///
    /// USER-facing close paths (Esc, the native red traffic light, the summon-toggle close, the
    /// SwiftUI `onRequestClose` seam) all route through `closeAnimated()` instead — see that
    /// method's doc.
    func close() {
        guard let panel else { return }
        cancelFrameAnimation()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor); self.keyMonitor = nil }
        panel.delegate = nil
        panel.orderOut(nil)
        self.panel = nil
        shrinkSnapshotView = nil // gate r5: melt bitmap dies with the panel
        externalFocus?.restore()
        externalFocus = nil
        // Gate r5: `onClose` may already have fired at the ~0.7 orb-handoff crossing (the normal
        // animated path); the settle-driven `close()`, or any racing instant `close()`, must not
        // re-fire it — the latch keeps it exactly-once-per-show. A synchronous `close()` that beats
        // the shrink to 0.7 (e.g. `close()` racing `closeAnimated()`) fires it here for the first time.
        fireOnCloseOnce()
    }

    /// Gate r5: fire `onClose` at most once per show (the one-shot orb-handoff latch). Called both
    /// EARLY from `frameAnimTick()` when the shrink crosses `chatWindowOrbHandoffProgress`, and from
    /// `close()`'s teardown — whichever reaches it first wins; the other is a no-op.
    private func fireOnCloseOnce() {
        guard !onCloseFired else { return }
        onCloseFired = true
        onClose?()
    }

    /// Gate r3 (W1 — animated close): the USER-facing close path. Spring-SHRINKS the panel toward
    /// an orb-sized frame centered on the current cursor (`chatWindowShrinkTargetFrame` —
    /// `OrbWindowController.exitWindowMode()`'s `show()`, wired to this controller's `onClose` via
    /// `AppDelegate`, re-summons the orb exactly there), THEN runs the exact same instant `close()`
    /// teardown once that shrink settles — one spring mechanism drives both the grow and the
    /// shrink (`frameAnimTick()` below).
    ///
    /// No-ops if there's no panel, or a shrink is already in flight (`isShrinking` — idempotent,
    /// a second Esc/traffic-light-click/etc. while one is already running does nothing new).
    /// Mid-grow retarget: `cancelFrameAnimation()` stops the grow's timer/state WITHOUT touching
    /// `panel.frame` — the shrink then reads `panel.frame` fresh, so it starts from wherever the
    /// grow had actually gotten to, not a jump back to the grow's original start or forward to its
    /// target.
    ///
    /// Gate r4 (fully self-drawn window): the window is borderless for life, so this no longer has
    /// to touch the styleMask/chrome at all — the shrink simply runs to orb size. Both the RED close
    /// and the YELLOW minimize buttons route here (see `ChatWindowRootView`): the orb IS Norma's
    /// minimized state, so "dismiss" and "minimize" currently share this shrink-to-orb gesture; the
    /// semantics may diverge in a later phase. Esc during the shrink is a no-op (`isShrinking`).
    ///
    /// Gate r6 (v1 parity — window stays on its Space): now that the panel no longer carries
    /// `.canJoinAllSpaces`, it can be closed from a Space OTHER than the one it's actually showing
    /// on (e.g. the 4-finger tap / summon-toggle routing works from any Space). In that case the
    /// melt would play entirely off-screen from the user's perspective AND `NSEvent.mouseLocation`
    /// below would read a cursor position on the WRONG Space (the shrink target would be centered
    /// on a point that has nothing to do with where the window visually is to the user, or where
    /// the orb should reappear). Skip the animation entirely and tear down instantly instead — see
    /// `panel.isOnActiveSpace` guard just below.
    func closeAnimated() {
        guard let panel else { return }
        guard !isShrinking else { return }
        guard panel.isOnActiveSpace else {
            // Gate r6: off-Space close — no visible melt to play and no valid cursor to target;
            // same instant, idempotent teardown the red/yellow buttons would otherwise animate
            // into. `close()` still fires `onClose` exactly once via the latch.
            close()
            return
        }
        cancelFrameAnimation() // stop any in-flight GROW — state only, frame is left exactly where it was
        // Gate r5: freeze the live content to a bitmap and animate THAT down to the orb bubble — the
        // SwiftUI composer/header can't lay out at ~20pt without clipping/fighting. Snapshot happens
        // here, so mid-GROW retarget captures whatever is currently rendered (the content is live
        // during the grow). Graceful: if the snapshot can't be taken, the live view is animated
        // instead (may clip at the bottom, but never crashes).
        installShrinkSnapshot()
        let shrinkFrom = panel.frame
        let cursor = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(cursor) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let shrinkTo = chatWindowShrinkTargetFrame(centeredOn: cursor, screenVisibleFrame: visible)
        isAnimatingFrame = true // gate fix (F1), shrink leg — bypass the sanitizer's size floor, see its doc
        programmaticMove = true
        startFrameAnimation(from: shrinkFrom, to: shrinkTo, direction: .shrink)
    }

    /// Gate r4 (custom GREEN zoom button): manual zoom toggle, since a borderless window has no
    /// native zoom. First press remembers the current frame (`preZoomFrame`) and fills the screen's
    /// visible frame (inset a touch); second press restores the remembered frame. Instant (not
    /// spring-driven) — a zoom is a discrete state toggle, not a summon choreography; gate feedback
    /// can decide later whether it wants easing. No-op while a grow/shrink is in flight
    /// (`frameAnimTimer != nil`) so it never fights the spring. `programmaticMove` brackets the
    /// `setFrame` so the zoom doesn't pollute `rememberedFrame` (drag memory).
    func zoomToggle() {
        guard let panel, frameAnimTimer == nil else { return }
        let screen = NSScreen.screens.first { $0.frame.intersects(panel.frame) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        programmaticMove = true
        defer { programmaticMove = false }
        if let restore = preZoomFrame {
            preZoomFrame = nil
            panel.setFrame(restore, display: true)
        } else {
            preZoomFrame = panel.frame
            panel.setFrame(visible.insetBy(dx: chatWindowZoomInset, dy: chatWindowZoomInset), display: true)
        }
    }

    // MARK: Frame animation — grow + shrink (manual — see `frameAnimTimer`'s doc for why not `.animator()`)

    private func startFrameAnimation(from start: NSRect, to end: NSRect, direction: FrameAnimDirection) {
        frameAnimDirection = direction
        frameAnimStart = start
        frameAnimTarget = end
        frameAnimProgress = 0
        frameAnimVelocity = 0
        lastFrameAnimTick = CACurrentMediaTime()
        frameAnimTimer?.invalidate()
        frameAnimTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.frameAnimTick() }
        }
    }

    private func frameAnimTick() {
        guard let panel, frameAnimTimer != nil else { return }
        let now = CACurrentMediaTime()
        // Real dt (last-tick timestamp), same clamp range as the core morph — `morphStep` itself
        // clamps to [1/240, 1/20] internally, this is just the raw measurement.
        let dt = now - lastFrameAnimTick
        lastFrameAnimTick = now

        // Gate r6 (close-feel live-gate finding): 140/22 — matches the core orb↔field morph's own
        // default tuning exactly (v1's morph language), replacing the previous 140/18 (ζ≈0.76,
        // a touch softer / more overshoot) that read as slightly too floaty next to it. Passed
        // explicitly (rather than relying on `morphStep`'s defaults) so this call site stays
        // self-documenting even though it now equals `OrbWindowController.morphTick()`'s own
        // call (which omits stiffness/damping and keeps the 140/22 default). Gate r3: the SAME
        // spring drives both `.grow` and `.shrink` — only the endpoints and the settle action differ.
        let (p, v) = morphStep(progress: frameAnimProgress, velocity: frameAnimVelocity, target: 1, dt: dt, stiffness: 140, damping: 22)
        frameAnimProgress = p
        frameAnimVelocity = v

        // Deliberately NOT clamping `p` below 1 — the slight overshoot past 1 IS the organic
        // settle. NOTE: the shared `interpolatedRect` (Orb/MorphGeometry.swift) clamps its own
        // `progress` to [0, 1] internally (matching v1's own identically-clamped helper) — every
        // OTHER caller always feeds it an already-`smoothstep`-bounded value, so that clamp has
        // never been exercised, but it would silently swallow this animation's overshoot outright.
        // A local, unclamped lerp keeps that shared utility's existing contract untouched for its
        // other callers while actually letting the overshoot extrapolate past `frameAnimTarget`,
        // as intended.
        let frame = unclampedInterpolatedRect(from: frameAnimStart, to: frameAnimTarget, progress: p)
        panel.setFrame(frame, display: true)

        let direction = frameAnimDirection

        // Gate r5 — the melt. Only the shrink leg: ramp the snapshot's corner radius toward a circle
        // and dissolve the panel's alpha, then hand off to the orb EARLY so it rematerializes under
        // the last of the fade (see `applyShrinkMelt` and `chatWindowOrbHandoffProgress`).
        if direction == .shrink {
            applyShrinkMelt(progress: p, frameSize: frame.size, panel: panel)
            if !onCloseFired, p >= chatWindowOrbHandoffProgress {
                onCloseFiredAtProgressForTesting = p
                fireOnCloseOnce() // orb returns at the cursor; the last ~30% of the circle melts over it
            }
        }

        // Settle guard — same epsilon as the core morph (Fix A).
        if abs(1 - p) < 0.004, abs(v) < 0.05 {
            panel.setFrame(frameAnimTarget, display: true)
            if direction == .shrink {
                // Gate r5: snap the final melt state too, so the last on-screen frame is the orb
                // circle at ~0 alpha (no opaque square left to blink away) before teardown.
                applyShrinkMelt(progress: 1, frameSize: frameAnimTarget.size, panel: panel)
                // Gate r4 regression seam, gate r5: the real on-screen frame the shrink REACHED,
                // captured before teardown nils the panel — now orb-BUBBLE-sized (~20×20), not the
                // 240×140 panel.
                lastShrinkSettledFrameForTesting = panel.frame
            }
            cancelFrameAnimation()
            // Gate r3 (W1) / gate r5: the shrink's whole point is to lead into teardown — run the
            // same instant, idempotent `close()` now that the circle has settled and dissolved.
            // `onClose` already fired at the 0.7 handoff, so this teardown does orderOut + panel=nil
            // + externalFocus restore WITHOUT re-firing it (the latch). The grow has nothing further
            // to do (self-drawn borderless — no chrome to attach or fade in).
            if direction == .shrink { close() }
        }
    }

    /// Gate r5: the visual melt applied each shrink tick. Ramps the snapshot layer's `cornerRadius`
    /// from `chatWindowCornerRadius` (26pt — gate r6) up to half the CURRENT frame's smaller dimension — so it
    /// becomes a true circle as the frame converges on the ~20pt orb-bubble square — and dissolves
    /// the whole panel (content + shadow) via `alphaValue`: held at 1.0 until
    /// `chatWindowShrinkAlphaHoldProgress`, then eased to ~0 by settle. `masksToBounds` was set true
    /// at snapshot install so the corner radius actually clips.
    private func applyShrinkMelt(progress p: Double, frameSize: NSSize, panel: ChatWindowPanel) {
        let clamped = min(max(p, 0), 1)
        let minHalf = min(frameSize.width, frameSize.height) / 2
        let eased = smoothstep(0, 1, clamped)
        let ramped = chatWindowCornerRadius + (minHalf - chatWindowCornerRadius) * CGFloat(eased)
        let radius = max(0, min(ramped, minHalf)) // never exceed a circle for the current size
        shrinkSnapshotView?.layer?.cornerRadius = radius
        lastShrinkCornerRadiusForTesting = radius

        if clamped <= chatWindowShrinkAlphaHoldProgress {
            panel.alphaValue = 1.0
        } else {
            let a = (clamped - chatWindowShrinkAlphaHoldProgress) / (1.0 - chatWindowShrinkAlphaHoldProgress)
            panel.alphaValue = max(0, 1.0 - a)
        }
    }

    /// Gate r5: freeze the live SwiftUI content to a bitmap and swap it in as an `NSImageView`, so
    /// the shrink animates a scalable image instead of collapsing the real composer/header layout.
    /// `.scaleAxesIndependently` lets the near-square orb frame squish the content without letterbox
    /// gaps; `wantsLayer`/`masksToBounds` give `applyShrinkMelt` a layer whose `cornerRadius` clips
    /// to a circle. No-op (leaves the live view in place, animated as-is) if the content has no
    /// drawable bounds or the bitmap can't be cached — never fatal.
    private func installShrinkSnapshot() {
        guard let panel, let content = panel.contentView else { return }
        let bounds = content.bounds
        guard bounds.width > 1, bounds.height > 1,
              let rep = content.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        content.cacheDisplay(in: bounds, to: rep)
        let image = NSImage(size: bounds.size)
        image.addRepresentation(rep)

        let imageView = NSImageView(frame: bounds)
        imageView.image = image
        imageView.imageScaling = .scaleAxesIndependently
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.masksToBounds = true
        imageView.layer?.cornerRadius = chatWindowCornerRadius
        imageView.autoresizingMask = [.width, .height]
        panel.contentView = imageView
        shrinkSnapshotView = imageView
    }

    private func cancelFrameAnimation() {
        frameAnimTimer?.invalidate()
        frameAnimTimer = nil
        programmaticMove = false
        isAnimatingFrame = false // gate fix (F1): re-arm the sanitizer's size floor for real user/system frame changes
    }

    // MARK: NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        guard !programmaticMove, let frame = panel?.frame else { return }
        rememberedFrame = frame
    }

    /// `.resizable` (kept in the borderless mask) fires `windowDidResize`, not `windowDidMove`, on a
    /// user edge-drag — mirrors `windowDidMove`'s exact programmatic-move guard so a resize driven
    /// by the grow/shrink animation, `chatWindowTargetFrame`, or `zoomToggle()` never pollutes
    /// `rememberedFrame`, only a real user drag does. (Whether borderless windows actually get a
    /// native edge-drag on this OS is a live-gate question — see the report; the guard is correct
    /// regardless.)
    func windowDidResize(_ notification: Notification) {
        guard !programmaticMove, let frame = panel?.frame else { return }
        rememberedFrame = frame
    }

    /// Gate r4 (self-drawn window): with no `.closable`/`.titled` chrome, AppKit no longer calls
    /// this — closing is driven by our own red/yellow traffic lights (→ `closeAnimated()`), Esc, and
    /// the summon toggle. Kept as a harmless safety net: if anything ever does invoke it, route
    /// through our animated teardown and refuse AppKit's own close (`return false`). `closeAnimated()`
    /// (idempotent via `isShrinking`) and `close()` (guards `panel` already nil) mean it can never
    /// double-fire `onClose`.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeAnimated()
        return false
    }

    /// Test seam for the drag-memory rule (unit tests can't synthesize a real user drag).
    func noteUserMovedWindowForTesting(to frame: NSRect) {
        rememberedFrame = frame
    }
}

/// Fix D support: the same linear rect lerp as `interpolatedRect` (`Orb/MorphGeometry.swift`),
/// minus that helper's own `progress` clamp to `[0, 1]` — see `frameAnimTick()`'s doc for why the
/// grow/shrink's spring-driven overshoot (`progress` briefly > 1) needs an UNclamped lerp to
/// actually extrapolate the frame past `frameAnimTarget`, while every other caller of the shared,
/// clamped helper is unaffected.
private func unclampedInterpolatedRect(from start: CGRect, to end: CGRect, progress: Double) -> CGRect {
    let t = CGFloat(progress)
    return CGRect(
        x: start.minX + (end.minX - start.minX) * t,
        y: start.minY + (end.minY - start.minY) * t,
        width: start.width + (end.width - start.width) * t,
        height: start.height + (end.height - start.height) * t
    )
}
