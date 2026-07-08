import Foundation
import NormaProtocol

extension NormaClient {
    private func obj(_ pairs: [String: JSONValue?]) -> JSONValue {
        .object(pairs.compactMapValues { $0 })
    }

    public func createSession(scope: String, cwd: String? = nil, approvalPolicy: String? = nil) async throws -> (sessionId: String, trusted: Bool) {
        let r = try await request("session.create", params: obj([
            "scope": .string(scope),
            "cwd": cwd.map { .string($0) },
            "approvalPolicy": approvalPolicy.map { .string($0) },
        ]))
        guard let id = r["sessionId"]?.stringValue, let trusted = r["trusted"]?.boolValue else {
            throw RpcError(code: -3, message: "invalid result from server for session.create")
        }
        return (id, trusted)
    }

    public func listSessions() async throws -> [(sessionId: String, scope: String, createdAt: Int, lastSeq: Int, title: String?, cwd: String?)] {
        let r = try await request("session.list", params: nil)
        return (r["sessions"]?.arrayValue ?? []).compactMap { s in
            guard let id = s["sessionId"]?.stringValue, let scope = s["scope"]?.stringValue,
                  let created = s["createdAt"]?.intValue, let last = s["lastSeq"]?.intValue else { return nil }
            return (id, scope, created, last, s["title"]?.stringValue, s["cwd"]?.stringValue)
        }
    }

    /// Attaches (server replays events with seq > fromSeq). Seeds the client-side dedupe
    /// watermark BEFORE the request so replayed events pass `seq > lastSeq`.
    ///
    /// AMENDMENT 5 (carried from Task 8 review): seeding before the await is deliberate (replay
    /// race safety), but that left attachedSessionId/lastSeq corrupted if the request threw.
    /// Snapshot the previous values and restore them on any failure before rethrowing.
    public func attach(sessionId: String, fromSeq: Int = 0) async throws -> Int {
        let previousSessionId = attachedSessionId
        let previousLastSeq = lastSeq
        attachedSessionId = sessionId
        lastSeq = fromSeq
        do {
            let r = try await request("session.attach", params: obj([
                "sessionId": .string(sessionId), "fromSeq": .number(Double(fromSeq)),
            ]))
            guard let last = r["lastSeq"]?.intValue else { throw RpcError(code: -3, message: "invalid result from server for session.attach") }
            return last
        } catch {
            attachedSessionId = previousSessionId
            lastSeq = previousLastSeq
            throw error
        }
    }

    public func send(sessionId: String, text: String) async throws -> Int {
        let r = try await request("session.send", params: obj(["sessionId": .string(sessionId), "text": .string(text)]))
        guard let seq = r["seq"]?.intValue else { throw RpcError(code: -3, message: "invalid result from server for session.send") }
        return seq
    }

    public func steer(sessionId: String, text: String) async throws -> Bool {
        try await request("session.steer", params: obj(["sessionId": .string(sessionId), "text": .string(text)]))["injected"]?.boolValue ?? false
    }

    public func interrupt(sessionId: String) async throws -> Bool {
        try await request("session.interrupt", params: obj(["sessionId": .string(sessionId)]))["wasRunning"]?.boolValue ?? false
    }

    public func compact(sessionId: String) async throws -> (compacted: Bool, uptoSeq: Int) {
        let r = try await request("session.compact", params: obj(["sessionId": .string(sessionId)]))
        return (r["compacted"]?.boolValue ?? false, r["uptoSeq"]?.intValue ?? 0)
    }

    public func approvalRespond(sessionId: String, callId: String, approved: Bool) async throws -> Bool {
        try await request("approval.respond", params: obj([
            "sessionId": .string(sessionId), "callId": .string(callId), "approved": .bool(approved),
        ]))["alreadyResolved"]?.boolValue ?? false
    }

    public func askUserRespond(sessionId: String, callId: String, answers: [String: String]) async throws -> Bool {
        try await request("ask_user.respond", params: obj([
            "sessionId": .string(sessionId), "callId": .string(callId),
            "answers": .object(answers.mapValues { .string($0) }),
        ]))["alreadyResolved"]?.boolValue ?? false
    }

