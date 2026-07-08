import Foundation

/// Accepts new `NSXPCConnection`s for the `com.norma.helper` mach service and pins each one to
/// processes signed by team 37N77U9RSZ, per task-3-brief.md's exact requirement string.
final class HelperServiceDelegate: NSObject, NSXPCListenerDelegate {
    private static let codeSigningRequirement =
        "anchor apple generic and certificate leaf[subject.OU] = \"37N77U9RSZ\""

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection) -> Bool {
        newConnection.exportedInterface = NSXPCInterface(with: NormaHelperProtocol.self)
        newConnection.exportedObject = HelperService()
        // `NSXPCConnection.setCodeSigningRequirement(_:)` (macOS 13+) has no synchronous
        // "reject" return value — the only failure mode it can raise is an NSException for a
        // malformed requirement *string*, which can't happen here since the string above is a
        // hardcoded constant. A connecting peer that doesn't satisfy the requirement isn't
        // rejected at accept time; instead the OS invalidates the connection the moment the peer
        // sends its first message, which is the "reject on failure" behavior described in the
        // brief, just enforced slightly later in the connection's lifecycle than
        // `shouldAcceptNewConnection` itself. Must be set before `resume()` (XPC error otherwise).
        newConnection.setCodeSigningRequirement(Self.codeSigningRequirement)
        newConnection.resume()
        return true
    }
}

/// The exported XPC object. Translates `ChargeLimitPlan` decisions (from the pure
/// `chargeLimitPlan` in SMCController.swift) into SMC writes and (resultJson, errorJson) replies.
final class HelperService: NSObject, NormaHelperProtocol {
    private let smc = SMCController()

    func setChargeLimit(_ percent: Int, reply: @escaping (String?, String?) -> Void) {
        let plan = chargeLimitPlan(percent: percent, appleSilicon: smc.isAppleSilicon())
        switch plan {
        case .invalidRange:
            reply(nil, Self.errorJson(code: "invalid_range", message: "percent must be between 50 and 100"))
        case .unsupportedValue:
            reply(nil, Self.errorJson(code: "unsupported_value", message: "Apple Silicon supports 80 or 100 only"))
        case .writeCHWA(let on):
            do {
                try smc.writeCHWA(on)
                reply(Self.resultJson(percent: percent, mechanism: "CHWA"), nil)
            } catch {
                reply(nil, Self.errorJson(code: "smc_error", message: "\(error)"))
            }
        case .writeBCLM(let value):
            do {
                try smc.writeBCLM(value)
                reply(Self.resultJson(percent: percent, mechanism: "BCLM"), nil)
            } catch {
                reply(nil, Self.errorJson(code: "smc_error", message: "\(error)"))
            }
        }
    }

    func getChargeLimit(reply: @escaping (String?, String?) -> Void) {
        let appleSilicon = smc.isAppleSilicon()
        do {
            if appleSilicon {
                let on = try smc.readCHWA()
                reply(Self.resultJson(percent: on ? 80 : 100, mechanism: "CHWA"), nil)
            } else {
                let percent = try smc.readBCLM()
                reply(Self.resultJson(percent: Int(percent), mechanism: "BCLM"), nil)
            }
        } catch {
            reply(nil, Self.errorJson(code: "smc_error", message: "\(error)"))
        }
    }

    // MARK: - JSON payloads

    private struct ResultPayload: Encodable {
        let percent: Int
        let mechanism: String
    }

    private struct ErrorPayload: Encodable {
        let code: String
        let message: String
    }

    private static func resultJson(percent: Int, mechanism: String) -> String {
        encode(ResultPayload(percent: percent, mechanism: mechanism))
    }

    private static func errorJson(code: String, message: String) -> String {
        encode(ErrorPayload(code: code, message: message))
    }

    private static func encode<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value), let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }
}
