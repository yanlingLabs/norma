import SwiftUI
import AppKit

/// DIRECT TRANSPLANT of v1 `GlassFieldView`'s COMPOSER PATH (TextField/GlassFieldView.swift) —
/// `composerBody(in:)` (:313-438), `composerMorphedContent(...)` (:440-721), and every helper
/// they use that doesn't depend on a cut subsystem: `composerContent` (:942-986, reduced), the
/// morph geometry helpers (:1014-1269, minus the dashboard variants), `BreathingHalo`
/// (:1299-1370), `GlassForegroundLegibility` (:1285-1291), the nav pill machinery
/// (`NavigationPill` :1835-1893, `SegmentCell` :1916-1959, `NativeGlassCapsuleSurface`
/// :1900-1914), `FieldThinkingPill` (:2563-2595), `FieldIconButton` (:2599-2613),
/// `GlassChromeColor` (:2628-2641). `smoothstep`/`interpolatedRect` are NOT re-declared here — v2
/// already ports both as module-internal free functions (Orb/MorphGeometry.swift), reused as-is.
/// `GlassSurface` is likewise reused from Field/GlassSurface.swift (an existing, already-verbatim
/// v1 port) rather than re-declared. All the "supporting files" the brief mentions ended up in
/// this one file, matching v1's own organization (all of the above live in the single
/// GlassFieldView.swift there too).
///
/// CUT (per the brief): `dashboardBody`/`chatBody` and everything that only exists to feed them
/// (`ChatSurfacePlacement`, dashboard/chat callbacks); every image/screenshot pill
/// (`ImageChipGlassRow`/`ImageChipMorphStrokeRow`/`ImageChipMorphFocusGlowRow`/
/// `ImageChipMorphContentRow` and their shared state — `renderedImageChips`, `composerImages`,
/// `reconcileRenderedImageChips`, etc. — plus the `screenshotOffset` slot `composerFinalRect`
/// used to reserve for them); the chat-button/expand affordance next to the nav pill
/// (`chatButtonFinalRect`, `TopRowIconButton`/`TopRowIconFocusGlow`, since chat is cut);
/// battery/fan/permissions (`permissions`/`batteryLimiterController`/`fanController`/
/// `privilegedHelperClient` were `GlassFieldWindowController` dependencies, never read inside
/// composerBody itself, so there was nothing here to delete beyond not carrying them forward);
/// tear-out/detach and the chat sidebar.
///
/// FOCUS COORDINATOR: v1's field panel is permanently mouse-inert (`ignoresMouseEvents = true`),
/// so `FieldFocusCoordinator` exists there to let arrow keys/Enter drive every button via a
/// keyboard-only focus ring. v2's panel is NOT mouse-inert while expanded
/// (`OrbWindowController.expandToField()` sets `panel.ignoresMouseEvents = false`) — buttons are
/// plain clickable SwiftUI `Button`s already (see `Field/FieldView.swift`'s `revealDraftButton`),
/// and Escape is already owned by `OrbWindowController`'s own key monitor calling `onEsc`. There
/// is therefore nothing for a keyboard focus router to do here: `FieldFocusCoordinator` is
/// STUBBED, not ported — every seam it used to serve is instead a plain `Button` wired straight
/// to a `FieldStateAdapter` closure. The focus-glow layers that only existed to paint a
/// keyboard-focus ring (`ComposerSideFocusGlowLayer`, `NavigationFocusGlow`/
/// `NavigationFocusGlowCell`, `TopRowIconFocusGlow`, `FocusGlow`) are cut as a direct consequence
/// of that — meaningless without a keyboard focus concept, not an independent cut.
///
/// appState → adapter rebinds: `appState.modelStatusText`/`.statusText` (`narrationCaption`) →
/// `adapter.statusText`; `appState.presentationMode == .thinking` → `adapter.isThinking`;
/// `appState.composerDisplayText` (read) → `adapter.visibleResponse` (falls back to the draft,
/// see `showsInlineResponse` below) and the draft text itself → `adapter.composerDraft` /
/// `adapter.draftBinding`; `focusCoordinator.onSubmit()` → `adapter.onSubmit(adapter.
/// composerDraft)`; the clear-message button action → `adapter.onClearMessage()`;
/// `focusCoordinator.onCollapse()` (the Esc/collapse seam) → `adapter.onCollapse()`.
/// `appState.visualCustomization` (halo/focus tint) has no v2 equivalent yet — `haloColor` below
/// is a fixed placeholder constant, not a per-user setting; there's no focus-highlight color left
/// to rebind since the focus-glow layers are cut (see above). v1's reset icon
/// ("arrow.counterclockwise", GlassFieldView.swift:946-949) had no backing action in
/// `FieldStateAdapter`'s contract (no context-reset hook in the brief's callback list) — see
/// `composerContent` below for how its layout SLOT is kept without the button.
///
/// INLINE RESPONSE: v1's composerBody never showed a reply inline — the "inline response in the
/// same shell" behavior (`showsInlineResponse`/`showingDraft`/shimmer) is v2's OWN existing
/// design (`Field/FieldView.swift`, wave 2c task 3), ported into v1's real composer chrome here
/// rather than re-invented — this is the "inline response rendering" + "shimmer" the brief asks
/// to keep. Task A simplified relative to `Field/FieldView.swift` by dropping `displayedPrompt`/
/// `historyPositionText` (those read exchange prompt/count directly, which `FieldStateAdapter`'s
/// original spec didn't expose). Task B adds both back onto `FieldStateAdapter` (fed from
/// `exchangeIndex` + `session.state.exchanges`, mirroring the old `Field/FieldView.swift` exactly)
/// and reads them here in `inlineResponse` below.
///
/// COMPOSER CONTENT HEIGHT: v1's `ComposerTextView` reports live text height via
/// `onContentHeightChange`, driving `composerContentHeight` so the pill grows with typed text.
/// Task B ports the same callback onto v2's `ComposerTextView` (`Field/ComposerTextView.swift`)
/// and wires it below, so `composerContentHeight`/`clampedComposerHeight()` (kept verbatim from
/// task A) are now actually driven by the live text measurement instead of sitting fixed.
struct NormaFieldView: View {
    @ObservedObject var adapter: FieldStateAdapter
    @ObservedObject var morph: MorphModel
    @Namespace private var glassNamespace

