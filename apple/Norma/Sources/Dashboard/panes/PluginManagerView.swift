import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Pure pane-order-independent pieces (Task 2, Phase 4d-iii): `plugins.list` entry → row display +
// the action-availability rule. Table-tested directly in `PluginManagerModelTests`, no
// `NormaClient`/SwiftUI involved — same "pure helper next to its View" posture as
// `formatDaemonStatus`/`formatQuotaState`/`sortedTrustPaths` in this same directory's other panes.
// -----------------------------------------------------------------------------------------------

/// One action button a plugin row can offer — pure data (no closures); the view maps this to a
/// title/style and the `PluginManagerModel` method to call.
enum PluginAction: String, Equatable, Hashable, CaseIterable {
    case enable, disable, remove, restart

    var title: String {
        switch self {
        case .enable: return "Enable"
        case .disable: return "Disable"
        case .remove: return "Remove"
        case .restart: return "Restart"
        }
    }
}

/// Purely a rendering hint for the row's status dot/text. `na` (no runtime process at all —
/// Tier-1/legacy/unconsented) and `disabled` (hot-stopped, no process either) are their OWN cases
/// specifically so the view can render them WITHOUT a "running" indicator dot at all — distinct
/// from every Tier-2 runtime state (running/starting/stopped/backoff/circuit-open), which always
/// gets one. `na` is never conflated with `.stopped`.
enum PluginStatusColorKind: Equatable, Hashable {
    case running, starting, stopped, backoff, circuitOpen, na, disabled
}

/// One `plugins.list` entry mapped to what its row renders — see `pluginRowDisplay(...)` below for
/// the (pure, table-tested) mapping. `id` is the plugin name (`plugins.list` names are unique per
/// daemon).
struct PluginRowDisplay: Equatable, Identifiable {
    var id: String { name }
    let name: String
    let tierBadge: String
    let version: String
    let consentText: String
    let statusText: String
    let statusColorKind: PluginStatusColorKind
    let actions: [PluginAction]
}

