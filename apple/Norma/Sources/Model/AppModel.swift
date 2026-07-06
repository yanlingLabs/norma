import Foundation
import NormaProtocol
import NormaKit

@MainActor
final class AppModel: ObservableObject {
    let session = SessionModel()
    @Published private(set) var connectionSummary = "connecting…"

    private let client: NormaClient
    private var focusedSessionId: String?
    private var pumpTask: Task<Void, Never>?
    private var selfCreatedSessionId: String?

    /// Finding-1 fix (gate 2): session ids the orb has already forced to `approvalPolicy: "auto"`
    /// (see `forceAutoPolicyIfNeeded`). One flip per focused session id is enough — the daemon
    /// persists the policy — so this keeps every subsequent send off the `session.setPolicy` wire.
    /// A session created BY the orb (`ensureFocusedSession`, born `auto`) is pre-seeded here so it
    /// never needs a redundant flip.
    private var forcedAutoSessionIds: Set<String> = []

    init(makeTransport: @escaping @Sendable () -> NormaTransport, token: String, clientName: String = "orb") {
        client = NormaClient(makeTransport: makeTransport, token: token, clientName: clientName)
    }

    /// Production wiring: harness token from the Keychain, default unix socket.
    static func production() throws -> AppModel {
        let token = try KeychainToken.readHarnessToken()
        let path = NormaPaths.socketPath()
        return AppModel(makeTransport: { UnixSocketTransport(path: path) }, token: token)
    }

    func start() async {
        // The daemon may not be up yet — retry the INITIAL connect with capped backoff.
        var attempt = 0
        while true {
            do {
                try await client.connect()
                break
            } catch {
                attempt += 1
                connectionSummary = "daemon unreachable — retrying…"
                let backoff = min(0.5 * pow(2.0, Double(attempt - 1)), 10.0)
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                if Task.isCancelled { return }
            }
        }

        await focusNewestSession()
        session.markConnected() // M2: connect() success IS the connected signal
        connectionSummary = summaryLine()

        pumpTask = Task { [weak self] in
            guard let self else { return }
            for await ev in self.client.events {
                await self.handle(ev)
                if Task.isCancelled { return }
            }
        }
        await pumpTask?.value
    }

    func stop() {
        pumpTask?.cancel()
        Task { await client.close() }
    }

    /// Field summon path: a session to talk to, creating one if none is focused.
    ///
    /// Orb-created sessions run approvalPolicy "auto": the orb has no approval UI until 2d,
    /// so there's nowhere to surface an "ask" prompt. The daemon's reviewer still gates
    /// dangerous bash regardless of policy — auto ≠ unguarded. Sessions the orb merely
    /// FOLLOWS (created elsewhere, e.g. the CLI) keep their creator's policy, unchanged.
    func ensureFocusedSession() async -> String? {
        if let sid = focusedSessionId { return sid }
        guard let created = try? await client.createSession(scope: "global", cwd: NSHomeDirectory(), approvalPolicy: "auto") else { return nil }
        forcedAutoSessionIds.insert(created.sessionId) // born auto — no redundant setPolicy on first send
        // The daemon broadcasts session_created BEFORE the RPC response returns; the pump may
        // have already refocused us onto the new session. Idempotent skip — never double-attach.
        if focusedSessionId == created.sessionId { return focusedSessionId }
        selfCreatedSessionId = created.sessionId // belt: suppress the broadcast if it arrives AFTER us
        await refocus(onto: created.sessionId)
        return focusedSessionId
    }

