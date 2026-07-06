import SwiftUI

// NOTE (gate r7): `chatWindowTint`, `MacTrafficLights`, and `chatWindowHeaderHeight` now live in
// `FieldKit/WindowSurfaceView.swift` / `WindowSurfaceGeometry.swift` (ownership moved to the
// same-panel window surface; this whole file is deleted in the r7 pivot).

/// Task 4 content: field content, bigger (spec decision) — status header, the current
/// prompt/reply, and the shared composer. This is a NEW, simple layout — NOT a `NormaFieldView`
/// reuse (that view is fused to the morph + difference-blend machinery, neither of which applies
/// here). Everything below uses ADAPTIVE colors (`.primary`/`.secondary`/`.tertiary`): this
/// surface is opaque, so the difference-blend white-text LAW the field lives under does NOT apply
/// here and must not be imported.
///
/// Gate r4 (fully self-drawn window): the window is BORDERLESS for its whole life
/// (`ChatWindowController.show(from:)`) — no native titlebar, no system traffic-light buttons.
/// This view draws its OWN traffic lights (`MacTrafficLights`) in a top-leading header band and
/// owns its OWN rounded corners again (`RoundedRectangle` clip/fill — the borderless window has no
/// system window shape to lean on, so this reverts the r2 "let the system round it" decision).
struct ChatWindowRootView: View {
    @ObservedObject var adapter: FieldStateAdapter
    /// Red traffic light — dismiss the window (animated shrink back to the orb).
    let onRequestClose: () -> Void
    /// Yellow traffic light — minimize. The orb IS Norma's minimized state, so today this shares
    /// the shrink-to-orb gesture with `onRequestClose`; the semantics may diverge in a later phase.
    let onRequestMinimize: () -> Void
    /// Green traffic light — manual zoom toggle (fill the screen / restore), since a borderless
    /// window has no native zoom.
    let onRequestZoom: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var tint: Color {
        let t = chatWindowTint(darkMode: colorScheme == .dark)
        return Color(white: t.white).opacity(t.opacity)
    }

    private var windowShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: chatWindowCornerRadius, style: .continuous)
    }

    var body: some View {
        VStack(spacing: 10) {
            // Gate r4: self-drawn header band — our own traffic lights (leading, inset to Safari
            // proportions) plus the status text. Replaces both the removed native titlebar and the
            // r2/r3 52pt content inset that used to dodge it.
            HStack(spacing: 12) {
                MacTrafficLights(
                    onClose: onRequestClose,
                    onMinimize: onRequestMinimize,
                    onZoom: onRequestZoom
                )
                // Gate r6 (macOS-26 proportions, live-gate finding): 16pt content pad + 6 = ~22pt
                // from the window's left edge — closer to a real macOS-26 window's traffic-light
                // inset than the previous ~20pt (pad + 4).
                .padding(.leading, 6)

                Text(adapter.statusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(height: chatWindowHeaderHeight)

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
        // Gate r4: no native titlebar to dodge — a normal top pad. The header band above sits
        // directly under it.
        .padding(.top, 14)
        .background(
            // Gate r4 (self-drawn corners): the borderless window has NO system window shape, so we
            // round the content ourselves — a continuous `RoundedRectangle` fills the tint + glass
            // and the whole view is clipped to it (AppKit's window shadow follows this shape).
            // `.ignoresSafeArea()` lets the tint bleed to the very edge of the (rounded) clip.
            windowShape
                .fill(tint)
                .glassEffect(in: windowShape)
                .ignoresSafeArea()
        )
        .clipShape(windowShape)
    }
}

// NOTE (gate r7): `MacTrafficLights` + `chatWindowHeaderHeight` moved to
// `FieldKit/WindowSurfaceView.swift`.
