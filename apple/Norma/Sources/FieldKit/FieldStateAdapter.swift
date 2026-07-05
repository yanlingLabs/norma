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
    /// "thinking..." default (`OrbStatus.pillText` returns `nil` for `.idle`).
    var statusText: String {
        let counts = session.state.taskCounts
        if session.state.turnRunning, counts.total > 0 {
            return workingPillText(done: counts.done, total: counts.total)
        }
        return session.state.status.pillText ?? "thinking..."
    }

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
