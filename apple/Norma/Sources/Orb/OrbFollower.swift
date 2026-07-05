import AppKit
import QuartzCore

/// Cursor-following spring driver. Wave 2 (v1 morph+follow engine) repurposed this to drive the
/// WINDOW ORIGIN of the orb/field panel, using `.tracking` (v1 GlassFieldWindow.swift:1950-1975).
/// Task B (v1 field transplant, window choreography + edge fence): the panel is no longer a
/// single fixed size — it's `morphModel.collapsedWindowSize` (240×140) while
/// `OrbWindowController.surface == .orb` and `morphModel.windowSize` (480×440) while `== .field`
/// (`isExpanded` below mirrors that exactly, set by the controller at the same instants it
/// actually resizes the panel) — so the target-origin math now goes through `FieldCorner`
/// (always `.topLeft`, per user directive) instead of the old fixed-size `fieldFrame` clamp.
/// EDGE FENCE (replaces v1's per-corner switching, `FieldCorner.choose`): the raw anchor (cursor
/// + baseOffset, or a sticky magnetic target) is fenced by `fenceAnchorForTopLeftCorner` so the
/// EXPANDED frame always fits on-screen from wherever the anchor ends up, even while collapsed —
/// the orb visibly stops at the fence while the cursor keeps going past it, v1's "pin" behavior.
/// ONE display-link loop total; it runs THROUGHOUT both surfaces (the "always-following" panel),
/// not just while collapsed. v1 differences kept from wave 1: (1) Timer → CADisplayLink with a
/// 30-120 preferred range, PAUSED when settled (D9: 0 fps); (2) commandedTarget (agent
/// move_pointer) not ported — Phase 5 (see phase-2-carryover.md).
@MainActor
final class OrbFollower {
    private let cursorTracker = CursorTracker()
    private let morphModel: MorphModel
    private var link: CADisplayLink?
    private var lastUpdate = CACurrentMediaTime()
    private var spring = SpringState(position: .zero, velocity: .zero)
    private var magneticTarget: CGPoint?
    private var lastPublished = CGPoint(x: CGFloat.greatestFiniteMagnitude, y: CGFloat.greatestFiniteMagnitude)
    private let baseOffset = CGPoint(x: 24, y: -24) // v1
    private let config = SpringConfig.tracking
    private var lastCursorSampleTime = CACurrentMediaTime()
    /// Wave-3 gate item 2b: gates the answer-arrival auto-expand — see `CursorCalmTracker`'s doc
    /// and `isCursorCalm(at:)` below.
    private var calmTracker = CursorCalmTracker()

    /// Mirrors `OrbWindowController.surface == .field`: `true` from the instant an expand STARTS
    /// (before the panel even resizes) until a collapse fully SETTLES — exactly when the real
    /// AppKit panel is actually sized `morphModel.windowSize` rather than
    /// `morphModel.collapsedWindowSize`. The follower only ever calls `setFrameOrigin` (it never
    /// resizes the panel itself), so it must always target the origin math for whichever size
    /// the panel ACTUALLY is right now, or the two would fight every frame.
    var isExpanded = false

    var onCursorLocationChange: ((CGPoint) -> Void)?
    /// Renamed from wave 1's `onOrbCenterChange`: the published value is now the panel's
    /// window origin, not an orb center.
    var onWindowOriginChange: ((CGPoint) -> Void)?
    /// v1 fast-flick (GlassFieldWindow.swift:1584-1597): fires on every raw cursor sample whose
    /// dt-normalized speed or displacement clears `shouldCollapseFastFlick`'s thresholds. The
    /// controller wires this to `collapseToOrb()`, which is already a guarded no-op while the
    /// field isn't expanded — so this fires unconditionally and lets the guard decide.
    var onFastFlick: (() -> Void)?
    private(set) var cursorLocation = NSEvent.mouseLocation
    var currentWindowOrigin: CGPoint { spring.position }

