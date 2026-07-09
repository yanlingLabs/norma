import AppKit
import NormaKit
import SwiftUI
import UniformTypeIdentifiers

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
// Install-from-UI pure helpers (Task 3, 4d-iii): a `.zip` picked via `NSOpenPanel` is extracted to
// a temp dir via `/usr/bin/unzip` (`Process`, matching `CliLauncher`'s existing Process-launch
// idiom elsewhere in this target — no zip-reading library dependency); a folder is used directly.
// `locatePluginRoot` — finding the actual plugin root within an extracted zip's temp dir — touches
// the real filesystem rather than a `NormaClient`, so it's directly testable against a real temp
// directory instead of mocked.
// -----------------------------------------------------------------------------------------------

enum PluginInstallError: Error, Equatable {
    /// `/usr/bin/unzip` exited non-zero.
    case unzipFailed
}

/// The plugin root within `directory`: `directory` itself if it directly holds a
/// `norma-plugin.json`/`plugin.json` manifest, else a single top-level subdirectory that does
/// (the common "zip wraps everything in one folder" shape) — checked in that order. `nil` if
/// neither matches (ambiguous or manifest-less zip contents).
func locatePluginRoot(in directory: URL, fileManager: FileManager = .default) -> URL? {
    func hasManifest(_ url: URL) -> Bool {
        fileManager.fileExists(atPath: url.appendingPathComponent("norma-plugin.json").path)
            || fileManager.fileExists(atPath: url.appendingPathComponent("plugin.json").path)
    }
    if hasManifest(directory) { return directory }
    guard let entries = try? fileManager.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.isDirectoryKey]
    ) else { return nil }
    let subdirs = entries.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
    guard subdirs.count == 1, hasManifest(subdirs[0]) else { return nil }
    return subdirs[0]
}

/// Extracts a `.zip` at `zipURL` into a fresh temp directory via `/usr/bin/unzip -q ... -d ...`
/// and returns that directory — the CALLER resolves the actual plugin root inside it via
/// `locatePluginRoot` (the zip may or may not wrap its contents in one top-level folder).
func extractPluginZip(at zipURL: URL, fileManager: FileManager = .default) throws -> URL {
    let tempDir = fileManager.temporaryDirectory
        .appendingPathComponent("norma-plugin-install-\(UUID().uuidString)", isDirectory: true)
    try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
    process.arguments = ["-q", zipURL.path, "-d", tempDir.path]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw PluginInstallError.unzipFailed }
    return tempDir
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the pane's live view-model (`@MainActor`/`ObservableObject`, same posture
// as `PeripheralProvider`): owns the plugin list + drives the 4 lifecycle actions, each followed by
// a `refresh()` so the row list always reflects the daemon's just-applied state.
// -----------------------------------------------------------------------------------------------

@MainActor
final class PluginManagerModel: ObservableObject {
    /// A `plugin.enable` call that came back `.needsConsent` (Task 2's original surfacing point).
    /// Task 3 drives the actual GUI consent sheet off `consentSheet` below instead — this field is
    /// kept alongside it, written on the same transitions, purely so Task 2's existing shape/tests
    /// (`PluginManagerModelTests.swift`'s `XCTAssertNil(model.pendingConsent)` coverage) stay
    /// untouched; nothing in the view reads it anymore.
    struct PendingConsent: Equatable {
        let name: String
        let requiredConsents: [String]
        let consentBlock: [String]
    }

    private let client: NormaClient

