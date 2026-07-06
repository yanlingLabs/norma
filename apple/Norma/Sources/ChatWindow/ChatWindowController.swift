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
    /// spring (`morphStep`, `Orb/SpringStep.swift`) driving a plain 0→1 scalar, at 140/18 (ζ≈0.76
    /// — a touch softer than the core orb↔field morph's own 140/22, landing a slightly larger
    /// ~2-3% overshoot: the "organic settle" sweet spot for a window growing into place, vs. the
    /// tighter liquid-merge bounce the small glass shape wants).
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
    /// this to bypass its normal 340×360 size floor while true — the grow's source (and the
    /// shrink's TARGET) is the COLLAPSED ORB's small panel size (`chatWindowCollapsedSize`,
    /// mirroring `OrbWindowController.finishCollapse()`'s ~240×140), which the floor would
    /// otherwise inflate to 340×360, killing the "grows from / shrinks to a tiny circle" effect
    /// both this fix and W1 exist to restore. Position still gets clamped on-screen throughout
    /// (see `clampedChatWindowPosition`) — only the size floor is bypassed. Set true right before
    /// each animation's first frame, cleared in `cancelFrameAnimation()` (both directions' natural
    /// t>=1 finish and `close()`'s mid-flight cancel), same lifecycle as `programmaticMove`.
    private var isAnimatingFrame = false

    /// Gate r4 regression seam (window shrink stall fix): the true on-screen frame the close-shrink
    /// actually REACHED at settle, captured right before teardown. Tests assert this landed at orb
    /// size (`chatWindowCollapsedSize`, ~240×140) — proving the shrink reaches its target instead of
    /// stalling. With the window now borderless for life (no titled/toolbar chrome minimum to clamp
    /// the small frames — the class of bug the r4-draft chrome-strip existed to work around) this
    /// passes trivially; it stays as a permanent guard against any future chrome/minimum regression.
    /// nil until a shrink has settled.
    private(set) var lastShrinkSettledFrameForTesting: NSRect?

    /// Gate r4 (custom green zoom button): the frame to restore to when the manual zoom toggle is
    /// pressed a second time. nil = not currently zoomed. Kept separate from `rememberedFrame`
    /// (drag memory) on purpose — a zoom is a transient toggle, not a new remembered home.
    private var preZoomFrame: NSRect?

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
        let screen = NSScreen.screens.first { $0.frame.intersects(sourceFrame) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let target = chatWindowTargetFrame(
            sourceFrame: sourceFrame, remembered: rememberedFrame,
            screenVisibleFrame: visible, defaultSize: chatWindowDefaultSize
        )

        // Panel construction: v1 transplant (InteractionController.swift:849-877), with
        // v2's orb collectionBehavior (adds .canJoinAllSpaces — proven above-fullscreen).
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
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
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
        externalFocus?.restore()
        externalFocus = nil
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
    func closeAnimated() {
        guard let panel else { return }
        guard !isShrinking else { return }
        cancelFrameAnimation() // stop any in-flight GROW — state only, frame is left exactly where it was
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

        // Fix D (anim-fidelity restore): 140/18 (ζ≈0.76) — a touch softer than the core
        // orb↔field morph's own 140/22, landing a slightly larger ~2-3% overshoot: the
        // conservative "organic settle" sweet spot for a window growing into (or shrinking out
        // of) place, as opposed to the tighter liquid-merge bounce the small glass shape wants.
        // Does NOT touch `morphStep`'s own call site in `OrbWindowController.morphTick()` (that
        // call omits stiffness/damping, so it keeps the default 140/22). Gate r3: the SAME spring
        // now drives both `.grow` and `.shrink` — only the endpoints and the settle action differ.
        let (p, v) = morphStep(progress: frameAnimProgress, velocity: frameAnimVelocity, target: 1, dt: dt, stiffness: 140, damping: 18)
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

        // Settle guard — same epsilon as the core morph (Fix A).
        if abs(1 - p) < 0.004, abs(v) < 0.05 {
            panel.setFrame(frameAnimTarget, display: true)
            let direction = frameAnimDirection
            if direction == .shrink {
                // Gate r4 regression seam: the real on-screen frame the shrink REACHED, captured
                // before teardown nils the panel — tests assert this is orb-sized (~240×140).
                lastShrinkSettledFrameForTesting = panel.frame
            }
            cancelFrameAnimation()
            // Gate r3 (W1): the shrink's whole point is to lead into teardown — run the exact
            // same instant, idempotent `close()` now that the panel has visibly settled at the
            // cursor. The grow has nothing further to do (the window is self-drawn borderless — no
            // chrome to attach or fade in).
            if direction == .shrink { close() }
        }
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