    public func planRespond(sessionId: String, callId: String, approved: Bool, autoAccept: Bool = false, feedback: String? = nil) async throws -> Bool {
        try await request("plan.respond", params: obj([
            "sessionId": .string(sessionId), "callId": .string(callId),
            "approved": .bool(approved), "autoAccept": .bool(autoAccept),
            "feedback": feedback.map { .string($0) },
        ]))["alreadyResolved"]?.boolValue ?? false
    }

    public func setPolicy(sessionId: String, policy: String) async throws {
        _ = try await request("session.setPolicy", params: obj(["sessionId": .string(sessionId), "policy": .string(policy)]))
    }

    public func taskList(sessionId: String) async throws -> [(id: String, subject: String, status: String, activeForm: String?)] {
        let r = try await request("task.list", params: obj(["sessionId": .string(sessionId)]))
        return (r["tasks"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["id"]?.stringValue, let subject = t["subject"]?.stringValue, let status = t["status"]?.stringValue else { return nil }
            return (id, subject, status, t["activeForm"]?.stringValue)
        }
    }

    public func threadList(sessionId: String) async throws -> [(threadId: String, parentThreadId: String?, agentType: String?, status: String, stopReason: String?)] {
        let r = try await request("thread.list", params: obj(["sessionId": .string(sessionId)]))
        return (r["threads"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["threadId"]?.stringValue, let status = t["status"]?.stringValue else { return nil }
            return (id, t["parentThreadId"]?.stringValue, t["agentType"]?.stringValue, status, t["stopReason"]?.stringValue)
        }
    }

    public func addDir(sessionId: String, path: String, persist: Bool = false) async throws -> [String] {
        let r = try await request("session.addDir", params: obj([
            "sessionId": .string(sessionId), "path": .string(path), "persist": .bool(persist),
        ]))
        return (r["roots"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    public func setCwd(sessionId: String, cwd: String) async throws -> String {
        try await request("session.setCwd", params: obj(["sessionId": .string(sessionId), "cwd": .string(cwd)]))["cwd"]?.stringValue ?? cwd
    }

    public func trustDir(path: String) async throws -> Bool {
        try await request("daemon.trustDir", params: obj(["path": .string(path)]))["trusted"]?.boolValue ?? false
    }

    public func bgList(sessionId: String) async throws -> [(taskId: String, command: String, status: String, exitCode: Int?)] {
        let r = try await request("bg.list", params: obj(["sessionId": .string(sessionId)]))
        return (r["tasks"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["taskId"]?.stringValue, let cmd = t["command"]?.stringValue, let st = t["status"]?.stringValue else { return nil }
            return (id, cmd, st, t["exitCode"]?.intValue)
        }
    }

    public func bgPeek(sessionId: String, taskId: String) async throws -> (chunk: String, status: String, exitCode: Int?) {
        let r = try await request("bg.peek", params: obj(["sessionId": .string(sessionId), "taskId": .string(taskId)]))
        return (r["chunk"]?.stringValue ?? "", r["status"]?.stringValue ?? "unknown", r["exitCode"]?.intValue)
    }

    public func bgKill(sessionId: String, taskId: String) async throws {
        _ = try await request("bg.kill", params: obj(["sessionId": .string(sessionId), "taskId": .string(taskId)]))
    }

    public func bgKillAll(sessionId: String) async throws -> Int {
        try await request("bg.killAll", params: obj(["sessionId": .string(sessionId)]))["killed"]?.intValue ?? 0
    }

    public func skillsList(cwd: String? = nil) async throws -> [(name: String, description: String, source: String)] {
        let r = try await request("skills.list", params: obj(["cwd": cwd.map { .string($0) }]))
        return (r["skills"]?.arrayValue ?? []).compactMap { s in
            guard let n = s["name"]?.stringValue, let d = s["description"]?.stringValue, let src = s["source"]?.stringValue else { return nil }
            return (n, d, src)
        }
    }

    public func mcpList(cwd: String? = nil) async throws -> [(name: String, status: String, toolNames: [String], source: String)] {
        let r = try await request("mcp.list", params: obj(["cwd": cwd.map { .string($0) }]))
        return (r["servers"]?.arrayValue ?? []).compactMap { s in
            guard let n = s["name"]?.stringValue, let st = s["status"]?.stringValue, let src = s["source"]?.stringValue else { return nil }
            return (n, st, (s["toolNames"]?.arrayValue ?? []).compactMap { $0.stringValue }, src)
        }
    }

    public func pluginsList() async throws -> [(name: String, skills: [String], hasMcp: Bool, mcpEnabled: Bool, disabled: Bool)] {
        let r = try await request("plugins.list", params: .object([:]))
        return (r["plugins"]?.arrayValue ?? []).compactMap { p in
            guard let n = p["name"]?.stringValue else { return nil }
            return (n, (p["skills"]?.arrayValue ?? []).compactMap { $0.stringValue },
                    p["hasMcp"]?.boolValue ?? false, p["mcpEnabled"]?.boolValue ?? false, p["disabled"]?.boolValue ?? false)
        }
    }

    // MARK: - Peripheral lease (provider side) + dashboard reads (Phase 2f)

    /// Provider-side: advertise which capability classes this connection can serve (with current
    /// TCC-grant state per class). Sent on attach and again whenever TCC state changes.
    public func peripheralAdvertise(classes: [(class: String, tccGranted: Bool)]) async throws {
        let arr: [JSONValue] = classes.map { .object(["class": .string($0.class), "tccGranted": .bool($0.tccGranted)]) }
        _ = try await request("peripheral.advertise", params: obj(["classes": .array(arr)]))
    }

    /// Provider-side: revoke a single lease (`leaseId`) or every active lease (`leaseId == nil`,
    /// wire `all: true`) — panic uses the latter. `reason` is one of the `lease_lost` reasons.
    public func peripheralRevoke(leaseId: String?, reason: String) async throws {
        var params: [String: JSONValue?] = ["reason": .string(reason)]
        if let leaseId { params["leaseId"] = .string(leaseId) } else { params["all"] = .bool(true) }
        _ = try await request("peripheral.revoke", params: obj(params))
    }

    /// Provider-side: answer a `peripheral_call_requested` event with either a JSON-encoded
    /// result or an error message (mutually exclusive; follows the approval-broker response shape).
    public func peripheralRespond(requestId: String, resultJson: String?, error: String?) async throws {
        _ = try await request("peripheral.respond", params: obj([
            "requestId": .string(requestId),
            "resultJson": resultJson.map { .string($0) },
            "error": error.map { .string($0) },
        ]))
    }

    /// Provider-side (Phase 4c Task 1, spec §5): answer a `hardware_requested` event with either
    /// a JSON-encoded result or an error message (mutually exclusive) — mirrors
    /// `peripheralRespond`'s shape exactly. Only the active provider connection (Norma.app) may
    /// call this; the core-side broker (Task 2) rejects it otherwise.
    public func hardwareRespond(requestId: String, resultJson: String?, error: String?) async throws {
        _ = try await request("hardware.respond", params: obj([
            "requestId": .string(requestId),
            "resultJson": resultJson.map { .string($0) },
            "error": error.map { .string($0) },
        ]))
    }

    /// Dashboard read: daemon identity/uptime + the current peripheral provider (if any).
    public func daemonStatus() async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int) {
        let r = try await request("daemon.status", params: nil)
        let provider = r["provider"]
        return (
            r["version"]?.stringValue ?? "",
            r["uptimeMs"]?.intValue ?? 0,
            r["socketPath"]?.stringValue ?? "",
            provider?["id"]?.stringValue,
            provider?["model"]?.stringValue,
            r["sessionsCount"]?.intValue ?? 0,
            r["pluginsCount"]?.intValue ?? 0
        )
    }

    /// Dashboard read: rate-limit state (`kind: "ok"|"limited"`, `resumeAt` when limited) + token usage.
    public func quotaState() async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int) {
        let r = try await request("quota.state", params: nil)
        return (r["kind"]?.stringValue ?? "ok", r["resumeAt"]?.intValue, r["inputTokens"]?.intValue ?? 0, r["outputTokens"]?.intValue ?? 0)
    }

    /// Dashboard read: trusted working directories.
    public func trustList() async throws -> [String] {
        let r = try await request("trust.list", params: nil)
        return (r["dirs"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    /// Dashboard write: revoke trust for a directory; returns whether it was actually removed.
    public func trustRemove(path: String) async throws -> Bool {
        try await request("trust.remove", params: obj(["path": .string(path)]))["removed"]?.boolValue ?? false
    }
}