    init(morphModel: MorphModel) {
        self.morphModel = morphModel
    }

    /// Snaps the tracking spring directly onto `origin` with zero velocity — called by the
    /// controller right after it manually resizes the panel (`expandToField()`/
    /// `finishCollapse()`) so the spring doesn't visibly "catch up" from its pre-resize position
    /// on the next tick. v1 parity: `show()`/`showCollapsedOrb()`/`settleCollapsedOrb()` all
    /// reset `originPos`/`targetOrigin`/`velocity` the same way (GlassFieldWindow.swift:
    /// 581-583/742-746/1504-1506).
    func snapWindowOrigin(to origin: CGPoint) {
        spring = SpringState(position: origin, velocity: .zero)
        lastPublished = origin
    }

    func start() {
        guard link == nil else { return }
        cursorTracker.onLocationChange = { [weak self] location in
            guard let self else { return }
            let previous = cursorLocation
            let now = CACurrentMediaTime()
            let dt = max(now - lastCursorSampleTime, 0.001)
            let displacement = hypot(location.x - previous.x, location.y - previous.y)
            let speed = displacement / dt

            cursorLocation = location
            lastCursorSampleTime = now
            calmTracker.record(speed: speed, at: now)

            // Fast-flick: don't bail before updating state above — the tracking spring's
            // target is computed fresh from `cursorLocation` every tick, so simply having
            // updated it here already satisfies v1's "still forward the cursor into the
            // tracking spring" rule (the ghost-circle fix) with no extra bookkeeping.
            if shouldCollapseFastFlick(speed: speed, displacement: displacement) {
                onFastFlick?()
            }

            onCursorLocationChange?(location)
            wake()
        }
        cursorTracker.start()

        cursorLocation = NSEvent.mouseLocation
        lastCursorSampleTime = CACurrentMediaTime()
        spring = SpringState(position: targetOrigin(), velocity: .zero)
        publish(spring.position)

        let l = (NSScreen.main ?? NSScreen.screens[0]).displayLink(target: self, selector: #selector(tick))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
        lastUpdate = CACurrentMediaTime()
    }

    func stop() {
        link?.invalidate()
        link = nil
        cursorTracker.stop()
        spring.velocity = .zero
        magneticTarget = nil
        lastPublished = CGPoint(x: CGFloat.greatestFiniteMagnitude, y: CGFloat.greatestFiniteMagnitude)
        calmTracker = CursorCalmTracker()
    }

    /// Wave-3 gate item 2b: "has the cursor been calm (no fast movement) for the last ~0.4s?" —
    /// `GlassRootView` checks this the instant a turn completes with a reply, deciding between
    /// auto-expanding into the answer (calm) or marking the collapsed orb unread instead (not
    /// calm — an unsolicited expand would visually snap open under a moving cursor).
    func isCursorCalm(at time: TimeInterval = CACurrentMediaTime()) -> Bool {
        calmTracker.isCalm(at: time)
    }

    /// Stickiness (Task 7) publishes its sticky element center here; nil clears it. Treated as
    /// the glass anchor DIRECTLY (no cursor offset added) — same contract as wave 1 had for the
    /// orb-center spring.
    func setMagneticTarget(_ point: CGPoint?) {
        magneticTarget = point
        wake()
    }

    @objc private func tick() {
        let now = CACurrentMediaTime()
        let dt = now - lastUpdate
        lastUpdate = now

        let (next, tier) = springStep(spring, target: targetOrigin(), dt: dt, config: config)
        spring = next
        publish(spring.position)

        switch tier {
        case .settled:
            link?.isPaused = true // D9: 0 fps until the next wake()
        case .glide:
            link?.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 30, preferred: 30)
        case .active:
            link?.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        }
    }

    private func wake() {
        guard let link else { return }
        if link.isPaused {
            lastUpdate = CACurrentMediaTime() // don't integrate the paused gap
            link.isPaused = false
        }
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
    }

