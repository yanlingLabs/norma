import Foundation

/// v1's tuned spring constants (PointerFollower.swift:30-34, 161, 178) — the "feel".
struct SpringConfig {
    var stiffness: Double
    var damping: Double
    var snapDistance: CGFloat
    var snapSpeed: CGFloat
    var glideDistance: CGFloat
    var glideSpeed: CGFloat

    static let v1 = SpringConfig(
        stiffness: 120.0, damping: 22.0,
        snapDistance: 0.35, snapSpeed: 18,
        glideDistance: 8, glideSpeed: 80
    )
}

enum SpringTier: Equatable {
    case active   // v1: 1/120 interval
    case glide    // v1: 1/30 interval
    case settled  // NEW (D9): display link pauses — 0 fps
}

struct SpringState: Equatable {
    var position: CGPoint
    var velocity: CGPoint
}

/// One physics step — semantics identical to v1 PointerFollower.step(), extracted pure.
func springStep(_ state: SpringState, target: CGPoint, dt rawDt: TimeInterval, config: SpringConfig) -> (state: SpringState, tier: SpringTier) {
    var s = state
    let dt = max(1.0 / 240.0, min(rawDt, 1.0 / 30.0))

    let dx = target.x - s.position.x
    let dy = target.y - s.position.y
    let distance = hypot(dx, dy)
    let speed = hypot(s.velocity.x, s.velocity.y)
    if distance < config.snapDistance, speed < config.snapSpeed {
        s.position = target
        s.velocity = .zero
        return (s, .settled)
    }

    let ax = config.stiffness * dx - config.damping * s.velocity.x
    let ay = config.stiffness * dy - config.damping * s.velocity.y
    s.velocity.x += ax * dt
    s.velocity.y += ay * dt
    s.position.x += s.velocity.x * dt
    s.position.y += s.velocity.y * dt

    let tier: SpringTier = (distance < config.glideDistance && speed < config.glideSpeed) ? .glide : .active
    return (s, tier)
}
