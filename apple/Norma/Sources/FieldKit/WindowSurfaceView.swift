import SwiftUI

/// Gate r7 (ARCHITECTURE PIVOT — same-panel window morph): the window branch of `NormaFieldView`.
/// This is NOT a separate panel (the r7 pivot deleted `ChatWindow/*`): it is a THIRD morph target
/// of the orb panel itself — the SAME `GlassEffectContainer`/glassNamespace/140-22 spring the
/// orb↔field morph uses. Renders when `morph.renderSurface == .window`.
///
/// Transplant of v1's `chatBody` (GlassFieldView.swift:808-916), adapted for v2's approved visual
/// decisions:
///   - shell rect via `morphedWindowSurfaceRect` (verbatim v1 bands), corner circle→26 (v2's radius,
///     v1 used 30), `glassEffectID("window-shell")` in the shared `glassNamespace`;
///   - INSIDE the shell, v2's approved window content: a NEAR-OPAQUE tint (`chatWindowTint`) that
///     FADES IN with progress (glassy at the orb, solid once the shell has formed), a
///     self-drawn `MacTrafficLights` header, status text, prompt/reply `ScrollView`, and
///     `ComposerTextView(usesAdaptiveColors: true)`;
///   - content blur/scale reveal bands verbatim from v1 (`(1-ss(0.44,1))*18` / `0.985+ss(0.40,1)*0.015`),
///     masked to the shell shape.
///
/// LAW note: this branch has an OPAQUE tint, so the field's difference-blend white-text LAW does
/// NOT apply — content uses ADAPTIVE colors (`.primary`/`.secondary`/`.tertiary`) and is NOT wrapped
/// in `GlassForegroundLegibility`. Real `ScrollView` + `ComposerTextView` hit-test natively (no
/// blend to break AppKit hit-testing — the whole reason the r7 pivot escapes the field's regime
/// inside the window).
struct WindowSurfaceView: View {
    @ObservedObject var adapter: FieldStateAdapter
    @ObservedObject var morph: MorphModel
    /// Not `@ObservedObject` — same reason as `NormaFieldView.fluid` (the fluid publisher ticks at
    /// ~120Hz; this view must not re-run its whole body on every one). Held to hand down to the
    /// continuity `FluidOrbSlot` only.
    let fluid: FluidModel
    /// Shared with the field's composer-shell so both live in one `GlassEffectContainer` namespace
    /// (v1 kept "chat-shell" and "composer-shell" in the same namespace; they never coexist).
    let namespace: Namespace.ID
    let windowSize: CGSize
    /// Red traffic light + yellow (minimize) + 4-finger tap + Esc all collapse to the orb.
    let onClose: () -> Void
    let onMinimize: () -> Void
    /// Green traffic light — zoom toggle.
    let onZoom: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private func tintColor(progress: Double) -> Color {
        let t = chatWindowTint(darkMode: colorScheme == .dark)
        // Fade the tint in with progress — glassy at the orb (opacity 0 below 0.30), solid once the
        // shell has formed (full at 0.80). The shell reads as growing OUT of the translucent orb
        // rather than a solid slab teleporting in.
        let mul = smoothstep(0.30, 0.80, progress)
        return Color(white: t.white).opacity(t.opacity * mul)
    }

