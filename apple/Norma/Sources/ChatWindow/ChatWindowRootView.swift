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

/// Gate r4: the three self-drawn macOS-style traffic lights, replacing the removed native window
/// buttons (the borderless window has none). Gate r6 (live-gate finding — real macOS-26 buttons
/// read visibly bigger): three 14pt circles (was 12pt), 9pt apart (was 8pt), each with a subtle
/// darker ring; hovering ANYWHERE over the group reveals the ×/−/+ glyphs (macOS behavior). Wired:
/// red → close, yellow → minimize, green → zoom (see `ChatWindowRootView`).
private struct MacTrafficLights: View {
    let onClose: () -> Void
    let onMinimize: () -> Void
    let onZoom: () -> Void
    @State private var hovering = false

    // Standard macOS traffic-light fills.
    private static let closeColor = Color(red: 1.0, green: 0.373, blue: 0.341)    // #FF5F57
    private static let minimizeColor = Color(red: 0.996, green: 0.737, blue: 0.176) // #FEBC2E
    private static let zoomColor = Color(red: 0.157, green: 0.784, blue: 0.251)   // #28C840
    private static let glyphColor = Color(red: 0.28, green: 0.14, blue: 0.0).opacity(0.55) // dark brown-ish

    var body: some View {
        HStack(spacing: 9) { // gate r6: 8 → 9, matched to the 12pt → 14pt circle bump
            light(color: Self.closeColor, glyph: "xmark", action: onClose)
            light(color: Self.minimizeColor, glyph: "minus", action: onMinimize)
            light(color: Self.zoomColor, glyph: "plus", action: onZoom)
        }
        .onHover { hovering = $0 }
    }

    private func light(color: Color, glyph: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle().fill(color)
                Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 0.5)
                if hovering {
                    Image(systemName: glyph)
                        .font(.system(size: 8.5, weight: .bold)) // gate r6: 7.5 → 8.5
                        .foregroundStyle(Self.glyphColor)
                }
            }
            .frame(width: 14, height: 14) // gate r6: 12 → 14, real macOS-26 traffic-light size
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

/// Gate r4: height of the self-drawn header band that holds the traffic lights + status text (the
/// buttons sit vertically centered within it). Sized to the user's Safari-proportions ask without
/// wasting the vertical space the old 52pt native-titlebar inset did. Gate r6: bumped 28 → 30 to
/// give the bigger 14pt traffic lights (was 12pt) a touch more breathing room — 28pt started to
/// feel tight once the buttons grew.
let chatWindowHeaderHeight: CGFloat = 30
