import SwiftUI

/// Task-3 fix wave (review finding, "full-body re-render per tick"): the fluid's own physics state
/// used to live on the SHARED `MorphModel` (`morph.fluid` + `morph.fluidAcceleration`), observed
/// by both this view AND `NormaFieldView` (the whole field body — glass geometry, composer/
/// response content, nav pill…). Since the sim advances on every render tick (~120/s while a turn
/// is active), every one of those `@Published` writes re-ran `NormaFieldView`'s entire body too —
/// a full-body re-render for a change nothing but this bubble needed to see, and a direct
/// violation of this file's own local-animation-state convention (cf. `WorkingSpinnerGlyph`/
/// `SheenText` in `NormaFieldView.swift`, which each scope their own animation state to
/// themselves, never an ancestor). `FluidModel` is a dedicated, narrowly-scoped `ObservableObject`
/// for exactly this state; the only things that ever observe it are `FluidOrbSlot` and
/// `FluidOrbView` below — `NormaFieldView` holds a plain, non-`@ObservedObject` reference just to
/// pass one down (see that file's mount site, and its own new progress-fade comment).
@MainActor
final class FluidModel: ObservableObject {
    /// The fluid orb's own physics state (`Orb/FluidSim.swift`, Task 1) — the render tick (Task 3,
    /// `FluidOrbView.step`) owns advancing this every frame via
    /// `.step(dt:acceleration:targetLevel:)` and reads it back out for the bubble's tilt/wave/level
    /// rendering. Lives here (rather than on the view) so it survives across `FluidOrbView`
    /// remounts, the same reason `MorphModel.progress` etc. live on a model rather than a view.
    @Published var sim: FluidSim = .rest
    /// `OrbFollower`'s per-tick tracking-spring acceleration tap ((velocity − lastVelocity) / dt,
    /// see `OrbFollower.tick()`) — the lateral/vertical "kick" the fluid sim's tilt/wave terms
    /// react to. Written every display-link tick regardless of which surface is showing.
    /// Deliberately NOT `@Published`: `FluidOrbView.step` is the sole reader, and it already reads
    /// `sim` fresh every tick of its own — there is no view left to invalidate by publishing this
    /// too, only wasted Combine traffic on every follower tick (up to 120/s).
    var acceleration: CGVector = .zero
}