    @State private var composerContentHeight: CGFloat = 22
    /// GATE-3 FIX (round 3, F4): moved onto `FieldStateAdapter` (`adapter.showingDraft`) — see
    /// that property's doc for why (this view no longer owns the sole write to it; a fresh
    /// summon needs to force it too, and that decision lives in `GlassRootView`, not here).
    @State private var shimmer = 0.0

    /// v1 default halo tint (`appState.visualCustomization.haloNSColor`'s factory default) —
    /// there is no visualCustomization system in v2 yet, so this is a fixed placeholder; a later
    /// wave that adds user customization should rebind this to a real setting.
    private let haloColor = Color.blue

    var body: some View {
        GeometryReader { geo in
            composerBody(in: geo.size)
        }
        // GATE-3 FIX (F1, root cause #2): was `morph.windowSize` (the fixed 480×440 EXPANDED
        // size) unconditionally — see `MorphModel.activeWindowSize`'s doc for why that silently
        // grew the AppKit panel back to 480×440 even while collapsed (an `NSHostingView` internal
        // auto-resize-to-content-size behavior, confirmed live via a symbolicated stack trace).
        // `activeWindowSize` tracks whichever size `OrbWindowController` actually has the panel
        // set to, flipping at the exact same two instants (`expandToField()`/`finishCollapse()`)
        // — the composer's own visible geometry already morphs off `progress` independent of this
        // outer frame (see the corner-pinned `.topLeft` geometry helpers below, none of which
        // depend on this size for that corner), so this has no effect on the morph animation
        // itself, only on what physical AppKit frame size NSHostingView converges the window to.
        .frame(width: morph.activeWindowSize.width, height: morph.activeWindowSize.height)
    }

    // MARK: - composerBody (v1 GlassFieldView.swift:313-438, verbatim minus dashboard/chat/image)

    @ViewBuilder
    private func composerBody(in windowSize: CGSize) -> some View {
        let composerTargetHeight = clampedComposerHeight()
        let composerFinal = composerFinalRect(in: windowSize, height: composerTargetHeight)
        let orbPoint = morph.corner.orbAnchorInWindow(
            windowSize: windowSize,
            morph: morph
        )
        let composerShape = morphedComposerRect(
            orbPoint: orbPoint,
            finalRect: composerFinal,
            progress: morph.progress
        )
        let navFinal = navPillFinalRect(
            in: windowSize,
            composerFinal: composerFinal
        )

        // Content reveals late in the morph so the expanding bubble reads
        // as "the empty glass shell still inflating" rather than as a
        // stretched-out pill with chrome visible at tiny sizes.
        let contentReveal = smoothstep(0.45, 0.74, morph.progress)
        let orbHaloIntensity = 1 - smoothstep(0.0, 0.28, morph.progress)
        let fieldHaloIntensity = smoothstep(0.90, 1.0, morph.progress)
        // Two distinct morph phases:
        // 1) 0.00...0.48: orb -> composer only.
        // 2) 0.50...1.00: top row splits out of composer.
        // On collapse this reverses naturally: side glass retracts first,
        // then the composer shrinks back into the orb.
        let glassSplitProgress = smoothstep(0.50, 1.0, morph.progress)
        let sideGlassReveal = smoothstep(0.50, 0.66, morph.progress)
        let sideGlassMaterialScale: CGFloat = sideGlassReveal > 0 ? 1 : 0
        let sideContentReveal = smoothstep(0.66, 1.0, morph.progress)
        let sideContentContainedReveal = sideContentReveal * smoothstep(0.94, 1.0, glassSplitProgress)
        let rendersSideGlass = morph.progress >= 0.48
        let collapsedCenter = CGPoint(x: composerShape.midX, y: composerShape.midY)
        // GATE-3 FIX (F3): the deleted pre-transplant `OrbView` showed its status pill whenever
        // `pillText != nil` (disconnected / needs-approval / n-of-m-working), NOT only while a
        // turn was actively running — gating this on `adapter.isThinking` (turnRunning) instead
        // meant the collapsed orb showed NO pill at all while disconnected or awaiting approval
        // (both states with `turnRunning == false`). `adapter.statusText` is now `""` exactly
        // when there's truly nothing to report (see its doc), so gating on non-emptiness here
        // restores that pill for every `OrbStatus`, matching v1's own reveal rule too
        // (`GlassFieldView.swift:273`: `if !appState.statusText.isEmpty { return
        // appState.statusText }`). Kept as `thinkingReveal` (not renamed) since it still drives
        // the SAME fade-in curve, now for "has a status pill" rather than strictly "is thinking."
        let hasStatusPill = !adapter.statusText.isEmpty
        let thinkingReveal = hasStatusPill
            ? 1 - smoothstep(0.04, 0.22, morph.progress)
            : 0
        let thinkingDirection: CGFloat = morph.corner.isLeft ? 1 : -1
        let thinkingPillCenter = CGPoint(
            x: collapsedCenter.x + thinkingDirection * 66,
            y: collapsedCenter.y
        )
        let navOrbRect = CGRect(
            x: navFinal.minX,
            y: navFinal.midY - morph.orbBubbleSize / 2,
            width: morph.orbBubbleSize,
            height: morph.orbBubbleSize
        )
        let navGlassRect = interpolatedRect(
            from: navOrbRect,
            to: navFinal,
            progress: glassSplitProgress
        )

        ZStack {
            composerMorphedContent(
                windowSize: windowSize,
                composerFinal: composerFinal,
                composerShape: composerShape,
                navFinal: navFinal,
                contentReveal: contentReveal,
                orbHaloIntensity: orbHaloIntensity,
                fieldHaloIntensity: fieldHaloIntensity,
                glassSplitProgress: glassSplitProgress,
                sideGlassReveal: sideGlassReveal,
                sideGlassMaterialScale: sideGlassMaterialScale,
                sideContentReveal: sideContentContainedReveal,
                rendersSideGlass: rendersSideGlass,
                collapsedCenter: collapsedCenter,
                thinkingReveal: thinkingReveal,
                thinkingPillCenter: thinkingPillCenter,
                navGlassRect: navGlassRect,
                haloColor: haloColor
            )
        }
        .frame(width: windowSize.width, height: windowSize.height)
        .onChange(of: adapter.isThinking) { _, running in
            // v2 "inline response" addition (not v1): a NEW turn starting is the only reliable
            // "the draft reveal is done" signal — mirrors Field/FieldView.swift's identical rule.
            if running {
                adapter.showingDraft = false
            }
        }
    }

