import SwiftUI

/// The expanded surface: actions row + composer + streaming reply area. Lives INSIDE
/// `GlassRootView`'s single `GlassEffectContainer` — this view creates no container of its
/// own (D3/D4: exactly one container for the whole orb/field morph).
///
/// Deviation from the brief's literal `FieldView(session:draft:onSubmit:)` signature: the
/// composer shell must carry `.glassEffectID("norma-shell", in:)` tagged with the SAME
/// `Namespace.ID` the orb circle uses (D8 — that's what makes the orb morph into the
/// composer), so this view also takes `glassNamespace: Namespace.ID` from `GlassRootView`.
/// There's no way to thread a `Namespace.ID` through `Environment` without a custom key, and
/// the brief's own "both branches share the namespace" line requires it structurally, so
/// adding the parameter is the minimal adaptation.
struct FieldView: View {
    @ObservedObject var session: SessionModel
    @Binding var draft: String
    var glassNamespace: Namespace.ID
    var onSubmit: () -> Void

    @State private var shimmer = 0.0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            actionsRow
            composer
            replyArea
        }
        .padding(16)
        .frame(width: FieldMetrics.size.width, height: FieldMetrics.size.height)
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
            .glassEffect(.regular, in: Capsule())
            .glassEffectID("norma-shell", in: glassNamespace)
            .glassEffectTransition(.matchedGeometry)
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