    var body: some View {
        let finalRect = morph.windowFinalRect
            ?? CGRect(x: (windowSize.width - chatWindowDefaultSize.width) / 2,
                      y: (windowSize.height - chatWindowDefaultSize.height) / 2,
                      width: chatWindowDefaultSize.width, height: chatWindowDefaultSize.height)
        let orbPoint = morph.windowOrbPoint ?? CGPoint(x: windowSize.width / 2, y: windowSize.height / 2)
        let shellRect = morphedWindowSurfaceRect(
            orbPoint: orbPoint, finalRect: finalRect,
            progress: morph.progress, orbBubbleSize: morph.orbBubbleSize
        )
        let shellRadius = morphedWindowSurfaceCornerRadius(for: shellRect)
        let shellShape = RoundedRectangle(cornerRadius: shellRadius, style: .continuous)

        // Fix B / v1 chatBody content focus-pull (GlassFieldView.swift:816-817), verbatim.
        let contentBlur = CGFloat((1 - smoothstep(0.44, 1.0, morph.progress)) * 18)
        let contentScale = 0.985 + CGFloat(smoothstep(0.40, 1.0, morph.progress)) * 0.015
        let contentReveal = smoothstep(0.35, 0.85, morph.progress)

        ZStack {
            // Continuity: the fluid orb sits at the orb end, fading out as the shell forms (mirrors
            // the field's own `1 - ss(0.0,0.28,progress)` orb fade) so the window reads as growing
            // out of the same orb — and, on collapse, melting back into it.
            FluidOrbSlot(
                fluid: fluid, state: adapter.fluidState, isStoppedFlash: adapter.showStoppedFlash,
                isHeld: adapter.isHoldingWork, actionNeeded: adapter.interactionNeeded
            )
            .frame(width: morph.orbBubbleSize, height: morph.orbBubbleSize)
            .position(x: orbPoint.x, y: orbPoint.y)
            .opacity(1 - smoothstep(0.0, 0.28, morph.progress))

            // The morphing glass shell — SAME container/namespace/spring as the composer shell.
            GlassEffectContainer(spacing: 0) {
                shellShape
                    .fill(Color.clear)
                    .frame(width: shellRect.width, height: shellRect.height)
                    .glassEffect(.regular, in: shellShape)
                    .glassEffectID("window-shell", in: namespace)
                    .glassEffectTransition(.matchedGeometry)
                    .position(x: shellRect.midX, y: shellRect.midY)
            }
            .id(morph.glassRefreshGeneration)

            // Near-opaque tint filling the shell, faded in with progress — this is what makes the
            // window escape the field's difference-blend regime (opaque background = adaptive colors,
            // real hit-testing).
            shellShape
                .fill(tintColor(progress: morph.progress))
                .frame(width: shellRect.width, height: shellRect.height)
                .position(x: shellRect.midX, y: shellRect.midY)
                .allowsHitTesting(false)

            // The window content, masked to the shell so it reveals as the shell forms.
            windowContent(finalRect: finalRect)
                .frame(width: finalRect.width, height: finalRect.height)
                .scaleEffect(contentScale, anchor: .center)
                .blur(radius: contentBlur)
                .position(x: finalRect.midX, y: finalRect.midY)
                .opacity(contentReveal)
                .mask {
                    shellShape
                        .frame(width: shellRect.width, height: shellRect.height)
                        .position(x: shellRect.midX, y: shellRect.midY)
                }

            // Subtle edge stroke (adaptive — NOT the field's difference-blend white-stroke).
            shellShape
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
                .frame(width: shellRect.width, height: shellRect.height)
                .position(x: shellRect.midX, y: shellRect.midY)
                .allowsHitTesting(false)
        }
        .frame(width: windowSize.width, height: windowSize.height)
    }

    // MARK: - Window content (adaptive colors — moved from the deleted ChatWindowRootView)

    @ViewBuilder
    private func windowContent(finalRect: CGRect) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                MacTrafficLights(onClose: onClose, onMinimize: onMinimize, onZoom: onZoom)
                    .padding(.leading, 6)
                Text(adapter.statusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(height: chatWindowHeaderHeight)

            TranscriptView(adapter: adapter, tint: Color(red: 0.45, green: 0.75, blue: 1.0))
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
        .padding(.top, 14)
        .padding(.bottom, 16)
    }
}

/// The three self-drawn macOS-style traffic lights (moved from the deleted `ChatWindowRootView`):
/// three 14pt circles, 9pt apart, each with a subtle darker ring; hovering ANYWHERE over the group
/// reveals the ×/−/+ glyphs (macOS behavior). Wired: red → close, yellow → minimize, green → zoom.
struct MacTrafficLights: View {
    let onClose: () -> Void
    let onMinimize: () -> Void
    let onZoom: () -> Void
    @State private var hovering = false

    private static let closeColor = Color(red: 1.0, green: 0.373, blue: 0.341)        // #FF5F57
    private static let minimizeColor = Color(red: 0.996, green: 0.737, blue: 0.176)   // #FEBC2E
    private static let zoomColor = Color(red: 0.157, green: 0.784, blue: 0.251)       // #28C840
    private static let glyphColor = Color(red: 0.28, green: 0.14, blue: 0.0).opacity(0.55)

    var body: some View {
        HStack(spacing: 9) {
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
                        .font(.system(size: 8.5, weight: .bold))
                        .foregroundStyle(Self.glyphColor)
                }
            }
            .frame(width: 14, height: 14)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

/// Height of the self-drawn header band that holds the traffic lights + status text.
let chatWindowHeaderHeight: CGFloat = 30