/// Task 3 (fluid orb): the liquid rendered inside the orb bubble — a `Canvas`-drawn fill whose
/// surface tilts with cursor motion and ripples with excitement (`Orb/FluidSim.swift`, Task 1's
/// pure physics), tinted `workingTint` while the agent is working and `unreadTint` while a
/// finished reply sits unread. Mounted ONLY while the fluid is visible — `FluidOrbSlot` below is
/// the sole owner of that decision — so this view's own `TimelineView` tick stops entirely the
/// instant it unmounts (D9: idle = zero draw cost; this is what replaces the always-animating
/// breathing/glow halo view, deleted this task).
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
    @ObservedObject var fluid: FluidModel
    /// The turn/unread/idle state driving this tick. `.idle` is passed here on EVERY drain (a turn
    /// finishing, or an unread reply getting cleared) — not a rare defensive corner case: `step
    /// (at:)` below feeds it `targetLevel: 0` for as long as the bubble takes to visibly empty
    /// out, and `FluidOrbSlot` keeps this view mounted for exactly that long (see its own doc).
    let state: FluidState

    /// Interrupt-feedback gate polish: while true, the fluid renders `stoppedTint` regardless of
    /// what `state`/`tint` would otherwise say — a 2s muted beat confirming the Esc-interrupt was
    /// received (`FieldStateAdapter.showStoppedFlash`'s doc). Deliberately checked ONLY inside
    /// `tint` below, never inside `lastTint`'s `.onChange(of: state)` tracker — that tracker keeps
    /// following the REAL state the whole time, so the instant this flag clears (2s later, or on
    /// the next `turn_started`), `tint` falls straight back to whatever `state` actually is
    /// (holding-blue if tasks are still incomplete, amber if unread, or draining) with no stale
    /// slate residue.
    let isStoppedFlash: Bool

    /// Norma blue — the working tint (task-level fill while a turn is running). A literal,
    /// undistorted color: this view renders OUTSIDE `GlassForegroundLegibility`'s difference
    /// blend (see `NormaFieldView.composerMorphedContent`), so what's declared here is exactly
    /// what's drawn.
    ///
    /// Finding-4 (gate 2, "brighter fluid"): bumped noticeably more luminous from
    /// `(0.35, 0.62, 1.0)`. GATE-TUNING KNOB — this + `unreadTint` + the fill-gradient opacities
    /// in `body` are the four constants to nudge if the liquid reads too bright/too dim on device.
    private static let workingTint = Color(red: 0.45, green: 0.75, blue: 1.0)
    /// Warm amber — the unread tint (a finished reply is waiting, unseen). Replaces wave-3's
    /// unread-blink overlay pulse; the amber fluid itself IS the unread signal now.
    ///
    /// Finding-4: brightened from `(1.0, 0.72, 0.30)` (GATE-TUNING KNOB, see `workingTint`).
    private static let unreadTint = Color(red: 1.0, green: 0.80, blue: 0.35)

    /// Interrupt-feedback gate polish: muted, desaturated slate — the "stopped" beat's tint,
    /// deliberately unlike either working-blue or unread-amber so an Esc-interrupt reads as its
    /// own distinct, quieter event rather than a variant of either normal state.
    private static let stoppedTint = Color(red: 0.62, green: 0.66, blue: 0.72)

    /// Task-3 fix wave (review finding, "drain snaps amber → blue"): `FluidState.idle` carries no
    /// color of its own — without this, a dismissed-unread drain would snap the bubble from amber
    /// straight to the (semantically meaningless, for a drain) working blue for its entire
    /// fade-out. Kept current by the `onChange` in `body` below whenever `state` reports an active
    /// (non-`.idle`) tint; the `.idle` branch of `tint` reuses whatever this last held.
    @State private var lastTint: Color = workingTint

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
                let sim = fluid.sim
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
                // Finding-4 (gate 2): raised fill opacities from 0.85/0.55 for a more luminous,
                // less washed-out liquid (GATE-TUNING KNOB — see `workingTint`'s doc).
                ctx.fill(path, with: .linearGradient(
                    Gradient(colors: [tint.opacity(0.95), tint.opacity(0.7)]),
                    startPoint: CGPoint(x: size.width / 2, y: surfaceY),
                    endPoint: CGPoint(x: size.width / 2, y: size.height)
                ))
            }
            .onChange(of: timeline.date) { _, newDate in
                step(at: newDate)
            }
        }
        // Task-3 fix wave: keeps `lastTint` current, including for the very first frame
        // (`initial: true`) so a fresh mount that happens to start on `.unread` (rather than
        // `.working`) doesn't fall back to the wrong default if it drains to `.idle` before ever
        // observing a "change".
        .onChange(of: state, initial: true) { _, newState in
            if let active = Self.activeTint(for: newState) {
                lastTint = active
            }
        }
        .clipShape(Circle())
        .allowsHitTesting(false)
    }

    /// The tint for an active (non-`.idle`) state; `nil` for `.idle`, which carries no color of
    /// its own — see `lastTint`'s doc.
    private static func activeTint(for state: FluidState) -> Color? {
        switch state {
        case .working: return workingTint
        case .unread: return unreadTint
        case .idle: return nil
        }
    }

    private var tint: Color {
        if isStoppedFlash { return Self.stoppedTint }
        return Self.activeTint(for: state) ?? lastTint
    }

    private func step(at now: Date) {
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60.0)
        lastTick = now

        let target: Double
        var acceleration = fluid.acceleration
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
        fluid.sim = fluid.sim.step(dt: dt, acceleration: acceleration, targetLevel: target)
        OrbDebug.log("FluidOrbView.step dt=\(String(format: "%.4f", dt)) level=\(String(format: "%.3f", fluid.sim.level)) target=\(String(format: "%.2f", target))")
    }
}

/// Task-3 fix wave: the ONLY thing that observes `FluidModel` other than `FluidOrbView` itself.
/// `NormaFieldView` mounts this unconditionally (see its call site) and never touches `FluidModel`
/// at all — re-renders of THIS view are driven by `fluid.sim` changing (the ~120Hz tick, while
/// active) and stay fully scoped to this leaf; `NormaFieldView`'s own body never re-runs because
/// of them, which is the whole point of this split (see `FluidModel`'s doc above).
struct FluidOrbSlot: View {
    @ObservedObject var fluid: FluidModel
    let state: FluidState
    /// Interrupt-feedback gate polish: threaded straight through to `FluidOrbView`'s tint override
    /// — this slot's own mount/drain decision below is unchanged by it (still driven purely by
    /// `state`/fill level, per this type's existing doc), since the flash is a TINT beat, not a
    /// visibility one; the common case (Esc mid-turn with incomplete tasks) already holds the
    /// fluid visible via `FluidState.working`, which is what actually carries the flash on screen.
    let isStoppedFlash: Bool

    var body: some View {
        // `state != .idle`: an active turn or an unread reply — always show. The second clause
        // keeps the drain itself VISIBLE after `state` has already gone `.idle` (`FluidOrbView`
        // keeps ticking `targetLevel: 0` — see its doc) instead of hard-cutting to invisible the
        // instant the turn/unread state clears. Once the drain settles under 0.01 this renders
        // `EmptyView()`, which removes `FluidOrbView` — and with it its `TimelineView` — from the
        // tree entirely: no more ticks, no more `@Published` writes, truly quiescent (D9) until
        // the next `.working`/`.unread`.
        if state != .idle || fluid.sim.level > 0.01 {
            FluidOrbView(fluid: fluid, state: state, isStoppedFlash: isStoppedFlash)
        } else {
            EmptyView()
        }
    }
}
