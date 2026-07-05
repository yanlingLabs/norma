import AppKit
import QuartzCore

/// Cursor-following spring driver. Wave 2 (v1 morph+follow engine) repurposes this: the spring
/// no longer drives an "orb center" for a small orb-sized window — it drives the WINDOW ORIGIN
/// of the permanently `FieldMetrics.size` panel, using `.tracking` (v1 GlassFieldWindow.swift:
/// 1950-1975). The glass anchor (cursor + (24,-24), or a sticky magnetic target) maps to the
/// panel's top-left corner via `fieldFrame`'s own clamp math — reused verbatim rather than
/// duplicated, since it's the exact same "top-left anchored, grows down-right, clamped inside
/// the visible frame" computation wave 1 already had. ONE display-link loop total; it now runs
/// THROUGHOUT both the orb and field surfaces (the "always-following" panel), not just while
/// collapsed. v1 differences kept from wave 1: (1) Timer → CADisplayLink with a 30-120
/// preferred range, PAUSED when settled (D9: 0 fps); (2) commandedTarget (agent move_pointer)
/// not ported — Phase 5 (see phase-2-carryover.md).
@MainActor
final class OrbFollower {
    private let cursorTracker = CursorTracker()
    private var link: CADisplayLink?
    private var lastUpdate = CACurrentMediaTime()
    private var spring = SpringState(position: .zero, velocity: .zero)
    private var magneticTarget: CGPoint?
    private var lastPublished = CGPoint(x: CGFloat.greatestFiniteMagnitude, y: CGFloat.greatestFiniteMagnitude)
    private let baseOffset = CGPoint(x: 24, y: -24) // v1
    private let config = SpringConfig.tracking
    private var lastCursorSampleTime = CACurrentMediaTime()

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

    /// The tracking spring's target: the glass anchor (magnetic target, or cursor + baseOffset)
    /// mapped to a top-left-anchored, visible-frame-clamped window origin. Reuses `fieldFrame`
    /// (Field/FieldPlacement.swift) rather than re-deriving the same math — `orbCenter` there is
    /// exactly our anchor concept, wave 1 named it before the field could follow continuously.
    private func targetOrigin() -> CGPoint {
        let anchor = magneticTarget ?? CGPoint(x: cursorLocation.x + baseOffset.x, y: cursorLocation.y + baseOffset.y)
        return fieldFrame(orbCenter: anchor, visibleFrame: currentVisibleFrame()).origin
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