    /// Finding-1 fix (gate 2 — "the orb still asks approvals despite the auto default"). ROOT CAUSE:
    /// `ensureFocusedSession()`'s create-with-`auto` path almost never runs, because the orb doesn't
    /// usually create the session it DRIVES. At startup `focusNewestSession()` attaches to the
    /// daemon's pre-existing global session (auto-created by the daemon in its DEFAULT "ask" policy),
    /// and `handle(.sessionCreated)` follows every later broadcast onto whatever session appears — so
    /// `focusedSessionId` is already set and the create path is skipped. The orb then sends into an
    /// ASK-mode session; with no orb approval UI until 2d, the daemon's `approval_requested` hangs
    /// until it times out (observed live in `s_4934f1323319`: a `bash` call sat 300s to the timeout).
    ///
    /// Per the user directive "the orb should NEVER require approval, always auto": force the focused
    /// session to `auto` before the first send/steer we make to it. Idempotent + once-per-session id
    /// (the daemon persists it) via `forcedAutoSessionIds`.
    ///
    /// HONEST NOTE: this also flips the policy for any OTHER harness attached to the same session
    /// (e.g. the CLI). Accepted as an interim measure per the directive — revisit at 2d when the orb
    /// grows its own approval UI. Note `auto ≠ unguarded`: the daemon's bash reviewer still gates
    /// genuinely dangerous commands regardless of policy.
    private func forceAutoPolicyIfNeeded(_ sessionId: String) async {
        guard !forcedAutoSessionIds.contains(sessionId) else { return }
        do {
            try await client.setPolicy(sessionId: sessionId, policy: "auto")
            forcedAutoSessionIds.insert(sessionId) // only mark on success — a failed flip retries next send
            OrbDebug.log("forceAutoPolicy: session \(sessionId.prefix(10)) → auto")
        } catch {
            OrbDebug.log("forceAutoPolicy: setPolicy failed for \(sessionId.prefix(10)) — will retry next send")
        }
    }

    /// Field submit: steer a running turn, otherwise send (starts a turn). CLI parity.
    func sendOrSteer(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sid = await ensureFocusedSession() else { return false }
        await forceAutoPolicyIfNeeded(sid) // Finding-1: the orb never drives an ask-mode session
        if session.state.turnRunning {
            return (try? await client.steer(sessionId: sid, text: trimmed)) != nil
        }
        return (try? await client.send(sessionId: sid, text: trimmed)) != nil
    }

    func interruptTurn() async {
        guard let sid = focusedSessionId else { return }
        _ = try? await client.interrupt(sessionId: sid)
    }

    private func handle(_ ev: NormaEvent) async {
        switch ev {
        case .session(let e):
            if case .sessionCreated(let v) = e {
                if v.sessionId == selfCreatedSessionId { selfCreatedSessionId = nil; return }
                if v.sessionId != focusedSessionId {
                    await refocus(onto: v.sessionId) // most-recent focus (spec §4.4, 2b subset)
                    return
                }
            }
            guard e.sessionId == focusedSessionId else { return }
            session.apply(e)
        case .connection(let s):
            session.apply(connection: s)
            connectionSummary = summaryLine()
        case .unknown:
            break // newer daemon event — orb has nothing to render for it
        }
    }

    private func focusNewestSession() async {
        guard let sessions = try? await client.listSessions(), !sessions.isEmpty else { return }
        let newest = sessions.max(by: { $0.createdAt < $1.createdAt })!
        await refocus(onto: newest.sessionId)
    }

    private func refocus(onto sessionId: String) async {
        // Idempotent: already focused AND attached to this session — nothing to do.
        if sessionId == focusedSessionId, await client.attachedSession == sessionId { return }
        session.reset()
        focusedSessionId = sessionId
        // Full replay from 0 rebuilds tasks/pending state through the reducer.
        do {
            _ = try await client.attach(sessionId: sessionId, fromSeq: 0)
        } catch {
            // Target vanished or transport hiccuped: reconcile with NormaKit's ground truth
            // (attach() rolled its state back), then fall back to the newest surviving session.
            focusedSessionId = await client.attachedSession
            if let sessions = try? await client.listSessions(),
               let newest = sessions.max(by: { $0.createdAt < $1.createdAt }),
               newest.sessionId != sessionId {
                session.reset()
                focusedSessionId = newest.sessionId
                if (try? await client.attach(sessionId: newest.sessionId, fromSeq: 0)) == nil {
                    focusedSessionId = await client.attachedSession // reconcile again on double failure
                }
            }
        }
        connectionSummary = summaryLine()
    }

    private func summaryLine() -> String {
        if session.state.status == .disconnected { return "daemon unreachable" }
        if let sid = focusedSessionId { return "session \(sid.prefix(10))" }
        return "connected — no session yet"
    }
}
