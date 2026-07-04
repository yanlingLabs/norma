import AppKit

/// D1 orchestration: the main thread only reads a cache and runs the pure policy;
/// every AX call happens on `queue`. Lag degrades to NO stickiness, never to orb jank.
@MainActor
final class StickinessEngine {
    private let onTarget: (CGPoint?) -> Void
    private let queue = DispatchQueue(label: "norma.stickiness.ax", qos: .userInteractive)
    private let scanner = AXScanner()

    private var enabled = true
    private var running = false
    private var scanInFlight = false
    private var pendingCursor: CGPoint?
    private var lastScanAt: TimeInterval = 0
    private var candidates: [ClickableCandidate] = []
    private var currentTarget: CGPoint?
    private var consecutiveFailures = 0
    private var degradedPid: pid_t = 0
    private var lastPid: pid_t = 0 // main-actor copy fed by finishScan — never read scanner state from main
    private var retriedAfterPoke = false
    private var activationObserver: NSObjectProtocol?

    init(onTarget: @escaping (CGPoint?) -> Void) {
        self.onTarget = onTarget
    }

    func start() {
        guard !running else { return }
        running = true
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.clearDegrade() }
        }
    }

    func stop() {
        running = false
        if let o = activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        activationObserver = nil
        publish(nil)
    }

    func setEnabled(_ e: Bool) {
        enabled = e
        if !e { publish(nil) }
    }

    func updateCursorLocation(_ p: CGPoint) {
        guard running, enabled else { return }
        // Policy runs immediately against the cache — zero-latency hold/release.
        applyPolicy(cursor: p)
        // Scanning is coalesced: one in flight, at most every rescanInterval.
        pendingCursor = p
        maybeScan()
    }

    private func applyPolicy(cursor: CGPoint) {
        let t = stickyTarget(cursor: cursor, current: currentTarget, candidates: candidates)
        publish(t)
    }

    private func publish(_ t: CGPoint?) {
        guard t != currentTarget else { return }
        currentTarget = t
        onTarget(t)
    }

    private func maybeScan() {
        guard !scanInFlight, let cursor = pendingCursor else { return }
        let now = CFAbsoluteTimeGetCurrent()
        guard now - lastScanAt >= StickinessConstants.rescanInterval else { return }
        guard degradedPid == 0 || lastPid != degradedPid else { return }

        scanInFlight = true
        lastScanAt = now
        pendingCursor = nil

        queue.async { [weak self, scanner] in
            let result = scanner.scan(around: cursor, deadline: StickinessConstants.scanDeadline)
            let pid = scanner.lastHitPid
            Task { @MainActor [weak self] in
                self?.finishScan(result, pid: pid, cursor: cursor)
            }
        }
    }

    private func finishScan(_ result: ScanResult, pid: pid_t, cursor: CGPoint) {
        scanInFlight = false
        lastPid = pid
        switch result {
        case .candidates(let found):
            consecutiveFailures = 0
            retriedAfterPoke = false
            candidates = found
            applyPolicy(cursor: cursor)
        case .emptyTree:
            if !retriedAfterPoke {
                // D2: the poke takes effect only after the app rebuilds its tree — one
                // delayed retry before it counts as a failure.
                retriedAfterPoke = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                    self?.pendingCursor = cursor
                    self?.maybeScan()
                }
                return
            }
            registerFailure(pid: pid)
        case .timedOut:
            registerFailure(pid: pid)
        }
        // A pending cursor that arrived mid-scan gets its scan now.
        maybeScan()
    }

    private func registerFailure(pid: pid_t) {
        consecutiveFailures += 1
        candidates = []
        publish(nil) // degrade to NO stickiness, never to lag (D1 contract)
        if consecutiveFailures >= StickinessConstants.maxConsecutiveFailures, pid != 0 {
            degradedPid = pid // this app's AX is dead/slow — stop hammering it
        }
    }

    private func clearDegrade() {
        degradedPid = 0
        consecutiveFailures = 0
        retriedAfterPoke = false
        queue.async { [scanner] in scanner.resetPokes() } // scanner state stays queue-confined
    }
}
