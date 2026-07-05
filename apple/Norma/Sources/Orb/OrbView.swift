import SwiftUI

/// v1 BlueOrb port (PointerRenderer.swift) — AppState → SessionModel, presentationMode →
/// session.state.status.pillText. v1's GlassSurface modifier (field-only, ports in 2c) is
/// replaced here with a plain `.glassEffect` capsule for the pills.
///
/// Wave 2 (v1 morph+follow engine): the orb no longer sits dead-center of its own small
/// window — the panel is now always `FieldMetrics.size`, and the orb circle is pinned at the
/// glass anchor corner (`OrbMetrics.anchorRect`, top-left of the panel — the SAME corner the
/// tracking spring keeps under the cursor). It fades OUT as `FieldView`'s composer shell fades
/// in over the SAME progress band, both views permanently present in `GlassRootView`'s
/// ZStack — no more `if surface` insertion/removal.
struct OrbView: View {
    @ObservedObject var session: SessionModel
    /// Shared with `GlassRootView`'s single `GlassEffectContainer` (D8): the orb circle and
    /// the field's composer shell both tag `glassEffectID("norma-shell", in: glassNamespace)`
    /// so the glass unifies them as the lerp positions each — instead of cross-fading as
    /// separate, unrelated shapes.
    var glassNamespace: Namespace.ID
    /// `morphModel.progress`, injected rather than observed directly — `GlassRootView` owns
    /// the `@ObservedObject` subscription (D8/point 4: rendering off `morphModel.progress`).
    var progress: Double
    @State private var shimmer = 0.0

    private var pillText: String? {
        let state = session.state
        if state.status == .thinking, state.taskCounts.total > 0 {
            return workingPillText(done: state.taskCounts.done, total: state.taskCounts.total)
        }
        return state.status.pillText
    }

    /// v1's crossfade band, simplified to one for our two-surface model (no side-glass/nav
    /// pill/image-row staggering to reproduce): the orb fades OUT as the field fades IN,
    /// meeting at the midpoint.
    private var orbOpacity: Double { 1 - smoothstep(0.3, 0.7, progress) }

    var body: some View {
        // Orb pinned at the panel's glass-anchor corner (top-left, OrbMetrics.anchorRect) —
        // GlassRootView's ZStack(alignment: .topLeading) places it there with no extra offset.
        // Pills hang off via overlays; overlay content doesn't participate in layout.
        orbView
            .overlay(alignment: .leading) {
                // v1 LAW (PointerRenderer.swift:28-39): the spring animation lives INSIDE
                // this Group — on the outer view it steals the transaction from the
                // repeatForever shimmer and freezes it.
                Group {
                    if let text = pillText {
                        statusPill(text)
                            .fixedSize()
                            .offset(x: OrbMetrics.orbDiameter + 4) // past the orb's trailing edge
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                }
                .animation(.spring(response: 0.32, dampingFraction: 0.78), value: pillText)
            }
            .frame(width: OrbMetrics.orbDiameter, height: OrbMetrics.orbDiameter, alignment: .topLeading)
            .opacity(orbOpacity)
            .allowsHitTesting(orbOpacity > 0.5)
            // v1 LAW: no .drawingGroup() — rasterizing freezes the shimmer (PointerRenderer.swift:56-60).
            .onAppear {
                withAnimation(.linear(duration: 1.8).repeatForever(autoreverses: false)) {
                    shimmer = 1.0
                }
            }
    }

    private var orbView: some View {
        ZStack {
            LiquidGlassOrbSurface(glassNamespace: glassNamespace)
                .frame(width: 20, height: 20)
        }
        .frame(width: OrbMetrics.orbDiameter, height: OrbMetrics.orbDiameter)
    }

    /// v1 thinking pill with the sweeping sheen, generalized to any status text.
    private func statusPill(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.primary)
            .overlay(
                GeometryReader { proxy in
                    let w = proxy.size.width
                    LinearGradient(
                        colors: [.clear, .white.opacity(0.85), .clear],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: w * 0.55)
                    .offset(x: -w * 0.55 + w * 1.1 * shimmer)
                    .blendMode(.plusLighter)
                }
                .mask(Text(text).font(.system(size: 11, weight: .medium)))
            )
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.5), lineWidth: 1)) // v1 family hairline
            .clipShape(Capsule())
            .fixedSize()
    }
}

/// v1 orb glass (PointerRenderer.swift:125-140) — blue-neutral system glass, NO tint.
struct LiquidGlassOrbSurface: View {
    var drawsBorder: Bool = true
    var glassNamespace: Namespace.ID

    var body: some View {
        Circle()
            .fill(.clear)
            .glassEffect(.regular, in: Circle())
            .glassEffectID("norma-shell", in: glassNamespace)
            .glassEffectTransition(.matchedGeometry)
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(drawsBorder ? 0.5 : 0), lineWidth: drawsBorder ? 1 : 0)
            )
    }
}