    @Published private(set) var rows: [PluginRowDisplay] = []
    @Published var errorText: String?
    @Published var pendingConsent: PendingConsent?
    /// Task 3 (4d-iii): the live consent sheet, seeded from EITHER trigger — an `enable(_:)` that
    /// came back `.needsConsent` (mirrors `pendingConsent` above; kept alongside it rather than
    /// replacing it, so `pendingConsent`'s existing shape/tests are untouched) or a successful
    /// `install(source:)`. `PluginManagerView` presents this via `.sheet(item:)`; setting it to
    /// `nil` (confirm/cancel, or a swipe-to-dismiss) closes the sheet.
    @Published var consentSheet: ConsentSheetState?
    /// The plugin name an in-flight action is currently running against — lets the view disable
    /// that row's buttons mid-action, same `revokingPath`-style single-flight posture as
    /// `TrustPane`.
    @Published private(set) var busyName: String?
    /// Task 3: true while `install(source:)` is in flight — lets the view disable the "Install
    /// Plugin…" button so a second pick can't race the first.
    @Published private(set) var installing = false

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
                consentSheet = nil
            case .needsConsent(let requiredConsents, let consentBlock):
                // Task 3: replaces Task 2's dead orange-banner-only surfacing — clicking Enable on
                // a needs-consent plugin now opens the GUI consent sheet, seeded verbatim from the
                // server's disclosure.
                pendingConsent = PendingConsent(name: name, requiredConsents: requiredConsents, consentBlock: consentBlock)
                consentSheet = ConsentSheetState(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
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

    /// Task 3 (4d-iii): install a plugin from a local folder, or an already-extracted zip's
    /// resolved plugin root — `PluginManagerView` resolves a picked `.zip` down to a directory via
    /// `extractPluginZip`/`locatePluginRoot` BEFORE calling this (`plugins.install` is
    /// folder-source-only over the wire, per 4d-ii). On success opens the consent sheet seeded
    /// with the server's `consentBlock`/`requiredConsents` — installs always land DISABLED +
    /// UNCONSENTED server-side (`plugins.install`'s own contract), so there's always a sheet to
    /// show, even for a plugin that ends up needing zero consent classes (its `consentBlock` is
    /// then just the header line — `pluginEnable(consent:true)` on confirm is still what actually
    /// turns it on, since install itself never enables). `.invalidSource`/`.alreadyInstalled`
    /// surface via `errorText` instead, same as every other action's failure path.
    func install(source: String) async {
        installing = true
        defer { installing = false }
        var actionError: String?
        do {
            switch try await client.pluginsInstall(source: source) {
            case .ok(let name, let requiredConsents, _, let consentBlock):
                consentSheet = ConsentSheetState(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
            case .invalidSource:
                actionError = "not a valid plugin source — no norma-plugin.json/plugin.json found"
            case .alreadyInstalled(let name):
                actionError = "\(name) is already installed"
            }
        } catch {
            actionError = "couldn't install plugin — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// The consent sheet's "Grant consent & enable" — re-calls `pluginEnable(consent:true)` for
    /// whichever plugin `consentSheet` names (covers BOTH triggers: a needs-consent `enable`
    /// retry, or the first-ever enable right after an `install`). Dismisses the sheet on `.ok`;
    /// stays open (re-seeded) if the server somehow still reports `.needsConsent` — mirrors
    /// `enable(_:)`'s own handling of that outcome.
    func confirmConsent() async {
        guard var sheet = consentSheet else { return }
        sheet.confirm()
        consentSheet = sheet
        let name = sheet.pluginName
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            switch try await client.pluginEnable(name: name, consent: true) {
            case .ok:
                consentSheet = nil
                pendingConsent = nil
            case .needsConsent(let requiredConsents, let consentBlock):
                consentSheet = ConsentSheetState(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
            case .unknownPlugin:
                consentSheet = nil
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't enable \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// The consent sheet's "Cancel" — dismisses without ever calling `pluginEnable`; the plugin
    /// stays exactly as it was (installed-disabled, or still-disabled after the failed enable that
    /// opened the sheet in the first place).
    func cancelConsent() {
        consentSheet?.cancel()
        consentSheet = nil
        pendingConsent = nil
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
        // Task 3 (4d-iii): the GUI consent sheet — presented from BOTH triggers `model.consentSheet`
        // can be set from (`enable(_:)`'s needsConsent path, or a successful `install(source:)`).
        // Dismissing any other way (Esc/swipe) also nils the binding via SwiftUI's own `.sheet`
        // machinery — same end state as `cancelConsent()`, just without that method's explicit
        // `.cancel()` record on the (by-then-discarded) state value.
        .sheet(item: $model.consentSheet) { sheet in
            ConsentSheet(
                state: sheet,
                onConfirm: { Task { await model.confirmConsent() } },
                onCancel: { model.cancelConsent() }
            )
        }
    }

    private var header: some View {
        HStack {
            Text("Plugins").font(.headline)
            Spacer()
            Button("Install Plugin…") { presentInstallPanel() }
                .disabled(model.installing)
            Button("Refresh") { Task { await model.refresh() } }
        }
        .padding([.top, .horizontal])
        .padding(.bottom, 4)
    }

    /// Task 3: "Install Plugin…" — `NSOpenPanel` lets the user pick a folder OR a `.zip`
    /// (`canChooseDirectories`/`canChooseFiles` both true; `allowedContentTypes` filters the FILE
    /// side to `.zip` only — per `NSOpenPanel` semantics, `allowedContentTypes` never filters out
    /// directories when `canChooseDirectories` is true, so any folder stays pickable).
    private func presentInstallPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.zip]
        panel.message = "Choose a plugin folder or a .zip archive"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await installFrom(url: url) }
    }

    /// If `url` is a `.zip`, extract it to a temp dir first and resolve the actual plugin root
    /// within it (`extractPluginZip`/`locatePluginRoot`) before calling `pluginsInstall` — the RPC
    /// itself is folder-source-only. A folder is used directly.
    private func installFrom(url: URL) async {
        let sourceDir: URL
        if url.pathExtension.lowercased() == "zip" {
            do {
                let tempDir = try extractPluginZip(at: url)
                guard let root = locatePluginRoot(in: tempDir) else {
                    model.errorText = "zip has no norma-plugin.json/plugin.json — not a plugin"
                    return
                }
                sourceDir = root
            } catch {
                model.errorText = "couldn't extract the zip — try again"
                return
            }
        } else {
            sourceDir = url
        }
        await model.install(source: sourceDir.path)
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
