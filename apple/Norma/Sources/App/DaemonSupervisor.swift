import Darwin
import Foundation
import NormaKit

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
    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    /// Lifecycle T6: fired on every state transition — the menu bar observes this to flip the
    /// `stateItem` to "engine stopped — Restart" on `.failed` (and back on recovery). `nil` by
    /// default (T2's own tests never wire it, and don't need to).
    var onStateChange: ((State) -> Void)?

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

// -----------------------------------------------------------------------------------------------
// Production wiring (Task 6) — the real `Process`-backed `DaemonProcess` + the live
// `DaemonSupervisorDeps` that composes it with the real bundle/filesystem/environment reads.
// -----------------------------------------------------------------------------------------------

/// The real `Process`-backed `DaemonProcess`: launches the bundled `norma-core` binary as
/// `norma-core daemon run` (same argv the old launchd plist used — see `LaunchdMigration.swift`).
///
/// CONSTRAINT (T2 review, binding): `Process.terminationHandler` fires on an arbitrary background
/// queue Foundation manages — NOT the main actor. `DaemonSupervisor` is `@MainActor` and its
/// `onExit` closure mutates main-actor state (`handleExit`), so every `onExit` invocation below
/// hops to the main actor first (`Task { @MainActor in ... }`); calling it directly from the
/// termination handler's background thread would be a data race on `DaemonSupervisor`'s state.
///
/// Intentional-vs-crash classification: `terminateGracefully()`/`forceStop()` set `stoppedByUs`
/// BEFORE signaling the process, so whichever exit races in reads back the right flag — a SIGTERM
/// from an external `kill` would otherwise be indistinguishable from our own.
final class RealDaemonProcess: DaemonProcess {
    private let process: Process
    private var stoppedByUs = false
    var onExit: ((_ intentional: Bool) -> Void)?

    var isRunning: Bool { process.isRunning }

    init(path: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["daemon", "run"]
        process = p
        p.terminationHandler = { [weak self] _ in
            guard let self else { return }
            let intentional = self.stoppedByUs
            Task { @MainActor in self.onExit?(intentional) } // hop off the background termination queue
        }
        do {
            try p.run()
        } catch {
            NSLog("[RealDaemonProcess] failed to launch \(path): \(error)")
            // Never actually started, so the termination handler above will never fire on its own.
            // Report it as an unintentional exit (a "crash") so DaemonSupervisor's respawn/backoff
            // logic still engages instead of believing a dead daemon is `.running` forever. Deferred
            // via Task so `deps.spawn(...)`'s caller (`performSpawn()`) has already assigned `onExit`
            // by the time this runs (both are on the main actor; the Task body only runs after the
            // current synchronous call frame yields).
            Task { @MainActor in self.onExit?(false) }
        }
    }

    /// SIGTERM.
    func terminateGracefully() {
        stoppedByUs = true
        process.terminate()
    }

    /// SIGKILL. Not called anywhere yet (see the protocol doc above) — reserved for a future
    /// graceful-timeout escalation.
    func forceStop() {
        stoppedByUs = true
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }
}

extension DaemonSupervisorDeps {
    /// Production wiring: the real `Bundle.main`-embedded `norma-core` (Release builds only — the
    /// "Embed norma-core" build script skips Debug/Test, see `project.yml`), the real
    /// `~/.norma/run/core.sock` stat, the real `NORMA_DEV` env read, and a real `RealDaemonProcess`
    /// spawn. `AppDelegate.boot()`'s sole production caller.
    static let live = DaemonSupervisorDeps(
        bundledDaemonPath: { Bundle.main.path(forResource: "norma-core", ofType: nil) },
        socketExists: { FileManager.default.fileExists(atPath: NormaPaths.socketPath()) },
        isDevEnv: { ProcessInfo.processInfo.environment["NORMA_DEV"] != nil },
        spawn: { path in RealDaemonProcess(path: path) },
        now: { Date() }
    )

    /// Defense in depth for unit tests that call `AppDelegate.boot()` WITHOUT overriding
    /// `daemonSupervisorDeps` (the vast majority — `ScaffoldTests`, `DashboardTests`, etc.):
    /// `bundledDaemonPath` always resolves `nil`, so `DaemonSupervisor.start()` always lands in
    /// `.connectOnly` and spawns nothing, regardless of what the test host's `Bundle.main` happens
    /// to contain — e.g. a Release-configuration test run that DID embed norma-core. Belt-and-
    /// suspenders on top of `AppDelegate.boot()`'s own `Self.isRunningUnitTests` branch below.
    static let neverSupervise = DaemonSupervisorDeps(
        bundledDaemonPath: { nil },
        socketExists: { false },
        isDevEnv: { true },
        spawn: { _ in fatalError("neverSupervise.spawn is unreachable — bundledDaemonPath is always nil") },
        now: { Date() }
    )
}
