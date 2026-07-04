import Foundation
import NormaProtocol

public struct RpcError: Error, Equatable, Sendable {
    public let code: Int
    public let message: String
    public init(code: Int, message: String) { self.code = code; self.message = message }
}

public enum ServerMessage: Sendable {
    case response(id: Int, result: Result<JSONValue, RpcError>)
    case event(SessionEvent)
    /// A well-formed "event" notification whose params failed SessionEvent decoding — a newer
    /// daemon's event type. Never a crash, never silently dropped (spec §4.2 forward-compat).
    case unknownEvent(raw: String)
    case unrecognized(raw: String)
}

private struct InboundLine: Decodable {
    struct ErrorPayload: Decodable { let code: Int; let message: String }
    let id: Int?
    let result: JSONValue?
    let error: ErrorPayload?
    let method: String?
    let params: JSONValue?
}

/// Route one NDJSON line from the daemon. Total: never throws — malformed input degrades to
/// `.unrecognized`, a decodable-envelope-but-unknown event to `.unknownEvent`.
public func parseServerLine(_ line: String) -> ServerMessage {
    guard let data = line.data(using: .utf8),
          let inbound = try? JSONDecoder().decode(InboundLine.self, from: data) else {
        return .unrecognized(raw: line)
    }
    if let id = inbound.id {
        if let err = inbound.error { return .response(id: id, result: .failure(RpcError(code: err.code, message: err.message))) }
        return .response(id: id, result: .success(inbound.result ?? .null))
    }
    if inbound.method == "event", let params = inbound.params {
        // Re-encode the params subtree and decode strictly via NormaProtocol (fail-loud there,
        // wrapped here). Double decode is fine at NDJSON line rates.
        if let paramsData = try? JSONEncoder().encode(params),
           let event = try? JSONDecoder().decode(SessionEvent.self, from: paramsData) {
            return .event(event)
        }
        return .unknownEvent(raw: line)
    }
    return .unrecognized(raw: line)
}
