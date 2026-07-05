import SwiftUI

/// The expanded surface: actions row + composer + streaming reply area. Lives INSIDE
/// `GlassRootView`'s single `GlassEffectContainer` — this view creates no container of its
/// own (D3/D4: exactly one container for the whole orb/field morph).
///
/// Wave 2 (v1 morph+follow engine): this view is now PERMANENTLY in the hierarchy alongside
/// `OrbView` — the discrete `if surface` switch is gone. Every element's geometry/opacity is
/// computed from `progress` (`morphModel.progress`, injected by `GlassRootView`), mirroring
/// v1 GlassFieldView.composerBody's approach (progress-interpolated rects) simplified to our
/// two surfaces: only the composer shell geometrically lerps (from the orb circle's rect at
/// progress 0 to its final in-layout rect at progress 1); the actions row and reply area just
/// fade in over the same crossfade band `OrbView` fades out on, and the composer's own text
/// content reveals a little later still (an empty glass shell still inflating, then the text
/// arrives — v1's "content reveals late" rule, GlassFieldView.swift:335-338).
///
/// Deviation from the brief's literal `FieldView(session:draft:onSubmit:)` signature: the
/// composer shell must carry `.glassEffectID("norma-shell", in:)` tagged with the SAME
/// `Namespace.ID` the orb circle uses (D8 — that's what makes the orb morph into the
/// composer), so this view also takes `glassNamespace: Namespace.ID` from `GlassRootView`, plus
/// `progress: Double` for the geometry/opacity math above.
struct FieldView: View {
    @ObservedObject var session: SessionModel
    @Binding var draft: String
    var glassNamespace: Namespace.ID
    var progress: Double
    var onSubmit: () -> Void

    @State private var shimmer = 0.0

    // MARK: Geometry — fixed final rects (this view's own internal layout, matching the old
    // VStack's 16pt padding / 10pt spacing / single-pill actions row), all top-left anchored
    // like `OrbMetrics.anchorRect` and `FieldMetrics` (the "grows down-right" law).

    private var actionsRowFinalRect: CGRect {
        CGRect(x: 16, y: 16, width: FieldMetrics.size.width - 32, height: 24)
    }

    private var composerFinalRect: CGRect {
        CGRect(x: 16, y: actionsRowFinalRect.maxY + 10, width: FieldMetrics.size.width - 32, height: 38)
    }

    private var replyFinalRect: CGRect {
        let top = composerFinalRect.maxY + 10
        return CGRect(x: 16, y: top, width: FieldMetrics.size.width - 32, height: FieldMetrics.size.height - top - 16)
    }

    /// The composer shell's rect lerps from the orb circle's rect (progress 0, same corner
    /// both views share) to its final in-layout rect (progress 1) — the ONLY element that
    /// geometrically travels; everything else just fades in place.
    private var composerShellRect: CGRect {
        interpolatedRect(from: OrbMetrics.anchorRect, to: composerFinalRect, progress: progress)
    }

    /// v1's 0.3…0.7 crossfade band — the SAME band `OrbView.orbOpacity` fades out on, so the
    /// two views meet at the midpoint instead of visibly gapping or double-exposing.
    private var fieldReveal: Double { smoothstep(0.3, 0.7, progress) }
    /// v1's later "content reveals last" band (GlassFieldView.swift:338): the composer's own
    /// text content waits until the shell has mostly finished growing.
    private var contentReveal: Double { smoothstep(0.45, 0.74, progress) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            actionsRow
                .frame(width: actionsRowFinalRect.width, height: actionsRowFinalRect.height, alignment: .leading)
                .position(x: actionsRowFinalRect.midX, y: actionsRowFinalRect.midY)
                .opacity(fieldReveal)
                .allowsHitTesting(fieldReveal > 0.5)

            composer
                .frame(width: composerShellRect.width, height: composerShellRect.height)
                .position(x: composerShellRect.midX, y: composerShellRect.midY)

            replyArea
                .frame(width: replyFinalRect.width, height: replyFinalRect.height)
                .position(x: replyFinalRect.midX, y: replyFinalRect.midY)
                .opacity(fieldReveal)
                .allowsHitTesting(fieldReveal > 0.5)
        }
        .frame(width: FieldMetrics.size.width, height: FieldMetrics.size.height, alignment: .topLeading)
    }

    // MARK: Actions row

    private var actionsRow: some View {
        HStack(spacing: 8) {
            pill(session.state.status.pillText ?? "ready")
            if session.state.taskCounts.total > 0 {
                let counts = session.state.taskCounts
                pill("☑ \(counts.done)/\(counts.total)")
            }
            Spacer()
        }
    }

    private func pill(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .glassEffect(.regular, in: Capsule())
            .fixedSize()
    }

    // MARK: Composer (the piece the orb circle morphs into — D8)

    private var composer: some View {
        ZStack {
            // The shell: same glassEffectID as OrbView's Circle, opacity fading in on the SAME
            // band the orb fades out on — together they crossfade at the geometry's midpoint.
            Capsule()
                .fill(.clear)
                .glassEffect(.regular, in: Capsule())
                .glassEffectID("norma-shell", in: glassNamespace)
                .glassEffectTransition(.matchedGeometry)
                .opacity(fieldReveal)

            ComposerTextView(text: $draft, onSubmit: onSubmit)
                .frame(minHeight: 22, maxHeight: 88)
                .overlay(alignment: .leading) {
                    if draft.isEmpty {
                        Text("Ask Norma…")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                            .padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .opacity(contentReveal)
                .allowsHitTesting(contentReveal > 0.5)
        }
    }

    // MARK: Reply area

    private var replyText: String {
        let state = session.state
        if state.turnRunning && !state.streamingText.isEmpty {
            return state.streamingText
        }
        return state.lastReply ?? ""
    }

    private var replyArea: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if !replyText.isEmpty {
                    Text(replyText)
                        .font(.system(size: 13))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if session.state.turnRunning && session.state.streamingText.isEmpty {
                    shimmerRow
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    /// v1 LAW (PointerRenderer.swift:28-39, mirrored in `OrbView`): the animation lives INSIDE
    /// this Group, not on an outer view, so it doesn't get canceled by an unrelated transaction
    /// (e.g. the reply text arriving). Also no `.drawingGroup()` anywhere in this file — that
    /// would rasterize and freeze the shimmer.
    private var shimmerRow: some View {
        Group {
            Text("…")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .opacity(0.35 + 0.5 * shimmer)
        }
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: true)) {
                shimmer = 1.0
            }
        }
    }
}