    // MARK: - composerMorphedContent (v1 GlassFieldView.swift:440-721, minus image/chat/dashboard)

    @ViewBuilder
    private func composerMorphedContent(
        windowSize: CGSize,
        composerFinal: CGRect,
        composerShape: CGRect,
        navFinal: CGRect,
        contentReveal: Double,
        orbHaloIntensity: Double,
        fieldHaloIntensity: Double,
        glassSplitProgress: Double,
        sideGlassReveal: Double,
        sideGlassMaterialScale: CGFloat,
        sideContentReveal: Double,
        rendersSideGlass: Bool,
        collapsedCenter: CGPoint,
        thinkingReveal: Double,
        thinkingPillCenter: CGPoint,
        navGlassRect: CGRect,
        haloColor: Color
    ) -> some View {
        ZStack {
            if orbHaloIntensity > 0 {
                BreathingHalo(
                    center: collapsedCenter,
                    width: max(composerShape.width, morph.orbBubbleSize),
                    height: max(composerShape.height, morph.orbBubbleSize),
                    cornerRadius: morphedCornerRadius(for: composerShape),
                    intensity: orbHaloIntensity,
                    color: haloColor
                )
            }

            // Wave-3 gate item 2c: the collapsed orb soft-blinks while a finished reply is
            // waiting unread (`adapter.hasUnread`, set by `GlassRootView`'s turn-completion
            // handler when the cursor wasn't calm enough to auto-expand into it). Gated on
            // `orbHaloIntensity` (same fade-with-progress curve as the halo above it) so the
            // blink fades out the instant the user starts expanding — any summon clears
            // `hasUnread` anyway (see that property's doc).
            if adapter.hasUnread, orbHaloIntensity > 0 {
                UnreadBlinkOverlay(
                    center: collapsedCenter,
                    size: max(composerShape.width, morph.orbBubbleSize),
                    cornerRadius: morphedCornerRadius(for: composerShape),
                    intensity: orbHaloIntensity
                )
            }

            if fieldHaloIntensity > 0 {
                BreathingHalo(
                    center: CGPoint(x: composerFinal.midX, y: composerFinal.midY),
                    width: composerFinal.width,
                    height: composerFinal.height,
                    cornerRadius: morphedCornerRadius(for: composerFinal),
                    intensity: fieldHaloIntensity,
                    color: haloColor
                )
            }

            GlassEffectContainer(spacing: 6) {
                ZStack {
                    let composerCornerRadius = morphedCornerRadius(for: composerShape)
                    let composerGlassShape = RoundedRectangle(
                        cornerRadius: composerCornerRadius,
                        style: .continuous
                    )
                    composerGlassShape
                        .fill(Color.clear)
                        .frame(width: composerShape.width, height: composerShape.height)
                        .glassEffect(.regular, in: composerGlassShape)
                        .glassEffectID("composer-shell", in: glassNamespace)
                        .glassEffectTransition(.matchedGeometry)
                        .position(x: composerShape.midX, y: composerShape.midY)

                    if !navSegments.isEmpty {
                        NativeGlassCapsuleSurface(
                            id: "top-row",
                            namespace: glassNamespace,
                            width: navGlassRect.width * sideGlassMaterialScale,
                            height: navGlassRect.height * sideGlassMaterialScale
                        )
                        .position(x: navGlassRect.midX, y: navGlassRect.midY)
                        .allowsHitTesting(false)
                    }

                    if thinkingReveal > 0 {
                        // The glass-only layer (no visible text) doesn't
                        // need the live caption, but threading it through
                        // keeps the capsule width consistent with the
                        // inked layer above.
                        FieldThinkingPill(caption: adapter.statusText, contentOpacity: 0, drawsGlass: true)
                            .fixedSize()
                            .position(x: thinkingPillCenter.x, y: thinkingPillCenter.y)
                            .allowsHitTesting(false)
                    }
                }
            }
            .id(morph.glassRefreshGeneration)

            RoundedRectangle(
                cornerRadius: morphedCornerRadius(for: composerShape),
                style: .continuous
            )
            .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
            .frame(width: composerShape.width, height: composerShape.height)
            .position(x: composerShape.midX, y: composerShape.midY)
            .modifier(GlassForegroundLegibility())
            .allowsHitTesting(false)

            if rendersSideGlass, !navSegments.isEmpty {
                Capsule(style: .continuous)
                    .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
                    .frame(width: navGlassRect.width, height: navGlassRect.height)
                    .position(x: navGlassRect.midX, y: navGlassRect.midY)
                    .opacity(sideGlassReveal)
                    .modifier(GlassForegroundLegibility())
                    .allowsHitTesting(false)
            }

            // v1's ComposerSideFocusGlowLayer (keyboard-focus ring on the reset/clear icons) is
            // cut here — see the file header's FOCUS COORDINATOR note.

            composerOrResponseContent
                .frame(width: composerFinal.width, height: composerFinal.height)
                .position(x: composerFinal.midX, y: composerFinal.midY)
                .opacity(contentReveal)
                .modifier(GlassForegroundLegibility())
            // NOTE: no `.allowsHitTesting(false)` here, unlike v1 — this layer holds the actual
            // interactive text view / buttons and v2's field is NOT mouse-inert while expanded
            // (see the file header's FOCUS COORDINATOR note), so it must stay hit-testable.

            // v1's NavigationFocusGlow (keyboard-focus ring on nav pill segments) is cut here —
            // same reason as ComposerSideFocusGlowLayer above.

            if !navSegments.isEmpty {
                NavigationPill(
                    segments: navSegments,
                    focusedID: nil,
                    activeFill: haloColor.opacity(0.18),
                    drawsGlass: false,
                    drawsBorder: false,
                    surfaceSize: navGlassRect.size
                )
                .fixedSize()
                .opacity(sideContentReveal)
                .clipShape(Capsule(style: .continuous))
                .position(x: navGlassRect.midX, y: navGlassRect.midY)
                .modifier(GlassForegroundLegibility())
                .allowsHitTesting(false)
            }

            if thinkingReveal > 0 {
                FieldThinkingPill(caption: adapter.statusText, contentOpacity: thinkingReveal, drawsGlass: false)
                    .fixedSize()
                    .position(x: thinkingPillCenter.x, y: thinkingPillCenter.y)
                    .modifier(GlassForegroundLegibility())
                    .allowsHitTesting(false)
            }
        }
    }

