import Foundation
import NormaKit
import Sparkle

/// Injectable seam for everything the updater touches outside its own logic
/// (DaemonSupervisorDeps precedent — see DaemonSupervisor.swift).
struct UpdaterCoordinatorDeps {
    /// Current number of executing agent turns; nil when the daemon is unreachable
    /// (treated as idle — nothing to interrupt).
    var activeTurns: () async -> Int?
    /// updates.channel from ~/.norma/settings.json; nil/absent → stable.
    var readChannel: () -> String?
    /// NORMA_UPDATE_FEED env override for local test feeds; nil → Info.plist SUFeedURL.
    var feedOverride: () -> String?
    var now: () -> Date
    var pollIntervalSeconds: TimeInterval
    var badgeAfterSeconds: TimeInterval
}

extension UpdaterCoordinatorDeps {
    /// Production wiring. activeTurns is a placeholder until it's wired to the daemon's
    /// engine.activity RPC (T2); readChannel reads live from settings.json (T5). Both
    /// fail-open: nil activity = idle, nil channel = stable.
    @MainActor static var live: UpdaterCoordinatorDeps {
        .init(
            activeTurns: { nil },
            readChannel: { UpdaterCoordinator.readChannelFromSettings() },
            feedOverride: { ProcessInfo.processInfo.environment["NORMA_UPDATE_FEED"] },
            now: { Date() },
            pollIntervalSeconds: 30,
            badgeAfterSeconds: 24 * 60 * 60
        )
    }
}

/// Sparkle delegate: silent background updates; Norma-specific gating lives here.
@MainActor
final class UpdaterCoordinator: NSObject {
    let deps: UpdaterCoordinatorDeps

    // Staged-update state
    private(set) var stagedVersion: String?
    private var stagedAt: Date?
    private var pendingInstall: (() -> Void)?
    private var pollTask: Task<Void, Never>?
    /// Menu-bar hooks (installed by AppDelegate).
    var onStagedChange: ((_ staged: Bool, _ version: String?) -> Void)?
    var onBadgeChange: ((_ badged: Bool) -> Void)?

    init(deps: UpdaterCoordinatorDeps) {
        self.deps = deps
    }

    /// Testable core of feedURLString(for:).
    func resolvedFeedOverride() -> String? {
        deps.feedOverride()
    }

    /// The idle gate. Sparkle asks permission to relaunch after staging an update; we always
    /// postpone and let the poll (first tick immediate) or the user's Restart-now decide.
    /// Returns true = postpone (Sparkle holds until `installHandler` is invoked).
    func handleRelaunchRequest(version: String, untilInvoking installHandler: @escaping () -> Void) -> Bool {
        stagedVersion = version
        stagedAt = deps.now()
        pendingInstall = installHandler
        onStagedChange?(true, version)
        startPolling()
        return true
    }

    /// Poll: first check immediately (idle-at-stage installs with no 30s lag), then every
    /// pollIntervalSeconds. nil activeTurns (daemon unreachable) counts as idle.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                if (await self.deps.activeTurns() ?? 0) == 0 {
                    self.installNow()
                    return
                }
                self.refreshBadge()
                try? await Task.sleep(for: .seconds(self.deps.pollIntervalSeconds))
            }
        }
    }

    /// The poll's idle trigger AND the user's "Restart Now" override. Idempotent.
    func installNow() {
        guard let install = pendingInstall else { return }
        pendingInstall = nil
        pollTask?.cancel()
        onStagedChange?(false, stagedVersion)
        install() // Sparkle proceeds: quit → swap bundle → relaunch (supervisor spawns the new daemon)
    }

    private func refreshBadge() {
        guard let at = stagedAt else { return }
        onBadgeChange?(deps.now().timeIntervalSince(at) >= deps.badgeAfterSeconds)
    }

    /// stable/nil/unknown → default channel only (empty set); beta → +"beta".
    func allowedChannelSet(for channelSetting: String?) -> Set<String> {
        channelSetting == "beta" ? ["beta"] : []
    }

    /// Live read of updates.channel from ~/.norma/settings.json (nil on absent/malformed).
    nonisolated static func readChannelFromSettings() -> String? {
        let url = URL(fileURLWithPath: NormaPaths.settingsPath())
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let updates = obj["updates"] as? [String: Any]
        else { return nil }
        return updates["channel"] as? String
    }
}

extension UpdaterCoordinator: SPUUpdaterDelegate {
    /// Dev/test override: NORMA_UPDATE_FEED wins; nil → Sparkle falls back to Info.plist.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        MainActor.assumeIsolated { resolvedFeedOverride() }
    }

    nonisolated func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        MainActor.assumeIsolated {
            handleRelaunchRequest(version: item.displayVersionString, untilInvoking: installHandler)
        }
    }

    /// Beta/stable channel gate — Sparkle re-asks this per check, so a settings.json edit
    /// takes effect at the very next check with no daemon/app restart needed.
    nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        MainActor.assumeIsolated { allowedChannelSet(for: deps.readChannel()) }
    }
}
