import SwiftUI

/// The expanded surface: actions row + ONE composer/reply shell. Lives INSIDE `GlassRootView`'s
/// single `GlassEffectContainer` — this view creates no container of its own (D3/D4: exactly
/// one container for the whole orb/field morph).
///
/// Wave 2 (v1 morph+follow engine): this view is PERMANENTLY in the hierarchy alongside
/// `OrbView` — the discrete `if surface` switch is gone. Every element's geometry/opacity is
/// computed from `progress` (`morphModel.progress`, injected by `GlassRootView`), mirroring
/// v1 GlassFieldView.composerBody's approach (progress-interpolated rects) simplified to our
/// two surfaces: only the shell geometrically lerps (from the orb circle's rect at progress 0
/// to its final in-layout rect at progress 1); the actions row just fades in over the same
/// crossfade band `OrbView` fades out on, and the shell's own content reveals a little later
/// still (an empty glass shell still inflating, then the content arrives — v1's "content
/// reveals late" rule, GlassFieldView.swift:335-338).
///
/// Wave 2c task 3 (v1 composer styling + inline response — gate feedback: "the AI Pointer
/// styling was way better" / "answers should show on the same field as the text input"): the
/// composer pill and the reply scroll area used to be two separate rects/glass elements. Now
/// there is ONE shell, styled with v1's actual composer chrome (`GlassSurface`'s 22pt corner
/// radius / white hairline, GlassFieldView.swift:313-460 & :2648+): it shows the draft
/// (`ComposerTextView`) when there's nothing to answer yet, and the current exchange's reply
/// (streaming live, then settled) once one exists — draft hidden behind it, never both at once,
/// exactly like v1's `composerDisplayText` swapping in for `composerText` (Core/AppState.swift:
/// 160-171) inside the SAME text surface. `showingDraft` + the trailing chevron are this wave's
/// stand-in for v1's `onTextFieldRightEdge` seam (see the property doc below).
///
/// Deviation from the brief's literal `FieldView(session:draft:onSubmit:)` signature: the shell
/// must carry `.glassEffectID("norma-shell", in:)` tagged with the SAME `Namespace.ID` the orb
/// circle uses (D8 — that's what makes the orb morph into the composer), so this view also
/// takes `glassNamespace: Namespace.ID` from `GlassRootView`, plus `progress: Double` for the
/// geometry/opacity math above.
struct FieldView: View {
    @ObservedObject var session: SessionModel
    @Binding var draft: String
    var glassNamespace: Namespace.ID
    var progress: Double
    var onSubmit: () -> Void

    @State private var shimmer = 0.0
    /// v1 port of `onTextFieldRightEdge` (GlassFieldView.swift:44, GlassFieldWindow.swift's
    /// `revealComposerDraftFromInlineResponse`, :1540-1545): there, hitting the right-arrow key
    /// at the caret's end PERMANENTLY cleared the shown response (`appState.clearVisibleResponse()`)
    /// — there was no way back to it from the UI. Here it's a plain toggle instead: `true` means
    /// "the user asked to see the draft again"; it resets to `false` when a new turn actually
    /// STARTS (`.onChange(of: session.state.turnRunning)` in `body`), not when the composer is
    /// submitted — a failed send never starts a turn, so the draft (and the fact it's showing)
    /// survives the failure instead of being hidden behind a stale prior reply. W4 adds the
    /// swipe gesture that flips this same flag — the trailing chevron button below is this
    /// wave's interim affordance for it.
    @State private var showingDraft = false

    // MARK: Geometry — fixed final rects (this view's own internal layout, matching the old
    // VStack's 16pt padding / 10pt spacing), all top-left anchored like `OrbMetrics.anchorRect`
    // and `FieldMetrics` (the "grows down-right" law).

    private var actionsRowFinalRect: CGRect {
        CGRect(x: 16, y: 16, width: FieldMetrics.size.width - 32, height: 24)
    }

    /// v1 parity: what used to be two separate rects (composer pill + reply scroll area) is now
    /// ONE shell spanning the rest of the field, below the actions row — it shows the draft OR
    /// the current exchange's reply, never both.
    private var shellFinalRect: CGRect {
        let top = actionsRowFinalRect.maxY + 10
        return CGRect(x: 16, y: top, width: FieldMetrics.size.width - 32, height: FieldMetrics.size.height - top - 16)
    }

    /// The shell's rect lerps from the orb circle's rect (progress 0, same corner both views
    /// share) to its final in-layout rect (progress 1) — the ONLY element that geometrically
    /// travels; the actions row just fades in place.
    private var shellRect: CGRect {
        interpolatedRect(from: OrbMetrics.anchorRect, to: shellFinalRect, progress: progress)
    }

    /// v1's 0.3…0.7 crossfade band — the SAME band `OrbView.orbOpacity` fades out on, so the
    /// two views meet at the midpoint instead of visibly gapping or double-exposing.
    private var fieldReveal: Double { smoothstep(0.3, 0.7, progress) }
    /// v1's later "content reveals last" band (GlassFieldView.swift:338): the shell's own
    /// content waits until the shell has mostly finished growing.
    private var contentReveal: Double { smoothstep(0.45, 0.74, progress) }

    /// v1's settled pill radius (GlassFieldView.swift:1256-1262 `morphedCornerRadius` — circular
    /// at bubble size, converging on this fixed radius as the shape grows past the crossfade
    /// band). We don't need the full per-frame formula: `.glassEffectTransition(.matchedGeometry)`
    /// already interpolates Circle → RoundedRectangle across the morph on its own; this is just
    /// the FINAL radius, and it's also `GlassSurface`'s default so every field surface matches.
    private static let shellCornerRadius: CGFloat = 22