    // MARK: Composer content (v1 GlassFieldView.swift:942-986, reduced) vs inline response
    // (v2's OWN design, ported into v1's chrome — see file header's INLINE RESPONSE note)

    /// v1 parity: the inline response occupies the shell whenever there's something to show,
    /// unless the user asked to see the draft again (`adapter.showingDraft`) — or a fresh summon
    /// forced it (see `FieldStateAdapter.showingDraft`'s doc + `GlassRootView`'s `.field` case).
    private var showsInlineResponse: Bool { hasReply && !adapter.showingDraft }

    private var hasReply: Bool {
        adapter.isThinking || !(adapter.visibleResponse?.isEmpty ?? true)
    }

    /// Turn running, nothing streamed yet — the shimmer-only "thinking" state.
    private var isThinkingOnly: Bool {
        adapter.isThinking && (adapter.visibleResponse?.isEmpty ?? true)
    }

    private var replyText: String { adapter.visibleResponse ?? "" }

    @ViewBuilder
    private var composerOrResponseContent: some View {
        if showsInlineResponse {
            inlineResponse
        } else {
            composerContent
        }
    }

    // MARK: Shared composer/response insets (gate wave-3 text-alignment fix)
    //
    // v1 canonical composerContent padding (GlassFieldView.swift:943-986): 12pt horizontal / 6pt
    // vertical around an HStack(spacing: 8) whose leading column is a fixed 26pt icon slot. Before
    // this fix, `inlineResponse` used a DIFFERENT, uniform 12pt padding on every side with no
    // leading reservation for that icon column — reply text started ~34pt to the LEFT of where
    // composer text actually starts (12 + 26 + 8) and 6pt lower, so the composer↔response swap
    // visibly jumped both horizontally and vertically (user report: "just need to align it
    // properly"). Both branches now share these same named constants instead of each hardcoding
    // its own magic numbers.
    private static let contentHorizontalPadding: CGFloat = 12
    private static let contentVerticalPadding: CGFloat = 6
    private static let iconColumnWidth: CGFloat = 26
    private static let iconColumnSpacing: CGFloat = 8
    /// Where composer TEXT starts, measured from the shell's leading edge — `inlineResponse`
    /// mirrors this exactly so reply text starts at the same x as composer text.
    private static let textLeadingInset: CGFloat =
        contentHorizontalPadding + iconColumnWidth + iconColumnSpacing

