import SwiftUI

/// v1 BlueOrb port (PointerRenderer.swift) — AppState → SessionModel, presentationMode →
/// session.state.status.pillText. v1's GlassSurface modifier (field-only, ports in 2c) is
/// replaced here with a plain `.glassEffect` capsule for the pills.
struct OrbView: View {
    @ObservedObject var session: SessionModel
    @State private var shimmer = 0.0

    private var pillText: String? {
        let state = session.state
        if state.status == .thinking, state.taskCounts.total > 0 {
            return workingPillText(done: state.taskCounts.done, total: state.taskCounts.total)
        }
        return state.status.pillText
    }

    var body: some View {
        // Orb DEAD-CENTER of the 260×110 frame (v1 contract — window center == orb center).
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
            .frame(width: OrbMetrics.windowSize.width, height: OrbMetrics.windowSize.height)
            // v1 LAW: no .drawingGroup() — rasterizing freezes the shimmer (PointerRenderer.swift:56-60).
            .onAppear {
                withAnimation(.linear(duration: 1.8).repeatForever(autoreverses: false)) {
                    shimmer = 1.0
                }
            }
    }

    private var orbView: some View {
        ZStack {
            LiquidGlassOrbSurface()
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

    var body: some View {
        Circle()
            .fill(.clear)
            .glassEffect(.regular, in: Circle())
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(drawsBorder ? 0.5 : 0), lineWidth: drawsBorder ? 1 : 0)
            )
    }
}
