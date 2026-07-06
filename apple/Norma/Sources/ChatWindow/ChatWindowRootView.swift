import SwiftUI

/// Spec §1: the window is glass but TINTED near-opaque (white in Light, grey in Dark) so it
/// reads as a solid normal window. Pure so the exact values are pinned by tests.
func chatWindowTint(darkMode: Bool) -> (white: Double, opacity: Double) {
    darkMode ? (white: 0.16, opacity: 0.94) : (white: 0.97, opacity: 0.94)
}

/// Task 4 content: field content, bigger (spec decision) — status header, the current
/// prompt/reply, and the shared composer. This is a NEW, simple layout — NOT a `NormaFieldView`
/// reuse (that view is fused to the morph + difference-blend machinery, neither of which applies
/// here). Everything below uses ADAPTIVE colors (`.primary`/`.secondary`/`.tertiary`): this
/// surface is opaque, so the difference-blend white-text LAW the field lives under does NOT apply
/// here and must not be imported.
struct ChatWindowRootView: View {
    @ObservedObject var adapter: FieldStateAdapter
    let onRequestClose: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var tint: Color {
        let t = chatWindowTint(darkMode: colorScheme == .dark)
        return Color(white: t.white).opacity(t.opacity)
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text(adapter.statusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: onRequestClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let prompt = adapter.displayedPrompt {
                        Text(prompt)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let position = adapter.historyPositionText {
                        Text(position).font(.system(size: 11)).foregroundStyle(.tertiary)
                    }
                    Text(adapter.visibleResponse ?? "")
                        .font(.system(size: 13))
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 4)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let queued = adapter.queuedText {
                Text(queued).font(.system(size: 11)).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ComposerTextView(
                text: adapter.draftBinding,
                onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                usesAdaptiveColors: true
            )
            .frame(height: 88)
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(tint)
                .glassEffect(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        )
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}
