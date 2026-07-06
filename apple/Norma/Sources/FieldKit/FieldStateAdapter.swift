import Foundation
import Combine
import SwiftUI

/// Task 2 (fluid orb): the three states the fluid-orb bubble can render — derived purely from
/// `SessionModel`'s turn/task/unread state by `FieldStateAdapter.fluidState` below. `.idle` means
/// no fluid view should even be mounted; the other two carry a fill `level` (0…1) the view maps to
/// the bubble's liquid height, plus a color (blue while working, amber while holding an unread
/// reply — the view owns that color choice, not this enum).
enum FluidState: Equatable {
    case idle
    case working(level: Double)
    case unread(level: Double)
}

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
    private var cancellables = Set<AnyCancellable>()

    init(session: SessionModel) {
        self.session = session
        // Republish the session's own changes as our own — `statusText`/`isThinking`/
        // `visibleResponse` below are computed (not `@Published`) so they always read `session`
        // live; this is what makes `@ObservedObject var adapter: FieldStateAdapter` in the view
        // actually re-render when the underlying session changes.
        cancellable = session.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }

        // Cache the task-completion fill level from the event stream (when state changes),
        // not from the getter's read-time side effect. This ensures that a fast
        // taskUpdated→turnCompleted burst hitting the same render doesn't drop the final
        // level (1.0) because the getter never ran between events.
        session.$state
            .sink { [weak self] newState in
                guard let self else { return }
                if newState.turnRunning {
                    let c = newState.taskCounts
                    self.lastWorkingLevel = c.total > 0 ? Double(c.done) / Double(c.total) : 0.5
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - v1's composer-display surface (Core/AppState.swift:160-171's `composerDisplayText`)

    /// v1 `GlassFieldView.narrationCaption` (GlassFieldView.swift:271-275), rebound to
    /// `SessionModel`'s own pill vocabulary — v1's `appState.modelStatusText` / `.statusText`
    /// free-form narration slots have no v2 equivalent.
    ///
    /// Wave 6 gate rework: `.thinking`/`.toolRunning` no longer read `OrbStatus.pillText` (it
    /// returns nil for both now) — they compose `workingVerbText(verb:)` + `workingCountText(...)`
    /// instead, so the collapsed pill shows the turn's CC-style whimsical verb ("Reticulating…")
    /// rather than a static "thinking…"/tool name, with "☑ n/m" as a separate chip positioned left
    /// of the orb. `.approvalNeeded`/`.disconnected` are checked FIRST and win outright even
    /// mid-turn — they're the only two `OrbStatus` cases whose `pillText` is non-nil, so this
    /// two-branch shape (status override, else working-verb composition) is exhaustive without a
    /// `default`/fallback case.
    ///
    /// GATE-3 FIX (F3, preserved): only returns `""` when there is truly nothing to report
    /// (`status == .idle` and no turn running) — the collapsed-orb pill's reveal condition
    /// (`NormaFieldView`'s `hasStatusPill`) gates directly on "`statusText` non-empty," mirroring
    /// the pre-transplant `OrbView.pillText`'s contract (nil only for true idle).
    ///
    /// Gate polish: split into `verbText` (right of orb) and `countText` (left of orb) for
    /// separate positioning — this property now re-composes them for backwards compatibility.
    var statusText: String {
        let s = session.state
        let text: String
        if let pillText = s.status.pillText {
            text = pillText // .approvalNeeded / .disconnected — override even mid-turn
        } else if s.turnRunning {
            let counts = s.taskCounts
            text = workingPillText(verb: s.workingVerb, hasActiveTask: s.hasActiveTask, done: counts.done, total: counts.total)
        } else {
            text = "" // true idle: status.pillText nil (.idle) and no turn running
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

    /// Gate polish: the animated verb text for the right-side pill ("Reticulating…", "Noodling…").
    /// Returns override status text for non-working states (.approvalNeeded, .disconnected),
    /// or the bare working verb while a turn is running, or empty string for true idle.
    var verbText: String {
        let s = session.state
        if let pillText = s.status.pillText {
            return pillText // .approvalNeeded / .disconnected — override even mid-turn
        } else if s.turnRunning {
            return workingVerbText(verb: s.workingVerb)
        } else {
            return "" // true idle
        }
    }

    /// Gate polish: the task-count chip text for the left-side chip ("☑ 1/4", "☑ 3/5").
    /// Returns the count suffix only while a task is in_progress; otherwise empty string.
    var countText: String {
        let s = session.state
        if s.turnRunning {
            let counts = s.taskCounts
            return workingCountText(hasActiveTask: s.hasActiveTask, done: counts.done, total: counts.total)
        } else {
            return ""
        }
    }

    /// Wave-7 gate item 2: true exactly when `statusText` is currently showing the CC-style
    /// working-verb composition (`workingPillText`) — i.e. the SAME branch of `statusText` above
    /// — as opposed to an override pill (`disconnected`/`needs approval`, which win outright even
    /// mid-turn) or true idle. `NormaFieldView`'s animated spinner + sheen (the star-frame glyph
    /// cycling + text sweep) is gated on this so only the actual "working" verb animates; the
    /// static override pills stay plain, unanimated text.
    var isWorkingVerb: Bool {
        let s = session.state
        return s.status.pillText == nil && s.turnRunning
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

    /// Wave-5 gate item 2: messages sent while a turn is running are folded silently into the
    /// current exchange's prompt (`SessionReducer`'s mid-turn-steer branch) — this surfaces them
    /// so `NormaFieldView` can render a small "⧗ queued: …" line instead of the send appearing to
    /// vanish. `nil` when nothing is queued (the common case: idle, or a turn running with no
    /// steer sent yet) so the view can gate the line's reveal on non-nil, same convention as
    /// `displayedPrompt`/`historyPositionText` above.
    var queuedText: String? {
        guard !session.state.queuedSteers.isEmpty else { return nil }
        return "queued: " + session.state.queuedSteers.joined(separator: "; ")
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

    /// Wave-3 gate item 2c: true when a turn finished with a reply while the cursor was moving
    /// too fast to auto-expand into (`GlassRootView`'s turn-completion handler, gated by
    /// `OrbFollower.isCursorCalm`) — signals the collapsed orb should soft-blink until the field
    /// is next summoned. Cleared unconditionally on every expand (`GlassRootView`'s
    /// `.onChange(of: controller.surface)` `.field` case) — any summon path counts as "read."
    @Published var hasUnread: Bool = false

    // MARK: - Task 2: fluid-orb state derivation

    /// Last fill level observed while `fluidState` computed `.working` — the level `.unread`
    /// holds once `hasUnread` flips true (the task/turn that produced the reply may already be
    /// gone by then: `turnCompleted` clears `turnRunning` before the wave-3 calm-check even marks
    /// the orb unread, see `OrbFollower.isCursorCalm`/`GlassRootView`'s turn-completion handler).
    /// Updated at READ time inside `fluidState` (simpler than mirroring a `hasUnread` setter
    /// observer, and just as correct: every `hasUnread` flip is preceded by at least one
    /// `.working` read while the turn was running, since `NormaFieldView`/`GlassRootView` poll
    /// `fluidState` continuously while mounted). Defaults to 0.5 — the same "no signal yet" level
    /// `taskLevel` itself falls back to — so an (unexercised in practice) unread-before-any-work
    /// edge case still renders a sane mid-fill bubble instead of an arbitrary stale value.
    private var lastWorkingLevel: Double = 0.5

    /// Derived, not stored: `hasUnread` wins outright (the reply is waiting, regardless of
    /// whether a new turn has already started since); otherwise `turnRunning` renders the current
    /// task-completion fill; otherwise — Finding-3 — the fluid HOLDS its level while any task is
    /// still incomplete (the WORK isn't done even though this turn ended), and only drains to
    /// `.idle` once every task is complete (or there were never any tasks).
    ///
    /// Finding-3 (gate 2): the fluid represents Norma's WORK, not just the current turn. A turn
    /// finishing with an incomplete task list (the agent paused between turns, or is waiting to be
    /// told to continue) used to drain the liquid to empty, reading as "all done" when it isn't.
    /// Now it holds `.working(level)` at the task-completion fill instead. Implementation choice
    /// (per the directive's "implementer's choice"): reuse `.working` rather than add a
    /// `.pausedWork` case — the fluid sim's slosh already decays naturally once the cursor (and so
    /// the tracking-spring acceleration feeding `FluidSim`) calms, so a held-but-idle bubble reads
    /// as "paused/settled" on its own, without a distinct dimmed case. Unread still wins above.
    var fluidState: FluidState {
        if hasUnread {
            return .unread(level: lastWorkingLevel)
        }
        let s = session.state
        let counts = s.taskCounts
        let level = counts.total > 0 ? Double(counts.done) / Double(counts.total) : 0.5
        if s.turnRunning {
            return .working(level: level)
        }
        // Turn ended: hold the fill while work remains (any task not yet completed); else drain.
        if counts.total > 0 && counts.done < counts.total {
            return .working(level: level)
        }
        return .idle
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