    @ViewBuilder
    private var composerContent: some View {
        HStack(alignment: .center, spacing: Self.iconColumnSpacing) {
            VStack(alignment: .center, spacing: 6) {
                // v1's reset icon ("arrow.counterclockwise", GlassFieldView.swift:946-949) has no
                // backing action in FieldStateAdapter's contract (no context-reset hook in the
                // brief's enumerated callback list) — kept as an equally-sized empty spacer so
                // this column doesn't reflow when a real action is wired in later; only the clear
                // button below is actually live.
                Color.clear.frame(width: Self.iconColumnWidth, height: Self.iconColumnWidth)
                if showsClearButton {
                    Button(action: adapter.onClearMessage) {
                        FieldIconButton(icon: "xmark", isFocused: false)
                    }
                    .buttonStyle(.plain)
                }
            }

            ComposerTextView(
                text: adapter.draftBinding,
                onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                onContentHeightChange: { height in composerContentHeight = height }
            )
            .overlay(alignment: .topLeading) {
                if adapter.composerDraft.isEmpty {
                    // Offset by the SAME textContainerInset/lineFragmentPadding the real
                    // NSTextView renders its glyphs at (`ComposerTextView.textContainerInset`) —
                    // without this the placeholder sat flush at (0,0) while the caret/first
                    // glyph render ~2pt right / 4pt down from there, so the placeholder visibly
                    // overlapped the caret (user report: "placeholder overlapping the caret").
                    Text("Ask Norma…")
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.5)) // difference-blend-safe placeholder
                        .padding(.leading, ComposerTextView.textContainerInset.width
                            + ComposerTextView.lineFragmentPadding)
                        .padding(.top, ComposerTextView.textContainerInset.height)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: max(22, min(composerContentHeight, morph.composerMaxHeight - 22)))
        }
        .padding(.horizontal, Self.contentHorizontalPadding)
        .padding(.vertical, Self.contentVerticalPadding)
    }

    private var showsClearButton: Bool {
        let hasText = !adapter.composerDraft
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
        return hasText && composerContentHeight >= 55
    }

    /// v2's inline-response shell (`Field/FieldView.swift`'s `inlineResponse`), ported into v1's
    /// composer chrome. Task B adds back `displayedPrompt`/`historyPositionText` (dropped by task
    /// A — see the file header's INLINE RESPONSE note): a swipe-pinned historical exchange now
    /// shows its own prompt small above the reply, plus an "n/m" position readout next to the
    /// draft-reveal chevron, exactly like the pre-transplant `Field/FieldView.swift` did.
    private var inlineResponse: some View {
        ZStack(alignment: .topTrailing) {
            // GeometryReader hands the ScrollView's own (== composerFinal's) height down so
            // short replies can be vertically centered instead of pinned to the top — a
            // ScrollView always reports "fill the box" as its OWN size (that's how scrolling
            // works), so the outer `.frame(...).center` composerOrResponseContent gets wrapped
            // in (composerMorphedContent) never reaches this far in: a short reply otherwise
            // sat flush against the top of a much taller pill (user report: "riding high").
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        if let prompt = adapter.displayedPrompt {
                            Text(prompt)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if !replyText.isEmpty {
                            Text(replyText)
                                .font(.system(size: 13))
                                // GATE-3 F6b: under GlassForegroundLegibility's difference blend,
                                // .primary is BLACK in Light mode -> |0 - bg| = bg -> invisible.
                                // Pure white is the only correct foreground here (same rule as the
                                // composer text and thinking pill; see the F2 comment below).
                                .foregroundStyle(.white)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if isThinkingOnly {
                            shimmerRow
                        }
                    }
                    // Same leading/trailing/vertical insets as `composerContent` (see the shared
                    // constants above the type header) — `textLeadingInset` reserves the exact
                    // same 12+26+8 gutter the composer's icon column occupies, so this text's
                    // leading edge lands on the SAME x as composer text; the trailing/vertical
                    // paddings mirror the composer's outer 12h/6v exactly.
                    .padding(.leading, Self.textLeadingInset)
                    .padding(.trailing, Self.contentHorizontalPadding)
                    .padding(.vertical, Self.contentVerticalPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Short content centers within the available pill height; long content
                    // (natural height already >= proxy.size.height) is unaffected and scrolls
                    // normally, top-anchored, exactly as before.
                    .frame(minHeight: proxy.size.height, alignment: .center)
                }
            }

            HStack(spacing: 6) {
                if let historyPositionText = adapter.historyPositionText {
                    Text(historyPositionText)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .modifier(GlassSurface(drawsBorder: false))
                }
                revealDraftButton
            }
            .padding(6)
        }
    }

    /// v1's `onTextFieldRightEdge` seam (see file header), ported as a visible trailing chevron
    /// rather than a caret-position-triggered key handler (there is no caret-navigation surface
    /// left to trigger it — see FOCUS COORDINATOR note).
    private var revealDraftButton: some View {
        Button {
            adapter.showingDraft = true
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
    }

    /// v1 LAW (PointerRenderer.swift:28-39): the animation lives INSIDE this Group, not on an
    /// outer view, so it doesn't get canceled by an unrelated transaction (e.g. the reply text
    /// arriving). No `.drawingGroup()` anywhere in this file either — that would rasterize and
    /// freeze the shimmer.
    private var shimmerRow: some View {
        Group {
            Text("…")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                .opacity(0.35 + 0.5 * shimmer)
        }
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: true)) {
                shimmer = 1.0
            }
        }
    }

    // MARK: Nav pill segments (v1 GlassFieldView.swift:988-1009 read settings/autoRaise/
    // keepAwake feature toggles that don't exist in v2 yet — see the file header's CUT note)

    /// v1's segments all read `appState` feature toggles that don't exist in v2 — the nav pill's
    /// CHROME (`NavigationPill`/`SegmentCell`/`NativeGlassCapsuleSurface`, and the split-phase
    /// morph driving it above) is kept verbatim so a later wave can populate real segments; there
    /// is simply nothing to show yet, so this is empty and the pill doesn't render (see the
    /// `!navSegments.isEmpty` guards above).
    private var navSegments: [NavigationPill.Segment] { [] }

    // MARK: Layout helpers (v1 GlassFieldView.swift:1014-1119, minus dashboard/image variants)

    /// Clamp the content-measured text height into the composer pill range.
    private func clampedComposerHeight() -> CGFloat {
        let chromeHeight: CGFloat = 22 // vertical padding on the HStack
        let pillHeight = composerContentHeight + chromeHeight
        return min(morph.composerMaxHeight,
                   max(morph.composerMinHeight, pillHeight))
    }

    /// Final (settled) composer rectangle in window SwiftUI coords. The composer is always
    /// sandwiched under the nav pill (above) — v1 also reserved a screenshot-pill slot below for
    /// bottom corners (GlassFieldView.swift:1037-1041); that reservation is gone since images are
    /// cut, so bottom corners now just sit flush against the window bottom.
    private func composerFinalRect(in windowSize: CGSize, height: CGFloat) -> CGRect {
        let width = morph.composerWidth
        let P = morph.haloPadding
        let navOffset = morph.navPillHeight + morph.interPillGap
        let x: CGFloat = morph.corner.isLeft ? P : (windowSize.width - P - width)
        let y: CGFloat
        if morph.corner.composerOnTop {
            // Orb is at composer's top corner; nav pill sits above it.
            y = P + navOffset
        } else {
            // Orb is at composer's bottom corner; composer sits at the window bottom.
            y = windowSize.height - P - height
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Nav pill rectangle in window SwiftUI coords. Always sits ABOVE the
    /// composer (smaller SwiftUI y), aligned to the same horizontal edge.
    private func navPillFinalRect(in windowSize: CGSize, composerFinal: CGRect) -> CGRect {
        let width = min(morph.navPillMaxWidth, composerFinal.width - 40)
        let height = morph.navPillHeight
        let x: CGFloat = morph.corner.isLeft
            ? composerFinal.minX + height + morph.interPillGap
            : composerFinal.maxX - width
        let y = composerFinal.minY - morph.interPillGap - height
        return CGRect(x: x, y: y, width: width, height: height)
    }

    // MARK: Morph geometry (v1 GlassFieldView.swift:1204-1262, dashboard variants dropped)

    /// The current composer rectangle for the given morph progress. At
    /// progress=0 it's a small bubble centered on the orb; at progress=1 it's
    /// the final composer rect docked at the chosen corner.
    private func morphedComposerRect(
        orbPoint: CGPoint,
        finalRect: CGRect,
        progress: Double
    ) -> CGRect {
        let p = max(0, min(1, progress))
        let bubbleSize = morph.orbBubbleSize
        let heightProgress = CGFloat(smoothstep(0.0, 0.42, p))
        let widthProgress = CGFloat(smoothstep(0.10, 0.48, p))
        let travelProgress = CGFloat(smoothstep(0.08, 0.48, p))

        let width = bubbleSize + (finalRect.width - bubbleSize) * widthProgress
        let height = bubbleSize + (finalRect.height - bubbleSize) * heightProgress

        let centerX = orbPoint.x + (finalRect.midX - orbPoint.x) * travelProgress
        let centerY = orbPoint.y + (finalRect.midY - orbPoint.y) * travelProgress

        return CGRect(
            x: centerX - width / 2,
            y: centerY - height / 2,
            width: width,
            height: height
        )
    }

    /// Corner radius is circular at bubble size; transitions into the fixed
    /// pill radius as the shape grows.
    private func morphedCornerRadius(for rect: CGRect) -> CGFloat {
        let shorter = min(rect.width, rect.height)
        let circleRadius = shorter / 2
        let pillRadius = min(shorter / 2, 22)
        let t = min(1, max(0, (shorter - 48) / 60))
        return circleRadius * (1 - t) + pillRadius * t
    }
}

// MARK: - GlassForegroundLegibility (v1 GlassFieldView.swift:1285-1291, verbatim)

/// Inverts the foreground (icons, text, strokes) against whatever is
/// behind the field window using `.blendMode(.difference)`. With a pure
/// white source — see `GlassChromeColor` and its foreground colors —
/// `white − bg = inverse(bg)` per channel, so the chrome reads as the
/// inverse of the glass surface beneath it.
///
/// `.compositingGroup()` flattens the wrapped subtree first so internal
/// stacking (icon over its focus pill, text in a cell with a divider
/// next to it) doesn't difference-blend against itself. Without it, the
/// blend would compose layer-by-layer inside the subtree and produce
/// odd colour stacking instead of one clean inversion.
private struct GlassForegroundLegibility: ViewModifier {
    func body(content: Content) -> some View {
        content
            .compositingGroup()
            .blendMode(.difference)
    }
}

// MARK: - BreathingHalo (v1 GlassFieldView.swift:1299-1370, verbatim)

/// Soft blue glow placed directly behind the morphing composer pill. Sized
/// to the composer so the glow hugs the pill rather than floating. Blur
/// radius is tuned to stay inside the window's `haloPadding` so the edge of
/// the blur never hits the window border and hard-cuts.
struct BreathingHalo: View {
    var center: CGPoint
    var width: CGFloat
    var height: CGFloat
    /// The composer container's own corner radius. We derive the halo's
    /// corner radius from this so the glow tracks the container shape
    /// (rounded-rect at multi-line heights, capsule at single-line) instead
    /// of being forced into a capsule by `height / 2`.
    var cornerRadius: CGFloat
    var intensity: Double
    var color: Color

    var body: some View {
        if shouldAnimateBreathing {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                let t = timeline.date.timeIntervalSinceReferenceDate
                let breath = 0.5 + 0.5 * sin(t * (.pi * 2 / 4.5))
                haloLayers(breathOpacity: 0.8 + 0.2 * breath)
            }
        } else {
            haloLayers(breathOpacity: 1.0)
        }
    }

    private var shouldAnimateBreathing: Bool {
        width * height < 360_000
    }

    private func haloLayers(breathOpacity: Double) -> some View {
        let outerExtension: CGFloat = 8
        let midExtension: CGFloat = 4
        let edgeExtension: CGFloat = 1

        let outerWidth = width + outerExtension * 2
        let outerHeight = height + outerExtension * 2
        let midWidth = width + midExtension * 2
        let midHeight = height + midExtension * 2
        let edgeWidth = width + edgeExtension * 2
        let edgeHeight = height + edgeExtension * 2

        return ZStack {
            RoundedRectangle(cornerRadius: cornerRadius + outerExtension, style: .continuous)
                .strokeBorder(
                    color
                        .opacity(0.55 * breathOpacity * intensity),
                    lineWidth: 10
                )
                .frame(width: outerWidth, height: outerHeight)
                .blur(radius: 12)

            RoundedRectangle(cornerRadius: cornerRadius + midExtension, style: .continuous)
                .strokeBorder(
                    color
                        .opacity(0.45 * intensity),
                    lineWidth: 4
                )
                .frame(width: midWidth, height: midHeight)
                .blur(radius: 5)

            RoundedRectangle(cornerRadius: cornerRadius + edgeExtension, style: .continuous)
                .strokeBorder(
                    color
                        .opacity(0.35 * intensity),
                    lineWidth: 1
                )
                .frame(width: edgeWidth, height: edgeHeight)
                .blur(radius: 1)
        }
        .position(x: center.x, y: center.y)
        .allowsHitTesting(false)
    }
}

