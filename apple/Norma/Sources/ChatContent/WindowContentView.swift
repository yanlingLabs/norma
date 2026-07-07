import SwiftUI

/// The chat window's content column — header (optional leading accessory + status), transcript,
/// pinned tasks, queued line, composer. Shared by the MORPH window (which injects its self-drawn
/// `MacTrafficLights`) and DETACHED windows (native chrome — no accessory, extra top inset for the
/// native titlebar via `topInset`).
///
/// Extracted verbatim from `WindowSurfaceView.windowContent(finalRect:)` — the traffic lights slot
/// generalizes to `headerAccessory`, and the hardcoded top padding (14) generalizes to `topInset`.
struct WindowContentView<Accessory: View>: View {
    @ObservedObject var adapter: FieldStateAdapter
    let tint: Color
    let topInset: CGFloat
    @ViewBuilder let headerAccessory: () -> Accessory

    /// Task 4 (2d-iii): the ⋯ menu's popover presentation state — local to this view (not the
    /// adapter), same convention as any other purely-presentational SwiftUI `@State` here; the
    /// adapter only owns the DATA the menu reads/writes (`sessionPolicy`/`policyChangeInFlight`).
    @State private var showingPolicyMenu = false

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                headerAccessory()
                Text(adapter.statusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                policyMenuButton
            }
            .frame(height: chatWindowHeaderHeight)

            TranscriptView(adapter: adapter, tint: tint)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Task 3 (2d-iii): the pending-interaction cards — mounted here, between the
            // transcript and the pinned-tasks section, in BOTH windows (the morph window's
            // `.window` surface and every native `DetachedWindowController`, since both render
            // this shared `WindowContentView`).
            if !adapter.pendingInteractions.isEmpty {
                PendingCardsView(
                    interactions: adapter.pendingInteractions,
                    inFlight: adapter.interactionInFlight,
                    errorLines: adapter.interactionErrors,
                    onApproval: adapter.onApprovalRespond,
                    onQuestion: adapter.onQuestionRespond,
                    onPlan: adapter.onPlanRespond
                )
            }

            if !adapter.pinnedTasks.isEmpty {
                pinnedTasksSection(adapter.pinnedTasks)
            }

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
        .padding(.top, topInset)
        .padding(.bottom, 16)
    }

    /// Task 4 (2d-iii): the header's trailing ⋯ button — opens `policyMenuContent`'s popover.
    /// Plain-styled (no button chrome) to sit quietly in the header row next to the status text.
    @ViewBuilder
    private var policyMenuButton: some View {
        Button {
            showingPolicyMenu = true
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingPolicyMenu, arrowEdge: .bottom) {
            policyMenuContent
        }
    }

    /// The ⋯ menu's first (and currently only) item: an inline auto|ask|plan picker for
    /// `adapter.sessionPolicy` — a checkmark marks the current value, rows disable while
    /// `adapter.policyChangeInFlight` (a change is already in flight; mirrors the pending-card
    /// buttons' own in-flight disable). Selecting a row fires `adapter.onSetPolicy` directly — the
    /// wirer (`GlassRootView`/`DetachedWindowController`) owns the in-flight/success bookkeeping,
    /// same convention as the three respond callbacks' card buttons.
    @ViewBuilder
    private var policyMenuContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Approval mode")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            ForEach(["auto", "ask", "plan"], id: \.self) { policy in
                Button {
                    adapter.onSetPolicy(policy)
                } label: {
                    HStack {
                        Text(policy.capitalized)
                        Spacer()
                        if adapter.sessionPolicy == policy {
                            Image(systemName: "checkmark")
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(adapter.policyChangeInFlight)
                .padding(.vertical, 4)
            }
        }
        .padding(12)
        .frame(minWidth: 160)
    }

    /// LIVE-GATE G4: the compact "what's left" list — up to 5 rows of `☐`/`◐`/`☑` + subject, with
    /// a "+N more" tail when there are more than 5. Hidden entirely when `adapter.pinnedTasks` is
    /// empty (the caller in `body` already gates on that), so this is pure rendering, no further
    /// emptiness logic here.
    @ViewBuilder
    func pinnedTasksSection(_ tasks: [TaskItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider().opacity(0.5)
            ForEach(Array(tasks.prefix(5).enumerated()), id: \.offset) { _, task in
                HStack(spacing: 6) {
                    Text(pinnedTaskGlyph(task.status))
                    Text(task.subject)
                }
                .font(.system(size: 11))
                .foregroundStyle(task.status == "in_progress" ? .secondary : .tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            }
            if tasks.count > 5 {
                Text("+\(tasks.count - 5) more")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func pinnedTaskGlyph(_ status: String) -> String {
        switch status {
        case "in_progress": return "◐"
        case "completed": return "☑"
        default: return "☐" // pending, or any unrecognized status
        }
    }
}
