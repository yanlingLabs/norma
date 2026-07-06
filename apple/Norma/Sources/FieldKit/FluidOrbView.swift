import SwiftUI

/// Task 3 (fluid orb): the liquid rendered inside the orb bubble — a `Canvas`-drawn fill whose
/// surface tilts with cursor motion and ripples with excitement (`Orb/FluidSim.swift`, Task 1's
/// pure physics), tinted `workingTint` while the agent is working and `unreadTint` while a
/// finished reply sits unread. Mounted ONLY while fluid is visible
/// (`NormaFieldView`'s `adapter.fluidState != .idle || morph.fluid.level > 0.01`) — this view's
/// own `TimelineView` tick stops entirely the instant it unmounts (D9: idle = zero draw cost;
/// this is what replaces the always-animating breathing/glow halo view, deleted this task).
///
/// TICK MECHANISM (per the task-3 brief's open question — two candidates were on the table):
/// (a) read `timeline.date` directly inside the `Canvas` drawing closure and step the sim there,
/// or (b) attach `.onChange(of: timeline.date)` to the `Canvas` and step there instead. Went with
/// (b), matching the brief's own sketch. Reasoning: `Canvas`'s content closure is a pure
/// `(inout GraphicsContext, CGSize) -> Void` draw callback invoked mid-render — mutating
/// `@Published` state from inside it is the textbook "modifying state during view update"
/// anti-pattern SwiftUI's runtime purple-warns about (and risks re-entrant/AttributeGraph-cycle
/// behavior, since the mutation would itself invalidate the view being rendered). `.onChange`
/// callbacks, by contrast, run as a view-update SIDE EFFECT (same category as `.onAppear`/
/// `.task`/`.onReceive`) — an approved place to mutate observable state. Verified live (see the
/// task-3 report): `TimelineView(.animation)` re-invokes its content closure — and therefore
/// re-diffs this `Canvas` + `.onChange` pair — every frame while mounted, so `.onChange` fires
/// once per rendered frame; `OrbDebug` logging at the `step()` call site showed ticks landing at
/// ~60/s while `.working`, and the view stops ticking entirely once unmounted (confirmed via the
/// same log going silent).
struct FluidOrbView: View {
    @ObservedObject var morph: MorphModel
    /// Almost always `.working`/`.unread` — `NormaFieldView` keeps this view mounted for one
    /// beat after the state itself goes idle (draining `targetLevel` to 0) rather than switching
    /// to passing `.idle` here; `step(at:)` below still handles `.idle` defensively (target 0)
    /// since `FluidState` is a plain value the caller could in principle pass either way.
    let state: FluidState

    /// Norma blue — the working tint (task-level fill while a turn is running). A literal,
    /// undistorted color: this view renders OUTSIDE `GlassForegroundLegibility`'s difference
    /// blend (see `NormaFieldView.composerMorphedContent`), so what's declared here is exactly
    /// what's drawn.
    private static let workingTint = Color(red: 0.35, green: 0.62, blue: 1.0)
    /// Warm amber — the unread tint (a finished reply is waiting, unseen). Replaces wave-3's
    /// unread-blink overlay pulse; the amber fluid itself IS the unread signal now.
    private static let unreadTint = Color(red: 1.0, green: 0.72, blue: 0.30)

    /// Wall-clock time of the previous tick — `step(at:)` advances by REAL elapsed time between
    /// ticks (not an assumed 1/60 frame rate), so the on-screen liquid tracks the display's
    /// actual refresh cadence. `nil` on the very first tick after mount (no previous sample to
    /// diff against): falls back to a nominal 1/60 there, itself well inside
    /// `FluidSim.step(dt:)`'s own [1/240, 1/20] internal clamp, so it's a safe no-op default
    /// rather than a magic frame-rate assumption driving every subsequent tick.
    @State private var lastTick: Date?

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { ctx, size in
                let sim = morph.fluid
                guard sim.level > 0.005 else { return }
                let r = min(size.width, size.height) / 2
                var path = Path()
                // Surface line across the bubble, in bubble coordinates.
                let surfaceY = size.height * (1 - sim.level)
                let steps = 24
                path.move(to: CGPoint(x: 0, y: size.height))
                path.addLine(to: CGPoint(x: 0, y: surfaceY + r * sim.surfaceOffset(atX: -1)))
                for i in 1...steps {
                    let x = Double(i) / Double(steps) * 2 - 1 // -1...1
                    let px = (x + 1) / 2 * size.width
                    let py = surfaceY + r * sim.surfaceOffset(atX: x)
                    path.addLine(to: CGPoint(x: px, y: py))
                }
                path.addLine(to: CGPoint(x: size.width, y: size.height))
                path.closeSubpath()
                ctx.fill(path, with: .linearGradient(
                    Gradient(colors: [tint.opacity(0.85), tint.opacity(0.55)]),
                    startPoint: CGPoint(x: size.width / 2, y: surfaceY),
                    endPoint: CGPoint(x: size.width / 2, y: size.height)
                ))
            }
            .onChange(of: timeline.date) { _, newDate in
                step(at: newDate)
            }
        }
        .clipShape(Circle())
        .allowsHitTesting(false)
    }

    private var tint: Color {
        switch state {
        case .unread: return Self.unreadTint
        default: return Self.workingTint
        }
    }

    private func step(at now: Date) {
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60.0)
        lastTick = now

        let target: Double
        var acceleration = morph.fluidAcceleration
        switch state {
        case .working(let level):
            target = max(0.15, level) // never invisible while working
        case .unread(let level):
            target = max(0.15, level)
            // Unread breathing: the cursor (and therefore the real tracking-spring acceleration)
            // is usually sitting still while a reply waits unread, so without this the liquid
            // would freeze flat. A tiny synthetic lateral wobble keeps it gently alive —
            // `Date()`/wall-clock time is fine HERE (view-layer ambiance); the pure sim
            // (`Orb/FluidSim.swift`) never touches wall-clock time itself.
            let t = Date().timeIntervalSinceReferenceDate
            acceleration.dx += sin(t * 1.5) * 30
        case .idle:
            target = 0 // draining — see `state`'s doc
        }
        morph.fluid = morph.fluid.step(dt: dt, acceleration: acceleration, targetLevel: target)
        OrbDebug.log("FluidOrbView.step dt=\(String(format: "%.4f", dt)) level=\(String(format: "%.3f", morph.fluid.level)) target=\(String(format: "%.2f", target))")
    }
}
