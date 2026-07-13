import Foundation

/// Injected seam (mirrors `PeripheralProvider`'s live-vs-fake dependency pattern) so
/// `DaemonSupervisor`'s tests never launch a real process, stat the real filesystem, or read a
/// real environment variable. Production wiring (Task 6) supplies the live closures:
/// `bundledDaemonPath` resolves `Bundle.main`'s embedded `norma-core` (Release only — see
/// `project.yml`'s "Embed norma-core" script), `socketExists` stats `~/.norma/run/core.sock`,
/// `isDevEnv` checks `NORMA_DEV`, `spawn` launches `norma-core daemon run`.
struct DaemonSupervisorDeps {
    var bundledDaemonPath: () -> String?
    var socketExists: () -> Bool
    var isDevEnv: () -> Bool
    var spawn: (_ path: String) -> DaemonProcess
    var now: () -> Date
}

/// The running daemon child, narrowed to exactly what `DaemonSupervisor` needs — mockable so tests
/// exercise crash/respawn/stop logic without a real `Process`. `onExit`'s `intentional` flag is the
/// entire crash-vs-graceful-stop distinction: `true` means the exit followed OUR OWN
/// `terminateGracefully()`/`forceStop()` call (from `stop()`/`restart()`); `false` means the
/// daemon went away on its own (crash) — respawn-vs-not hinges entirely on this flag, never on
/// exit codes or signals, since the fake test double has neither.
protocol DaemonProcess: AnyObject {
    var isRunning: Bool { get }
    /// SIGTERM-ish; the concrete implementation is responsible for reporting the ensuing exit to
    /// `onExit` with `intentional: true`.
    func terminateGracefully()
    /// Escalation if `terminateGracefully()` doesn't land in time — not called anywhere in this
    /// task (no timeout/scheduler seam yet); reserved for a future graceful-timeout upgrade.
    func forceStop()
    var onExit: ((_ intentional: Bool) -> Void)? { get set }
}

/// Owns the bundled `norma-core` daemon's lifecycle for a SHIPPED app: spawns it once, quietly
/// respawns it on crash (capped, so a boot-looping daemon doesn't spin forever), and kills it
/// intentionally when the app quits — the app itself is NEVER restarted because the daemon
/// crashed. In DEV (`NORMA_DEV` set), when unbundled, or when a socket is already live (a
/// hand-run daemon holds it), `start()` spawns NOTHING: `.connectOnly` is what keeps a developer's
/// manually-launched daemon completely untouched.
@MainActor
final class DaemonSupervisor {
    enum Mode: Equatable { case supervising, connectOnly }
    enum State: Equatable { case idle, running, respawning(attempt: Int), stopped, failed }

    static let maxRapidRespawns = 5
    static let rapidWindowSeconds = 10.0

    /// Decided once, by `start()`; `.connectOnly` until then.
    private(set) var mode: Mode = .connectOnly
    private(set) var state: State = .idle

    private let deps: DaemonSupervisorDeps
    private var daemonPath: String?
    private var process: DaemonProcess?

    /// What the NEXT exit of `process` means, set right before calling `terminateGracefully()` so
    /// `handleExit` can tell "we asked for this" apart from a same-shaped crash exit racing it.
    private enum PendingAction { case stopping, restarting }
    private var pendingAction: PendingAction?

    /// Timestamps of unintentional exits still inside the rolling `rapidWindowSeconds` window —
    /// pruned on every crash, so a daemon that crashes once, runs fine for an hour, then crashes
    /// again doesn't inherit the earlier crash toward the cap.
    private var recentCrashes: [Date] = []

    init(deps: DaemonSupervisorDeps) {
        self.deps = deps
    }

    /// Dev-decoupling contract (binding, verbatim): a pre-existing live socket ALWAYS wins — even
    /// a bundled binary in a non-dev build must never spawn a second daemon onto an
    /// already-occupied socket. Meant to be called once per launch.
    func start() {
        let bundled = deps.bundledDaemonPath()
        mode = (bundled != nil && !deps.socketExists() && !deps.isDevEnv()) ? .supervising : .connectOnly
        guard mode == .supervising, let path = bundled else {
            return // connectOnly: spawn nothing; state stays .idle (nothing under our management).
        }
        daemonPath = path
        spawnFresh()
    }

    /// Intentional full teardown (app quit). Safe to call with nothing running (already
    /// `.connectOnly`, already stopped, or already `.failed`).
    func stop() {
        guard let process, process.isRunning else {
            // Leave a tripped .failed diagnosis visible rather than clobbering it on quit.
            if state != .failed { state = .stopped }
            return
        }
        pendingAction = .stopping
        process.terminateGracefully()
    }

    /// Intentional restart (v1 caller: manual menu action; later, post-Sparkle-update). Bypasses
    /// the rapid-respawn cap entirely — including recovering from `.failed` — since a deliberate
    /// restart shouldn't inherit crash history from before the intervention. No-op in
    /// `.connectOnly` (there is no daemon this supervisor spawned to restart).
    func restart() {
        guard mode == .supervising else { return }
        guard let process, process.isRunning else {
            spawnFresh()
            return
        }
        pendingAction = .restarting
        process.terminateGracefully()
    }

    private func handleExit(intentional: Bool) {
        guard intentional else {
            respawnAfterCrash()
            return
        }
        switch pendingAction {
        case .restarting:
            pendingAction = nil
            spawnFresh()
        case .stopping, .none:
            pendingAction = nil
            process = nil
            state = .stopped
        }
    }

    /// A crash-triggered respawn — counted against the rapid-respawn cap.
    private func respawnAfterCrash() {
        let t = deps.now()
        recentCrashes.append(t)
        recentCrashes.removeAll { t.timeIntervalSince($0) > Self.rapidWindowSeconds }
        guard recentCrashes.count <= Self.maxRapidRespawns else {
            process = nil
            state = .failed
            return
        }
        performSpawn()
        state = .respawning(attempt: recentCrashes.count)
    }

    /// A fresh, deliberate launch — the very first spawn from `start()`, or a manual `restart()`
    /// (including recovery from `.failed`). Resets the rapid-crash tracker.
    private func spawnFresh() {
        recentCrashes.removeAll()
        performSpawn()
        state = .running
    }

    private func performSpawn() {
        guard let daemonPath else { return }
        let p = deps.spawn(daemonPath)
        process = p
        p.onExit = { [weak self] intentional in
            self?.handleExit(intentional: intentional)
        }
    }
}