// MARK: - UnreadBlinkOverlay (wave-3 gate item 2c)

/// A soft bluish tint pulse on the collapsed orb, signaling a finished reply the user hasn't
/// seen yet (`FieldStateAdapter.hasUnread` — set when a turn completed while the cursor was
/// moving too fast to auto-expand into, see `GlassRootView.handleTurnCompleted()`).
///
/// v1 LAW (PointerRenderer.swift:28-39): the animation lives INSIDE this Group, not on an outer
/// view, so it doesn't get canceled by an unrelated transaction (e.g. the morph progressing) —
/// same rule `shimmerRow` follows. No `.drawingGroup()` here either, for the same reason.
private struct UnreadBlinkOverlay: View {
    var center: CGPoint
    var size: CGFloat
    var cornerRadius: CGFloat
    var intensity: Double

    @State private var pulse = 0.0

    var body: some View {
        Group {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                // 0.25...0.6 opacity pulse, per the wave-3 gate spec.
                .fill(Color.blue.opacity((0.25 + 0.35 * pulse) * intensity))
                .frame(width: size, height: size)
                .position(x: center.x, y: center.y)
                .allowsHitTesting(false)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                pulse = 1.0
            }
        }
    }
}

// MARK: - Nav pill (v1 GlassFieldView.swift:1900-1959, `Segment.id` retyped — see below)

