import SwiftUI

/// "" / whitespace-only / nil → "New session" (the placeholder the daemon hasn't titled yet
/// exists as); otherwise the trimmed title verbatim. Pure factoring of the same fallback rule
/// `SessionSidebarRow.displayTitle` applies inline — kept as its own tested function here rather
/// than reaching into `ChatContent/SessionSidebar.swift` (a different, untouched file per this
/// task's scope) for a private computed property.
func sessionDisplayTitle(_ title: String?) -> String {
    let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? "New session" : trimmed
}

/// Task 5 (2f-ii): the Dashboard's Sessions pane — reuses the SAME `SessionDirectory` the app's
/// other sidebars already drive (`AppModel.directory`), so the Dashboard shows exactly the same
/// session list without a second listing harness. A row click reuses the EXISTING "open in a new
/// detached window" path (`onOpenSessionDetached`, wired by `AppDelegate` to
/// `openSessionInNewDetachedWindow`) — the Dashboard has no session harness of its own to repin
/// in place, unlike `SessionSidebar`'s plain-click behavior.
struct SessionsPane: View {
    @ObservedObject var directory: SessionDirectory
    let onOpenSessionDetached: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Sessions")
                .font(.headline)
                .padding([.top, .horizontal])
                .padding(.bottom, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if directory.rows.isEmpty {
                        Text("No sessions yet")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }
                    ForEach(sortedRows) { row in
                        Button {
                            onOpenSessionDetached(row.sessionId)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    // Dispatch (Phase 7): the singleton coordinator session badges
                                    // itself so it reads distinctly from an ordinary session row.
                                    if row.mode == "dispatch" {
                                        Text("DISPATCH")
                                            .font(.caption2)
                                            .bold()
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(sessionDisplayTitle(row.title))
                                        .font(.system(size: 13))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Text(Date(timeIntervalSince1970: TimeInterval(row.createdAt) / 1000), style: .relative)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            // Dispatch (Phase 7): a child session indents under its dispatch parent
                            // — see `sortedRows` for the matching grouping this indent visually cues.
                            .padding(.leading, row.parentSessionId != nil ? 16 : 0)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .task { await directory.refresh() }
    }

    /// Dispatch (Phase 7): groups every row under its dispatch parent (a parentless row groups
    /// under its OWN sessionId) with the parent sorting before its children, oldest-first within a
    /// group — so a dispatch session's children render directly beneath it instead of scattered
    /// through the plain newest-first order `directory.rows` already carries.
    private var sortedRows: [SessionSummary] {
        directory.rows.sorted {
            ($0.parentSessionId ?? $0.sessionId, $0.parentSessionId == nil ? 0 : 1, $0.createdAt) <
            ($1.parentSessionId ?? $1.sessionId, $1.parentSessionId == nil ? 0 : 1, $1.createdAt)
        }
    }
}
