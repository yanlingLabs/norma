import Foundation

extension NormaClient {
    func startReconnect() {
        guard everConnected, !deliberatelyClosed else { return }
        Task { await self.reconnectLoop() }
    }

    private func reconnectLoop() async {
        var attempt = 1
        while !deliberatelyClosed {
            eventsCont.yield(.connection(.reconnecting(attempt: attempt)))
            let backoff = min(0.5 * pow(2.0, Double(attempt - 1)), 10.0)
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            do {
                try await connect() // fresh transport from the factory + hello
                if let sid = attachedSessionId {
                    _ = try await attach(sessionId: sid, fromSeq: lastSeq) // resync: replay > lastSeq
                }
                // AMENDMENT 1: connect() itself no longer yields .connected (removed in Task 7 —
                // AsyncStream pre-iterator buffering made it the first value every iterator saw).
                // This loop is the sole source of the .connected transition on (re)connect success.
                eventsCont.yield(.connection(.connected))
                return
            } catch {
                attempt += 1
            }
        }
    }
}