/// Task 2 (4d-iii): `plugins.list` entry → row display. PURE — no `NormaClient`, no SwiftUI —
/// table-tested directly in `PluginManagerModelTests`.
///
/// Action rule (honors 4d-ii's carryovers — `plugin.enable`/`disable`/`remove` + this task's new
/// `plugin.restart`, NormaClient+Methods.swift):
///   - `disabled == true` (any tier/status) → `[.enable, .remove]`. Checked FIRST, ahead of
///     `status`: a disabled plugin has no live process regardless of what `status` last reported
///     (enabling is the only way back to running).
///   - enabled AND `status == "running"` → `[.restart, .disable, .remove]`. `.restart` is offered
///     ONLY here — never for an enabled-but-not-currently-running Tier-2 plugin
///     (starting/stopped/backoff/circuit-open) and never for na/Tier-1; recovering those goes
///     through disable→enable (which hot-restarts the process under the hood via
///     `PluginSupervisor.restart`), not a bare restart button. NEVER `.enable` for a running
///     plugin — enabling an already-running plugin bounces it.
///   - everything else enabled (na/Tier-1/legacy, or an enabled Tier-2 plugin that isn't currently
///     "running") → `[.disable, .remove]`.
///
/// Status/tier TEXT is derived independently of the action rule: `disabled` is still checked FIRST
/// — a disabled Tier-2 plugin's `status` reports "na" or "stopped" server-side (see
/// `pluginSpawnEligible`, packages/core/src/agent/plugins.ts — disabled fails spawn-eligibility),
/// but the row should read "Disabled", not "Stopped"/"N/A". `na` always gets its own
/// `PluginStatusColorKind`, never conflated with `.stopped` or any other Tier-2 runtime state.
func pluginRowDisplay(
    name: String,
    version: String?,
    tier: String?,
    requiredConsents: [String],
    consented: [String],
    legacy: Bool,
    status: String?,
    disabled: Bool
) -> PluginRowDisplay {
    let tierBadge: String
    if legacy {
        tierBadge = "Legacy"
    } else {
        switch tier {
        case "platform": tierBadge = "Tier 2"
        case "capability": tierBadge = "Tier 1"
        default: tierBadge = "Unknown"
        }
    }

    let consentText: String
    if requiredConsents.isEmpty {
        consentText = "No consent required"
    } else {
        let missing = requiredConsents.filter { !consented.contains($0) }
        consentText = missing.isEmpty
            ? "Consented: \(requiredConsents.joined(separator: ", "))"
            : "Needs consent: \(missing.joined(separator: ", "))"
    }

    let statusText: String
    let statusColorKind: PluginStatusColorKind
    if disabled {
        statusText = "Disabled"
        statusColorKind = .disabled
    } else {
        switch status {
        case "running": statusText = "Running"; statusColorKind = .running
        case "starting": statusText = "Starting"; statusColorKind = .starting
        case "stopped": statusText = "Stopped"; statusColorKind = .stopped
        case "backoff": statusText = "Backoff"; statusColorKind = .backoff
        case "circuit-open": statusText = "Circuit open"; statusColorKind = .circuitOpen
        default: statusText = "N/A"; statusColorKind = .na
        }
    }

    let actions: [PluginAction]
    if disabled {
        actions = [.enable, .remove]
    } else if status == "running" {
        actions = [.restart, .disable, .remove]
    } else {
        actions = [.disable, .remove]
    }

    return PluginRowDisplay(
        name: name,
        tierBadge: tierBadge,
        version: version ?? "—",
        consentText: consentText,
        statusText: statusText,
        statusColorKind: statusColorKind,
        actions: actions
    )
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the pane's live view-model (`@MainActor`/`ObservableObject`, same posture
// as `PeripheralProvider`): owns the plugin list + drives the 4 lifecycle actions, each followed by
// a `refresh()` so the row list always reflects the daemon's just-applied state.
// -----------------------------------------------------------------------------------------------

@MainActor
final class PluginManagerModel: ObservableObject {
    /// A `plugin.enable` call that came back `.needsConsent` — surfaced here for Task 3's consent
    /// sheet to pick up. This task only surfaces it (no sheet UI yet).
    struct PendingConsent: Equatable {
        let name: String
        let requiredConsents: [String]
        let consentBlock: [String]
    }

    private let client: NormaClient

    @Published private(set) var rows: [PluginRowDisplay] = []
    @Published var errorText: String?
    @Published var pendingConsent: PendingConsent?
    /// The plugin name an in-flight action is currently running against — lets the view disable
    /// that row's buttons mid-action, same `revokingPath`-style single-flight posture as
    /// `TrustPane`.
    @Published private(set) var busyName: String?

    init(client: NormaClient) {
        self.client = client
    }

    func refresh() async {
        do {
            let plugins = try await client.pluginsList()
            rows = plugins.map { p in
                pluginRowDisplay(
                    name: p.name, version: p.version, tier: p.tier,
                    requiredConsents: p.requiredConsents, consented: p.consented,
                    legacy: p.legacy, status: p.status, disabled: p.disabled
                )
            }
            errorText = nil
        } catch {
            errorText = "couldn't load plugins — try Refresh"
        }
    }

    // Fix wave 1 (Task 2 review, error-surfacing defect): `refresh()`'s success path
    // unconditionally clears `errorText` — and `pluginsList()` succeeding is INDEPENDENT of
    // whether the action itself failed, so a bare `errorText = ...; await refresh()` had the
    // refresh wipe the action's error the instant it ran. Each action method below now captures
    // its own failure into a local `actionError` instead of writing straight to `errorText`, calls
    // `refresh()` (which still does the normal list-reload + stale-error-clear), and only THEN — if
    // the action itself failed — sets `errorText` to the captured message, so it's the LAST write
    // and survives the refresh. On an action success, `actionError` stays nil and refresh's own
    // clear stands untouched. `.needsConsent` is deliberately NOT routed through `actionError` — it
    // is a pending state, not a failure (see `pendingConsent`, left untouched by this fix).
    func enable(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            switch try await client.pluginEnable(name: name) {
            case .ok:
                pendingConsent = nil
            case .needsConsent(let requiredConsents, let consentBlock):
                pendingConsent = PendingConsent(name: name, requiredConsents: requiredConsents, consentBlock: consentBlock)
            case .unknownPlugin:
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't enable \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    func disable(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            if try await client.pluginDisable(name: name) == .unknownPlugin {
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't disable \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    func remove(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            if try await client.pluginRemove(name: name) == .unknownPlugin {
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't remove \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    func restart(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            try await client.pluginRestart(name: name)
        } catch {
            actionError = "couldn't restart \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }
}

// -----------------------------------------------------------------------------------------------
// PluginManagerView — modeled on `PeripheralPane`/`TrustPane`'s structure/idiom: opaque window, so
// adaptive system colors only (never the glass-shell field blend).
// -----------------------------------------------------------------------------------------------

struct PluginManagerView: View {
    @ObservedObject var model: PluginManagerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(.system(size: 12)).padding(.horizontal)
            }
            if let pendingConsent = model.pendingConsent {
                Text("\(pendingConsent.name) needs consent: \(pendingConsent.requiredConsents.joined(separator: ", "))")
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                    .padding(.horizontal)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if model.rows.isEmpty {
                        Text("No plugins installed")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }
                    ForEach(model.rows) { row in
                        pluginRow(row)
                        Divider()
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .task { await model.refresh() }
    }

    private var header: some View {
        HStack {
            Text("Plugins").font(.headline)
            Spacer()
            Button("Refresh") { Task { await model.refresh() } }
        }
        .padding([.top, .horizontal])
        .padding(.bottom, 4)
    }

    private func pluginRow(_ row: PluginRowDisplay) -> some View {
        let busy = model.busyName == row.name
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.name).font(.system(size: 13, weight: .medium))
                tierBadge(row.tierBadge)
                Text(row.version)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                statusIndicator(row)
            }
            Text(row.consentText)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                ForEach(row.actions, id: \.self) { action in
                    Button(action.title) { Task { await perform(action, on: row.name) } }
                        .font(.system(size: 12))
                        .foregroundStyle(action == .remove ? .red : .primary)
                        .disabled(busy)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    private func perform(_ action: PluginAction, on name: String) async {
        switch action {
        case .enable: await model.enable(name)
        case .disable: await model.disable(name)
        case .remove: await model.remove(name)
        case .restart: await model.restart(name)
        }
    }

    private func tierBadge(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.quaternary))
            .foregroundStyle(.secondary)
    }

    /// `na`/`disabled` render WITHOUT the colored dot at all (no runtime process to indicate) —
    /// every other status gets one, colored per `statusDotColor`.
    private func statusIndicator(_ row: PluginRowDisplay) -> some View {
        HStack(spacing: 4) {
            if let dot = statusDotColor(row.statusColorKind) {
                Circle().fill(dot).frame(width: 6, height: 6)
            }
            Text(row.statusText).font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    private func statusDotColor(_ kind: PluginStatusColorKind) -> Color? {
        switch kind {
        case .running: return .green
        case .starting: return .blue
        case .stopped: return .secondary
        case .backoff: return .orange
        case .circuitOpen: return .red
        case .na, .disabled: return nil
        }
    }
}