    /// The tracking spring's target: the glass anchor (magnetic target, or cursor + baseOffset),
    /// fenced so the ACTIVE frame (whichever size the panel is currently sized to —
    /// `collapsedWindowSize` while `.orb`, `windowSize` while `.field`) always fits on-screen
    /// (`fenceAnchorForTopLeftCorner` — replaces v1's per-corner switching), then mapped to a
    /// window origin via `FieldCorner` (always `.topLeft`).
    ///
    /// GATE-3 FIX (F1): this used to fence against `morphModel.windowSize` (the EXPANDED
    /// 480×440 frame) UNCONDITIONALLY, even while collapsed. Because `.topLeft`'s anchor sits
    /// near the WINDOW'S TOP with the frame growing ~338pt downward from it (`haloPadding` +
    /// `navOffset` above, the rest below — see `fenceAnchorForTopLeftCorner`'s own derivation),
    /// that fence forced `anchor.y >= bounds.minY + 338` at all times — a constraint sized for
    /// the 440pt-tall expanded frame, not the 140pt-tall collapsed one. The COLLAPSED orb was
    /// therefore clamped out of roughly the bottom third of every screen regardless of cursor
    /// position: it rode too high and never followed the cursor down into that band (measured:
    /// on expand the fence is correctly protective; while merely collapsed it was needlessly
    /// fencing against a frame size the panel isn't even using). Fencing against `activeSize`
    /// instead lets the collapsed orb track the cursor almost anywhere on screen (only a small
    /// ~38pt margin near the very edges, sized to the ACTUAL 140pt-tall collapsed frame), while
    /// still fully protecting the expanded field once `isExpanded` flips true.
    private func targetOrigin() -> CGPoint {
        let activeSize = isExpanded ? morphModel.windowSize : morphModel.collapsedWindowSize
        return followerTargetOrigin(
            cursorLocation: cursorLocation,
            magneticTarget: magneticTarget,
            baseOffset: baseOffset,
            activeSize: activeSize,
            morphModel: morphModel,
            visibleFrame: currentVisibleFrame()
        )
    }

    /// The visible frame of whichever screen currently contains the cursor — v1 resolved the
    /// clamp screen the same cursor-relative way (FieldCorner.choose's screenFrame lookup).
    private func currentVisibleFrame() -> CGRect {
        let screen = NSScreen.screens.first { $0.frame.contains(cursorLocation) } ?? NSScreen.main ?? NSScreen.screens.first
        return screen?.visibleFrame ?? .zero
    }

    private func publish(_ point: CGPoint) {
        if hypot(point.x - lastPublished.x, point.y - lastPublished.y) < 0.25 { return } // v1 threshold
        lastPublished = point
        onWindowOriginChange?(point)
    }
}

/// PURE extraction of `OrbFollower.targetOrigin()`'s math (gate-3 fix F1) — no CADisplayLink, no
/// live cursor tracker, no screen enumeration beyond the passed-in `visibleFrame` — so the
/// corrected fence-sizing behavior (fence against `activeSize`, not always the expanded frame)
/// has direct unit coverage without needing a running app/display link.
@MainActor
func followerTargetOrigin(
    cursorLocation: CGPoint,
    magneticTarget: CGPoint?,
    baseOffset: CGPoint,
    activeSize: CGSize,
    morphModel: MorphModel,
    visibleFrame: CGRect
) -> CGPoint {
    let raw = magneticTarget ?? CGPoint(x: cursorLocation.x + baseOffset.x, y: cursorLocation.y + baseOffset.y)
    let anchor = fenceAnchorForTopLeftCorner(
        raw,
        expandedSize: activeSize,
        haloPadding: morphModel.haloPadding,
        navOffset: morphModel.navPillHeight + morphModel.interPillGap,
        visibleFrame: visibleFrame
    )
    return morphModel.corner.windowOrigin(
        glassAnchor: anchor,
        morph: morphModel,
        windowSize: activeSize,
        surface: .composer
    )
}
