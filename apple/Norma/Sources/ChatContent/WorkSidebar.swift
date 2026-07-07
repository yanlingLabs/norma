import SwiftUI

/// 2e-iii Task 6: the callback bundle the two window construction sites hand to `WindowContentView`
/// to light up its width-responsive sidebars. `WindowContentView.sidebars` is `SidebarWiring?` —
/// `nil` reproduces today's exact zero-sidebar layout (a guard clause in `body`); BOTH call sites
/// (the morph window via `OrbWindowController`, a detached window via `DetachedWindowController`)
/// pass a real value.
///
/// `directory` is the left session-switcher's live list; `currentSessionId` is read FRESH at render
/// (a closure, not a captured value — the focused/pinned session changes over the window's life);
/// `onSelect` switches in place, `onOpenDetached` spawns a new detached window for that id, and
/// `onNewSession` creates+focuses a fresh session.
struct SidebarWiring {
    let directory: SessionDirectory
    let currentSessionId: () -> String?
    let onSelect: (String) -> Void
    let onOpenDetached: (String) -> Void
    let onNewSession: () -> Void
}

/// Pure placement decision behind the relocation gates: the tasks/subagents "work" content is
/// EXCLUSIVELY either inline in the content column (no right sidebar) or in the right WorkSidebar
/// (the right side visible — inline OR overlay). Never both (would duplicate the sections), never
/// neither (would drop them). `SidebarRelocationTests` drives this directly; the `body` gates read
/// `resolved.rightVisible` (== `sidebarWork`) inline for the smallest diff.
func sidebarContentPlacement(_ e: EffectiveSidebars) -> (inlineWork: Bool, sidebarWork: Bool) {
    (!e.rightVisible, e.rightVisible)
}

/// CARRIED ITEM 1 (T4 resize-drift): a chevron is only ever shown for a side that is NOT effectively
/// visible, so its tap is always an OPEN, never a blind toggle. A resize below the both-fit width can
/// leave `leftExpanded` stale-true while the right won the tie and the left is invisible — a naive
/// `toggleLeftSidebar` on that stale-true flag would flip it to `false` (still closed → TWO taps to
/// open). Force the open by feeding the toggle helper `false` for THIS side, so `newLeft = !false =
/// true` reliably opens, while the helper still applies the below-both-fit mutual exclusion to the
/// OTHER side.
func openLeftViaChevron(rightExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    toggleLeftSidebar(leftExpanded: false, rightExpanded: rightExpanded, width: width)
}

/// Mirror of `openLeftViaChevron` for the right edge — see that function's doc.
func openRightViaChevron(leftExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    toggleRightSidebar(leftExpanded: leftExpanded, rightExpanded: false, width: width)
}

// MARK: - The right work sidebar (a function-family on WindowContentView, like `subagentSection`/
// `pinnedTasksSection`, so it renders them directly — brief Step 2's "smallest diff" option).

extension WindowContentView {
    /// The right WorkSidebar: an "Options" block (approval-mode picker + current-session info) over
    /// a `Divider` over a "Work" block (subagents ABOVE tasks — the relocated content). Width
    /// `sidebarRightWidth`; scrollable so a long task/subagent list never clips. Rendered inline in
    /// the HStack when the width fits, or in an `.ultraThinMaterial` overlay when it doesn't.
    @ViewBuilder
    var workSidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                sidebarOptionsBlock
                Divider().opacity(0.5)
                sidebarWorkBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .frame(width: sidebarRightWidth)
    }

    /// One approval-mode picker row — the SHARED implementation the ⋯ popover (`policyMenuContent`)
    /// and the WorkSidebar's Options block both render (brief Step 2: "one implementation"). Reuses
    /// EXACTLY `adapter.onSetPolicy`/`sessionPolicy`/`policyChangeInFlight`. Internal (not `private`)
    /// so `policyMenuContent` in WindowContentView.swift can call it across files.
    @ViewBuilder
    func policyPickerRow(_ policy: String) -> some View {
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

    @ViewBuilder
    private var sidebarOptionsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Options")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(["auto", "ask", "plan"], id: \.self) { policyPickerRow($0) }
            }
            sidebarSessionInfo
        }
    }

    /// Current-session info rows: title / scope / cwd (cwd middle-truncated). Read fresh from the
    /// directory each render via `sidebars.currentSessionId()`. Hidden when the current session
    /// isn't (yet) in the directory list.
    @ViewBuilder
    private var sidebarSessionInfo: some View {
        if let row = currentSidebarSessionSummary {
            VStack(alignment: .leading, spacing: 3) {
                sidebarInfoRow("title", displaySidebarTitle(row.title), truncation: .tail)
                sidebarInfoRow("scope", row.scope, truncation: .tail)
                if let cwd = row.cwd, !cwd.isEmpty {
                    sidebarInfoRow("cwd", cwd, truncation: .middle)
                }
            }
            .padding(.top, 2)
        }
    }

    private func sidebarInfoRow(_ label: String, _ value: String, truncation: Text.TruncationMode) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .foregroundStyle(.tertiary)
            Text(value)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(truncation)
        }
        .font(.system(size: 11))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var sidebarWorkBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Work")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            // Subagents ABOVE tasks (brief Step 2). Each section already carries its own leading
            // `Divider`; they hide when empty via these gates (mirrors the content column's gates).
            if !adapter.liveSubagents.isEmpty {
                subagentSection(adapter.liveSubagents)
            }
            if !adapter.pinnedTasks.isEmpty {
                pinnedTasksSection(adapter.pinnedTasks)
            }
            if adapter.liveSubagents.isEmpty && adapter.pinnedTasks.isEmpty {
                Text("No active work")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The directory row for the currently focused/pinned session, or `nil` (no wiring / not listed
    /// yet). `sidebars` is always non-nil where the WorkSidebar renders, but read optionally here.
    private var currentSidebarSessionSummary: SessionSummary? {
        guard let sidebars, let sid = sidebars.currentSessionId() else { return nil }
        return sidebars.directory.rows.first { $0.sessionId == sid }
    }

    /// Same fallback `SessionSidebarRow` uses — an untitled session reads "New session".
    private func displaySidebarTitle(_ title: String?) -> String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "New session" : trimmed
    }
}
