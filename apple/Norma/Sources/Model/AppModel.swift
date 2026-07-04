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
    func ensureFocusedSession() async -> String? {
        if let sid = focusedSessionId { return sid }
        guard let created = try? await client.createSession(scope: "global", cwd: NSHomeDirectory()) else { return nil }
        selfCreatedSessionId = created.sessionId // the broadcast for our own create must not re-refocus
        await refocus(onto: created.sessionId)
        return focusedSessionId
    }

    /// Field submit: steer a running turn, otherwise send (starts a turn). CLI parity.
    func sendOrSteer(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sid = await ensureFocusedSession() else { return false }
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
