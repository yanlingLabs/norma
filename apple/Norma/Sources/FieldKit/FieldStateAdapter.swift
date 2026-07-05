import Foundation
import Combine
import SwiftUI

/// The ONLY new design in this transplant (everything else in `FieldKit/` is a direct v1 port).
/// A thin, v1-shaped facade over `SessionModel` so `NormaFieldView` (copied from v1
/// `GlassFieldView`'s composer path) can read exactly the surface v1's `AppState` used to
/// provide — `statusText`, `isThinking`, `visibleResponse`, a settable composer draft, and three
/// callbacks — without `NormaFieldView` knowing our session/event model exists at all. Every
/// place the copied view used to read `appState.X` now reads `adapter.X` (see `NormaFieldView`'s
/// header comment for the full read-by-read rebind list).
///
/// Task B is expected to either keep this adapter driving a live `SessionModel` (as constructed
/// here), or fold its logic directly into whatever wires `NormaFieldView` into the running app —
/// this file is deliberately small and boring so that swap is cheap either way.
@MainActor
final class FieldStateAdapter: ObservableObject {
    private let session: SessionModel
    private var cancellable: AnyCancellable?

    init(session: SessionModel) {
        self.session = session
        // Republish the session's own changes as our own — `statusText`/`isThinking`/
        // `visibleResponse` below are computed (not `@Published`) so they always read `session`
        // live; this is what makes `@ObservedObject var adapter: FieldStateAdapter` in the view
        // actually re-render when the underlying session changes.
        cancellable = session.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    // MARK: - v1's composer-display surface (Core/AppState.swift:160-171's `composerDisplayText`)

    /// v1 `GlassFieldView.narrationCaption` (GlassFieldView.swift:271-275), rebound to
    /// `SessionModel`'s own pill vocabulary — v1's `appState.modelStatusText` / `.statusText`
    /// free-form narration slots have no v2 equivalent, so this reads `workingPillText` while a
    /// turn is running against known tasks, else `OrbStatus.pillText`, else v1's literal
    /// "thinking..." default (only reachable if `turnRunning` is somehow true while `status` is
    /// still `.idle` — the reducer never actually produces that combination, since
    /// `.turnStarted` sets both together, but this is the same defensive fallback the pre-fix
    /// code had).
    ///
    /// GATE-3 FIX (F3): only returns `""` when there is truly nothing to report (`status ==
    /// .idle` and no turn running) — this is deliberate, not a leftover gap: the collapsed-orb
    /// pill's reveal condition (`NormaFieldView`'s `hasStatusPill`) now gates directly on
    /// "`statusText` non-empty," mirroring the pre-transplant `OrbView.pillText`'s contract
    /// (nil only for true idle) and v1's own `narrationCaption` (`GlassFieldView.swift:273`:
    /// `if !appState.statusText.isEmpty { return appState.statusText }`). Before this fix the
    /// function ALWAYS returned a non-empty string (the `"thinking..."` fallback fired even at
    /// true idle), which — combined with a reveal condition keyed off this emptiness — would
    /// have shown a permanent bogus "thinking..." pill; keyed instead off `isThinking` (the
    /// prior, still-live bug), disconnected/needs-approval pills never showed at all outside an
    /// active turn. Covers every `OrbStatus` case: `.disconnected`/`.approvalNeeded`/
    /// `.toolRunning` all have non-nil `pillText` regardless of `turnRunning`; `.thinking` does
    /// too ("thinking…"); only `.idle` is nil, and only then (with no turn running) is `""`
    /// returned.
    var statusText: String {
        let counts = session.state.taskCounts
        let text: String
        if session.state.turnRunning, counts.total > 0 {
            text = workingPillText(done: counts.done, total: counts.total)
        } else if let pillText = session.state.status.pillText {
            text = pillText
        } else {
            text = session.state.turnRunning ? "thinking..." : ""
        }
        // Gate-3 (F3) empirical evidence hook: NORMA_ORB_DEBUG=1 traces every actual change so a
        // "disconnected" pill (or any other non-empty status) reaching the collapsed orb can be
        // observed directly from a headless launch, without a screenshot.
        if text != lastLoggedStatusText {
            lastLoggedStatusText = text
            OrbDebug.log("FieldStateAdapter.statusText → \(text.isEmpty ? "<empty>" : "\"\(text)\"")")
        }
        return text
    }

    private var lastLoggedStatusText: String?

    /// v1's `appState.presentationMode == .thinking` seam — rebound 1:1 to `state.turnRunning`
    /// (2c/2e has no separate "presentation mode," turnRunning is the only signal there is).
    var isThinking: Bool { session.state.turnRunning }

    /// v1's `appState.composerDisplayText` swap-in (Core/AppState.swift:160-171): the live
    /// stream wins while it's non-empty; otherwise the pinned/navigated exchange's reply
    /// (`exchangeIndex`, mirroring `OrbWindowController.exchangeIndex`'s 2-finger-swipe
    /// convention) if one is set and non-empty; otherwise the most recent exchange's reply;
    /// otherwise the pre-`exchanges` `lastReply` fallback. `nil` means "nothing to show" — the
    /// view falls back to the composer draft.
    var visibleResponse: String? {
        if !session.state.streamingText.isEmpty { return session.state.streamingText }
        if let index = exchangeIndex, session.state.exchanges.indices.contains(index) {
            let reply = session.state.exchanges[index].reply
            return reply.isEmpty ? nil : reply
        }
        if let reply = session.state.exchanges.last?.reply, !reply.isEmpty { return reply }
        return session.state.lastReply
    }

    /// Task B hook (mirrors `OrbWindowController.exchangeIndex`): which historical exchange, if
    /// any, `visibleResponse` should read instead of the live stream / most recent reply. `nil`
    /// = live/most-recent. Wired by `GlassRootView`'s `.onChange(of: controller.exchangeIndex)`
    /// (the 2-finger swipe recognizer's target lives on the controller, not here).
    @Published var exchangeIndex: Int?

    /// v1 parity restored (task B): `Field/FieldView.swift` (v2's pre-transplant approximation)
    /// showed the pinned exchange's own prompt, small, above its reply while browsing history —
    /// task A dropped this since the adapter's original spec only exposed the merged
    /// `visibleResponse` string, not exchange prompt/count. Non-`nil` only while `exchangeIndex`
    /// points at a real, non-empty prompt.
    var displayedPrompt: String? {
        guard let index = exchangeIndex, session.state.exchanges.indices.contains(index) else { return nil }
        let prompt = session.state.exchanges[index].prompt
        return prompt.isEmpty ? nil : prompt
    }

    /// v1 parity restored (task B): the subtle "n/m" position readout `Field/FieldView.swift`
    /// showed next to the draft-reveal chevron while browsing a swipe-pinned historical exchange.
    var historyPositionText: String? {
        guard let index = exchangeIndex, session.state.exchanges.indices.contains(index) else { return nil }
        return "\(index + 1)/\(session.state.exchanges.count)"
    }

    // MARK: - Composer draft

    /// v1's composer text (`appState.composerDisplayText` / `appState.updateComposerText`),
    /// collapsed to one settable string — paste/image/caret-navigation are all cut for this
    /// transplant (D7: text-only field). `draftBinding` below is the Binding-compatible wrapper
    /// the view actually consumes; an `ObservableObject` can't itself conform to `Binding`.
    @Published var composerDraft: String = ""

    var draftBinding: Binding<String> {
        Binding(get: { self.composerDraft }, set: { self.composerDraft = $0 })
    }

    /// GATE-3 FIX (round 3, F4): moved here (from a private `@State` inside `NormaFieldView`) so
    /// `GlassRootView` can drive it directly from `.onChange(of: controller.surface)` — the only
    /// place that knows "a fresh summon just happened." `true` = the composer/draft is what the
    /// shell shows; `false` = the inline response occupies the shell instead. v1's home-state
    /// contract: the COMPOSER is the default on every summon (see `GlassRootView`'s `.field` case
    /// for the one exception — an actively streaming turn). `NormaFieldView` still owns the two
    /// other writers: the reveal-draft chevron (`true`, user asked to see the draft again) and the
    /// turn-just-started transition (`false`, a new reply takes the shell back over).
    @Published var showingDraft: Bool = false

    // MARK: - Callbacks (task B wires real behavior)

    /// Wired by `GlassRootView` to its own `submit(_:)`, which forwards to
    /// `OrbWindowController.onSubmit` (the app-level send chain) and only clears the draft /
    /// resets `exchangeIndex` on a successful send — a failed send never loses the composed text.
    var onSubmit: (String) -> Void = { _ in }
    /// Wired by `GlassRootView` to clear `composerDraft` — the xmark button in `NormaFieldView`'s
    /// `composerContent`.
    var onClearMessage: () -> Void = {}
    /// Wired by `GlassRootView` to `OrbWindowController.collapseToOrb()`. No `NormaFieldView`
    /// affordance calls this yet (v1's own `onCollapse` was likewise driven almost entirely by
    /// Esc, which `OrbWindowController`'s key monitor already calls directly) — kept wired for
    /// parity/future use, same status as task A's unwired reset-icon slot.
    var onCollapse: () -> Void = {}
}
