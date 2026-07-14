import Foundation
import Sparkle

/// Injectable seam for everything the updater touches outside its own logic
/// (DaemonSupervisorDeps precedent — see DaemonSupervisor.swift).
struct UpdaterCoordinatorDeps {
    /// Current number of executing agent turns; nil when the daemon is unreachable
    /// (treated as idle — nothing to interrupt).
    var activeTurns: () async -> Int?
    /// updates.channel from ~/.norma/settings.json; nil/absent → stable. (Wired in T5.)
    var readChannel: () -> String?
    /// NORMA_UPDATE_FEED env override for local test feeds; nil → Info.plist SUFeedURL.
    var feedOverride: () -> String?
    var now: () -> Date
    var pollIntervalSeconds: TimeInterval
    var badgeAfterSeconds: TimeInterval
}

extension UpdaterCoordinatorDeps {
    /// Production wiring. activeTurns/readChannel are placeholders until T4/T5 wire them
    /// (both fail-open: nil activity = idle, nil channel = stable).
    @MainActor static var live: UpdaterCoordinatorDeps {
        .init(
            activeTurns: { nil },
            readChannel: { nil },
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

    init(deps: UpdaterCoordinatorDeps) {
        self.deps = deps
    }

    /// Testable core of feedURLString(for:).
    func resolvedFeedOverride() -> String? {
        deps.feedOverride()
    }
}

extension UpdaterCoordinator: SPUUpdaterDelegate {
    /// Dev/test override: NORMA_UPDATE_FEED wins; nil → Sparkle falls back to Info.plist.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        MainActor.assumeIsolated { resolvedFeedOverride() }
    }
}
