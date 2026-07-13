import XCTest
@testable import Norma

/// Lifecycle Task 2: `DaemonSupervisor` — the dev-decoupling contract (`.connectOnly` spawns
/// NOTHING; a pre-existing live socket always short-circuits) and crash-respawn-with-backoff.
/// `FakeDaemonProcess` below stands in for a real `Process` so these never launch anything real —
/// `simulateExit` is the only way an exit reaches the supervisor.
@MainActor
final class DaemonSupervisorTests: XCTestCase {
    // MARK: - Step 1: connectOnly (dev / socket-live / unbundled) — never a second daemon

    func testStartIsConnectOnlyWhenSocketAlreadyLive() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { "/x/norma-core" }, socketExists: { true }, isDevEnv: { false },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly)
        XCTAssertEqual(spawned, 0) // never a second daemon
    }

    func testStartIsConnectOnlyInDevEnv() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { "/x" }, socketExists: { false }, isDevEnv: { true },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly)
        XCTAssertEqual(spawned, 0)
    }

    func testStartIsConnectOnlyWhenUnbundled() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { nil }, socketExists: { false }, isDevEnv: { false },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly)
        XCTAssertEqual(spawned, 0)
    }

    // MARK: - Step 2: supervising spawns exactly once

    func testSupervisingSpawnsOnce() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/norma-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .supervising)
        XCTAssertEqual(spawned, 1)
        XCTAssertEqual(s.state, .running)
    }

    // MARK: - Step 3: crash respawns, intentional stop does not

    func testCrashRespawnsButIntentionalStopDoesNot() {
        var spawned = 0; var procs: [FakeDaemonProcess] = []
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/norma-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; let p = FakeDaemonProcess(); procs.append(p); return p }, now: { Date() }))
        s.start()
        procs.last!.simulateExit(intentional: false) // crash
        XCTAssertEqual(spawned, 2) // respawned
        s.stop() // intentional
        procs.last!.simulateExit(intentional: true)
        XCTAssertEqual(spawned, 2) // NOT respawned
        XCTAssertEqual(s.state, .stopped)
    }

    // MARK: - Step 4: respawn backoff cap trips .failed

    func testRapidRespawnCapTripsFailed() {
        // 6 crashes within the window → state .failed, spawn stops at the cap+1.
        var spawned = 0; var procs: [FakeDaemonProcess] = []
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/norma-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; let p = FakeDaemonProcess(); procs.append(p); return p }, now: { Date() }))
        s.start()
        for _ in 0..<6 {
            procs.last!.simulateExit(intentional: false)
        }
        XCTAssertEqual(spawned, DaemonSupervisor.maxRapidRespawns + 1)
        XCTAssertEqual(s.state, .failed)
    }
}

/// `DaemonProcess` test double: a child process that never actually runs. `simulateExit` is the
/// ONLY way its `onExit` fires — nothing here spawns real work or races real time.
final class FakeDaemonProcess: DaemonProcess {
    private(set) var isRunning = true
    var onExit: ((_ intentional: Bool) -> Void)?
    private(set) var terminateGracefullyCallCount = 0
    private(set) var forceStopCallCount = 0

    func terminateGracefully() {
        terminateGracefullyCallCount += 1
    }

    func forceStop() {
        forceStopCallCount += 1
        isRunning = false
    }

    /// Test-only trigger standing in for the real process's actual exit — `intentional` mirrors
    /// exactly what a real termination-handler wrapper would report (true only when the exit
    /// followed OUR OWN `terminateGracefully()`/`forceStop()` call).
    func simulateExit(intentional: Bool) {
        isRunning = false
        onExit?(intentional)
    }
}
