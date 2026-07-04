import AppKit
import QuartzCore

/// Cursor-following spring driver. v1's PointerFollower with two changes:
/// (1) Timer → CADisplayLink with a 30–120 preferred range, PAUSED when settled (D9: 0 fps);
/// (2) commandedTarget (agent move_pointer) not ported — Phase 5 (see phase-2-carryover.md).
@MainActor
final class OrbFollower {
    private let cursorTracker = CursorTracker()
    private var link: CADisplayLink?
    private var lastUpdate = CACurrentMediaTime()
    private var spring = SpringState(position: .zero, velocity: .zero)
    private var magneticTarget: CGPoint?
    private var lastPublished = CGPoint(x: CGFloat.greatestFiniteMagnitude, y: CGFloat.greatestFiniteMagnitude)
    private let baseOffset = CGPoint(x: 24, y: -24) // v1
    private let config = SpringConfig.v1

    var onCursorLocationChange: ((CGPoint) -> Void)?
    var onOrbCenterChange: ((CGPoint) -> Void)?
    private(set) var cursorLocation = NSEvent.mouseLocation
    var currentOrbCenter: CGPoint { spring.position }

    func start() {
        guard link == nil else { return }
        cursorTracker.onLocationChange = { [weak self] location in
            guard let self else { return }
            cursorLocation = location
            onCursorLocationChange?(location)
            wake()
        }
        cursorTracker.start()

        cursorLocation = NSEvent.mouseLocation
        spring = SpringState(position: offsetTarget(), velocity: .zero)
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

    /// Stickiness (Task 7) publishes its sticky element center here; nil clears it.
    func setMagneticTarget(_ point: CGPoint?) {
        magneticTarget = point
        wake()
    }

    @objc private func tick() {
        let now = CACurrentMediaTime()
        let dt = now - lastUpdate
        lastUpdate = now

        let target = magneticTarget ?? offsetTarget()
        let (next, tier) = springStep(spring, target: target, dt: dt, config: config)
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

    private func offsetTarget() -> CGPoint {
        CGPoint(x: cursorLocation.x + baseOffset.x, y: cursorLocation.y + baseOffset.y)
    }

    private func publish(_ point: CGPoint) {
        if hypot(point.x - lastPublished.x, point.y - lastPublished.y) < 0.25 { return } // v1 threshold
        lastPublished = point
        onOrbCenterChange?(point)
    }
}
