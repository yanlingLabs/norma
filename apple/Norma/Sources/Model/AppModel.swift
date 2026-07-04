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
                let backoff = min(0.5 * pow(2.0, Double(min(attempt, 5) - 1)), 10.0)
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

    private func handle(_ ev: NormaEvent) async {
        switch ev {
        case .session(let e):
            if case .sessionCreated(let v) = e, v.sessionId != focusedSessionId {
                await refocus(onto: v.sessionId) // most-recent focus (spec §4.4, 2b subset)
                return
            }
            guard sessionId(of: e) == focusedSessionId else { return }
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
        _ = try? await client.attach(sessionId: sessionId, fromSeq: 0)
        connectionSummary = summaryLine()
    }

    private func summaryLine() -> String {
        if session.state.status == .disconnected { return "daemon unreachable" }
        if let sid = focusedSessionId { return "session \(sid.prefix(10))" }
        return "connected — no session yet"
    }

    private func sessionId(of e: SessionEvent) -> String {
        // SessionEvent.seq's sibling accessor: every variant carries sessionId.
        switch e {
        case .sessionCreated(let v): return v.sessionId
        case .harnessAttached(let v): return v.sessionId
        case .harnessDetached(let v): return v.sessionId
        case .userMessage(let v): return v.sessionId
        case .turnStarted(let v): return v.sessionId
        case .assistantMessage(let v): return v.sessionId
        case .assistantDelta(let v): return v.sessionId
        case .toolCall(let v): return v.sessionId
        case .toolResult(let v): return v.sessionId
        case .approvalRequested(let v): return v.sessionId
        case .approvalResolved(let v): return v.sessionId
        case .turnCompleted(let v): return v.sessionId
        case .agentError(let v): return v.sessionId
        case .directoryAdded(let v): return v.sessionId
        case .bgTaskStarted(let v): return v.sessionId
        case .bgTaskOutput(let v): return v.sessionId
        case .bgTaskExited(let v): return v.sessionId
        case .checkpoint(let v): return v.sessionId
        case .questionAsked(let v): return v.sessionId
        case .questionResolved(let v): return v.sessionId
        case .taskUpdated(let v): return v.sessionId
        case .planPresented(let v): return v.sessionId
        case .planResolved(let v): return v.sessionId
        case .worktreeEntered(let v): return v.sessionId
        case .worktreeExited(let v): return v.sessionId
        case .threadStarted(let v): return v.sessionId
        case .threadCompleted(let v): return v.sessionId
        }
    }
}
