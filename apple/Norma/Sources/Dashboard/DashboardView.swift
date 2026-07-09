import SwiftUI

// MARK: - Pure pane-order / selection (Task 5, 2f-ii) — table-tested in DashboardTests.swift.

/// One entry in the Dashboard's left sidebar. `String` raw value (not an opaque index) so a
/// future pane — Phase 4's `PluginManagerView`, per spec §B's "the same mountable-pane contract"
/// — is a plain new case, never a renumbering of existing ones.
enum DashboardPane: String, CaseIterable, Identifiable, Equatable {
    case sessions, daemonStatus, quota, trust, peripheral, pluginManager
    var id: String { rawValue }
}

/// The sidebar's fixed display order — a plain DATA array (not scattered per-view logic), so
/// adding a pane later is a one-line change here, not a restructuring of `DashboardView.body`.
/// Phase 4d-iii Task 2: `.pluginManager` appended at the END — every existing pane keeps its
/// position, so this is purely additive (no renumbering of `dashboardSidebarWidth`/selection math,
/// which reads this array, not the enum's raw ordinal).
let dashboardPaneOrder: [DashboardPane] = [.sessions, .daemonStatus, .quota, .trust, .peripheral, .pluginManager]

/// The window's default/initial selection — always the FIRST pane in `dashboardPaneOrder`, so a
/// pane appended to the end of that list never silently becomes the landing pane just by being
/// added.
let defaultDashboardPane: DashboardPane = dashboardPaneOrder.first ?? .sessions

func dashboardPaneTitle(_ pane: DashboardPane) -> String {
    switch pane {
    case .sessions: return "Sessions"
    case .daemonStatus: return "Daemon Status"
    case .quota: return "Quota"
    case .trust: return "Trust"
    case .peripheral: return "Peripheral"
    case .pluginManager: return "Plugins"
    }
}

func dashboardPaneSystemImage(_ pane: DashboardPane) -> String {
    switch pane {
    case .sessions: return "bubble.left.and.bubble.right"
    case .daemonStatus: return "server.rack"
    case .quota: return "gauge.with.needle"
    case .trust: return "checkmark.shield"
    case .peripheral: return "keyboard"
    case .pluginManager: return "puzzlepiece.extension"
    }
}

/// The fixed left-sidebar width (spec §B: "left pane sidebar (fixed 180pt)").
let dashboardSidebarWidth: CGFloat = 180

// MARK: - Mountable-pane contract (spec §B)

/// The injected bundle every pane is built from — DATA or a CLOSURE, never a `NormaClient`
/// itself (mirrors `SessionDirectory`'s own `lister` closure convention, and `SidebarWiring`'s
/// posture of handing panes already-decoupled view-models rather than transports). Built once by
/// `DashboardWindowController.init`, which is the one place that closes over the real client.
struct DashboardWiring {
    let directory: SessionDirectory
    let onOpenSessionDetached: (String) -> Void
    let daemonStatus: () async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int)
    let quotaState: () async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int)
    let trustList: () async throws -> [String]
    let trustRemove: (String) async throws -> Bool
    let peripheral: PeripheralProvider
    /// Task 4 (4c): the Peripheral pane's helper-approval row reads this directly
    /// (`@ObservedObject`) — same "hand the pane an already-decoupled view-model" posture as
    /// `peripheral` above, not a `NormaClient`/XPC connection of its own.
    let helperClient: HelperClient
    /// Phase 4d-iii Task 2: the PluginManagerView's live view-model — same `@ObservedObject`
    /// "already-decoupled view-model" posture as `peripheral`/`helperClient` above, not a
    /// `NormaClient` of its own.
    let pluginManager: PluginManagerModel
}

/// The Dashboard window's root content: a fixed-width left pane list + the selected pane's
/// detail. Manual `ScrollView`/`VStack`/`onTapGesture` sidebar — matches this codebase's existing
/// convention (`SessionSidebar`) rather than `List`/`NavigationSplitView`, neither of which is
/// used anywhere else in this target.
struct DashboardView: View {
    let wiring: DashboardWiring
    @State private var selection: DashboardPane

    /// Phase 4d-iii Task 2: `initialPane` lets a caller (the "Manage Plugins…" menu item, via
    /// `DashboardWindowController`) land the window on a specific pane on first open — defaults to
    /// `defaultDashboardPane` so every pre-existing call site (`DashboardView(wiring:)`) keeps its
    /// original behavior unchanged.
    init(wiring: DashboardWiring, initialPane: DashboardPane = defaultDashboardPane) {
        self.wiring = wiring
        self._selection = State(initialValue: initialPane)
    }

    var body: some View {
        HStack(spacing: 0) {
            paneList
                .frame(width: dashboardSidebarWidth)
                .frame(maxHeight: .infinity)
            Divider()
            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var paneList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(dashboardPaneOrder) { pane in
                    paneRow(pane)
                }
            }
            .padding(8)
        }
    }

    private func paneRow(_ pane: DashboardPane) -> some View {
        let isCurrent = pane == selection
        return HStack(spacing: 6) {
            Image(systemName: dashboardPaneSystemImage(pane))
                .font(.system(size: 12))
                .frame(width: 16)
            Text(dashboardPaneTitle(pane))
                .font(.system(size: 12))
            Spacer()
        }
        .foregroundStyle(isCurrent ? .primary : .secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.quaternary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { selection = pane }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection {
        case .sessions:
            SessionsPane(directory: wiring.directory, onOpenSessionDetached: wiring.onOpenSessionDetached)
        case .daemonStatus:
            DaemonStatusPane(fetch: wiring.daemonStatus)
        case .quota:
            QuotaPane(fetch: wiring.quotaState)
        case .trust:
            TrustPane(list: wiring.trustList, remove: wiring.trustRemove)
        case .peripheral:
            PeripheralPane(provider: wiring.peripheral, helperClient: wiring.helperClient)
        case .pluginManager:
            PluginManagerView(model: wiring.pluginManager)
        }
    }
}
