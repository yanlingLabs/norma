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
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        // Gate fix (F2 — native traffic lights): reserve the native title-bar button row
        // (`.fullSizeContentView` lets our content extend all the way up under it) so the
        // status text/close button never sit underneath the real traffic lights.
        .padding(.top, chatWindowContentTopInset)
        .background(
            // Gate fix (F2 — corner radius): the window is now `.titled` (real traffic lights +
            // native resize, see `ChatWindowController.show(from:)`), so the SYSTEM draws the
            // window's rounded-corner shape and clips our content to it automatically — a titled
            // NSWindow's content view is clipped to the window's own shape. A second, manually
            // rounded/clipped layer here would either show a mismatched double-rounded seam or a
            // square glass corner poking past the system's round one, depending on which radius
            // is bigger. Fill flush to the window edge with a plain rectangle instead, and let
            // the system's own shape do ALL the rounding. `.ignoresSafeArea()` lets the tint
            // bleed all the way up under the titlebar so the button row reads as part of the
            // same glass surface (not a separate bar) — spec's Safari-screenshot reference.
            Rectangle()
                .fill(tint)
                .glassEffect(in: Rectangle())
                .ignoresSafeArea()
        )
    }
}

/// Gate fix (F2): vertical space reserved at the top of the content so the status row/close
/// button clear the native traffic-light buttons (`.fullSizeContentView` extends our content
/// under them). Matches the minimal (toolbar-less) title-bar height on current macOS.
private let chatWindowContentTopInset: CGFloat = 28