/// GlassEffectID has to live on the actual view receiving `.glassEffect`.
/// Keeping these material-only shapes inside GlassEffectContainer lets the
/// system morph the glass while the foreground text/icons stay above it.
private struct NativeGlassCapsuleSurface: View {
    let id: String
    let namespace: Namespace.ID
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        Capsule(style: .continuous)
            .fill(Color.clear)
            .frame(width: width, height: height)
            .glassEffect(.regular, in: Capsule(style: .continuous))
            .glassEffectID(id, in: namespace)
            .glassEffectTransition(.matchedGeometry)
    }
}

/// v1's `NavigationPill` (GlassFieldView.swift:1835-1893), verbatim except `Segment.id`: v1 typed
/// it `FieldFocusCoordinator.Target` (the keyboard-focus target enum); with that coordinator
/// stubbed (see file header), there is no such type here, so `id` is a plain `String`.
private struct NavigationPill: View {
    struct Segment: Identifiable {
        let id: String
        let icon: String
        let label: String
        let isOn: Bool
        var showsLabel: Bool = true
    }

    let segments: [Segment]
    let focusedID: String?
    var activeFill: Color = Color.white.opacity(0.18)
    var drawsGlass: Bool = true
    var contentOpacity: Double = 1
    var drawsBorder: Bool = true
    var surfaceSize: CGSize?