    var body: some View {
        ZStack(alignment: .topLeading) {
            actionsRow
                .frame(width: actionsRowFinalRect.width, height: actionsRowFinalRect.height, alignment: .leading)
                .position(x: actionsRowFinalRect.midX, y: actionsRowFinalRect.midY)
                .opacity(fieldReveal)
                .allowsHitTesting(fieldReveal > 0.5)

            shell
                .frame(width: shellRect.width, height: shellRect.height)
                .position(x: shellRect.midX, y: shellRect.midY)
        }
        .frame(width: FieldMetrics.size.width, height: FieldMetrics.size.height, alignment: .topLeading)
        .onChange(of: session.state.turnRunning) { _, running in
            // A NEW turn starting is the only reliable "the draft is done" signal (v1 parity —
            // see `showingDraft` doc above). Flipping this synchronously on submit instead (the
            // old behavior) meant a FAILED send — turnRunning never goes true — snapped the shell
            // back to the stale prior reply, hiding the preserved draft the user just retyped.
            if running { showingDraft = false }
        }
    }

    // MARK: Actions row (v1 NavigationPill/SegmentCell constants — GlassFieldView.swift:1916-1939:
    // 11pt medium font, 10pt/5pt padding, styled via the ported `GlassSurface` recipe)

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
            .padding(.vertical, 5)
            .modifier(GlassSurface())
            .fixedSize()
    }

    // MARK: Shell — the piece the orb circle morphs into (D8), showing EITHER the composer OR
    // the inline response, never both (v1 parity: Core/AppState.swift `composerDisplayText`).

    private var isStreaming: Bool {
        session.state.turnRunning && !session.state.streamingText.isEmpty
    }

    /// Turn running, agent hasn't started streaming text yet — the shimmer-only "thinking" state.
    private var isThinking: Bool {
        session.state.turnRunning && session.state.streamingText.isEmpty
    }

    private var currentExchange: Exchange? { session.state.exchanges.last }

    private var hasReply: Bool {
        isStreaming || isThinking || !(currentExchange?.reply.isEmpty ?? true)
    }

    /// v1 parity: the inline response occupies the shell whenever there's something to show,
    /// UNLESS the user asked to see the draft again (`showingDraft`).
    private var showsInlineResponse: Bool { hasReply && !showingDraft }

    private var replyText: String {
        isStreaming ? session.state.streamingText : (currentExchange?.reply ?? "")
    }

    private var shell: some View {
        ZStack {
            shellGlass

            if showsInlineResponse {
                inlineResponse
                    .opacity(contentReveal)
                    .allowsHitTesting(contentReveal > 0.5)
            } else {
                composer
                    .opacity(contentReveal)
                    .allowsHitTesting(contentReveal > 0.5)
            }
        }
    }

    /// The morph-tagged glass fill + v1's hairline border (GlassSurface's own two halves,
    /// GlassFieldView.swift:2652-2666), reproduced inline rather than routed through the
    /// `GlassSurface` modifier itself: the fill here has to carry `.glassEffectID` for the
    /// orb-morph identity, and `GlassSurface`'s `.background { }` would instead bury a second,
    /// un-tagged glass fill underneath the tagged one. Same constants either way (22pt corner
    /// radius, white 0.5-opacity 1pt stroke) so the shell reads as the same material as the
    /// actions-row pills.
    private var shellGlass: some View {
        let shape = RoundedRectangle(cornerRadius: Self.shellCornerRadius, style: .continuous)
        return shape
            .fill(.clear)
            .glassEffect(.regular, in: shape)
            .glassEffectID("norma-shell", in: glassNamespace)
            .glassEffectTransition(.matchedGeometry)
            .overlay(shape.strokeBorder(Color.white.opacity(0.5), lineWidth: 1))
            .opacity(fieldReveal)
    }

    // MARK: Composer (v1 composerContent constants — GlassFieldView.swift:943-986: 12pt
    // horizontal / 6pt vertical padding around the text view)

    private var composer: some View {
        ComposerTextView(text: $draft, onSubmit: submitFromComposer)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .overlay(alignment: .topLeading) {
                if draft.isEmpty {
                    Text("Ask Norma…")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                        .allowsHitTesting(false)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
    }

    /// Does NOT touch `showingDraft` synchronously — see the `.onChange(of: turnRunning)` in
    /// `body`. Flipping it here (the old behavior) raced a FAILED send: `onSubmit()` returning
    /// an error never starts a turn, so the shell would already be showing (and then keep
    /// showing) the stale prior reply instead of the intact, resubmittable draft.
    private func submitFromComposer() {
        onSubmit()
    }

    // MARK: Inline response (fills the SAME shell the composer uses — gate feedback: "answers
    // should show on the same field as the text input")

    private var inlineResponse: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if !replyText.isEmpty {
                        Text(replyText)
                            .font(.system(size: 13))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if isThinking {
                        shimmerRow
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            revealDraftButton
                .padding(6)
        }
    }

    /// v1's `onTextFieldRightEdge` seam (see `showingDraft` doc above), ported as a visible
    /// trailing chevron rather than a caret-position-triggered key handler — W4 adds the swipe
    /// that flips the same `showingDraft` flag.
    private var revealDraftButton: some View {
        Button {
            showingDraft = true
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
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