    @ViewBuilder
    var body: some View {
        if drawsGlass {
            sizedContent
                .modifier(GlassSurface(cornerRadius: 22, drawsBorder: drawsBorder))
        } else {
            sizedContent
                .overlay(borderOverlay)
        }
    }

    private var sizedContent: some View {
        content
            .frame(width: surfaceSize?.width, height: surfaceSize?.height)
    }

    private var content: some View {
        HStack(spacing: 0) {
            ForEach(segments) { segment in
                SegmentCell(
                    icon: segment.icon,
                    label: segment.label,
                    isOn: segment.isOn,
                    isFocused: focusedID == segment.id,
                    showsLabel: segment.showsLabel,
                    activeFill: activeFill
                )
            }
        }
        .opacity(contentOpacity)
        .padding(.horizontal, 3)
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private var borderOverlay: some View {
        if drawsBorder {
            Capsule(style: .continuous)
                .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
        }
    }
}

private struct SegmentCell: View {
    let icon: String
    let label: String
    let isOn: Bool
    let isFocused: Bool
    let showsLabel: Bool
    let activeFill: Color
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .medium))
            if showsLabel {
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .foregroundStyle(foregroundColor)
        .accessibilityLabel(label)
        .padding(.horizontal, showsLabel ? 10 : 8)
        .padding(.vertical, 5)
        .background(
            Capsule(style: .continuous)
                .fill(backgroundFill)
        )
        .contentShape(Rectangle())
    }

    private var foregroundColor: Color {
        if isFocused { return GlassChromeColor.focusedForeground }
        if isOn { return GlassChromeColor.accent }
        return GlassChromeColor.secondaryForeground(for: colorScheme)
    }

    private var backgroundFill: Color {
        if isOn {
            return activeFill
        }
        return .clear
    }
}

// MARK: - FieldThinkingPill (v1 GlassFieldView.swift:2563-2595, verbatim)

private struct FieldThinkingPill: View {
    var caption: String = "thinking..."
    var contentOpacity: Double = 1
    var drawsGlass = true

    var body: some View {
        ZStack {
            if drawsGlass {
                Capsule()
                    .fill(Color.clear)
                    .glassEffect(.regular, in: Capsule())
            } else {
                Capsule()
                    .strokeBorder(.white.opacity(0.5), lineWidth: 1)
            }

            // White (not .primary) so the outer GlassForegroundLegibility
            // wrap produces a clean inversion. `.primary` resolves to
            // black in light mode and white in dark mode, which is
            // already the inverse of the typical glass background —
            // diff-blending it would yield near-white in both modes.
            Text(caption)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
                .truncationMode(.tail)
                .opacity(contentOpacity)
                .padding(.horizontal, 14)
        }
        .frame(minWidth: 82, maxWidth: 220, minHeight: 28, idealHeight: 28, maxHeight: 28)
        .fixedSize(horizontal: true, vertical: true)
    }
}

// MARK: - FieldIconButton (v1 GlassFieldView.swift:2599-2613, verbatim)

private struct FieldIconButton: View {
    var icon: String
    var isFocused: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(isFocused ? GlassChromeColor.focusedForeground : GlassChromeColor.secondaryForeground(for: colorScheme))
            .frame(width: 26, height: 26)
            .background(
                Circle().fill(Color.clear)
            )
    }
}

// MARK: - GlassChromeColor (v1 GlassFieldView.swift:2628-2641, verbatim)

/// Shared foreground/accent palette for all controls drawn on top of the
/// Liquid Glass surfaces. Composer text uses the same all-white source as
/// this palette (`Field/ComposerTextView.swift`'s `textColor`/typing
/// attributes) — GATE-3 FIX (F2): an earlier revision of this comment
/// claimed `ComposerTextView` used `.labelColor` because it "isn't drawn
/// through `GlassForegroundLegibility`'s difference blend"; that premise was
/// false — `composerOrResponseContent` above (which hosts `ComposerTextView`
/// while composing) IS wrapped in `.modifier(GlassForegroundLegibility())`
/// just like every other layer here, so `.labelColor` washed out to
/// near-invisible text under the difference blend (the exact "washed-out
/// full white symptom" the paragraph below describes). Fixed to `.white`.
///
/// Every glyph/label colour here is **pure white** — no light/dark-mode
/// branching. The chrome is rendered through `GlassForegroundLegibility`
/// (`.blendMode(.difference)`), and difference inverts cleanly only when
/// the source is white (`white − bg = inverse(bg)` per channel). Any
/// non-white source would push the result toward muddy mid-tones in one
/// of the two appearances. Colour-coded states survive through separate
/// normal-colour glow/fill layers underneath this foreground subtree.
private enum GlassChromeColor {
    static let focusedForeground = Color.white
    /// White so the "on" label/icon stays readable after the difference
    /// blend. The active capsule underneath carries the user accent.
    static let accent = Color.white
    static let divider = Color(nsColor: .systemGray).opacity(0.28)

    /// White in both appearances. The `colorScheme` parameter is kept
    /// in the signature so call sites that pass `@Environment(\.colorScheme)`
    /// don't have to be touched if we ever reintroduce a per-mode tint.
    static func secondaryForeground(for colorScheme: ColorScheme) -> Color {
        Color.white
    }
}
