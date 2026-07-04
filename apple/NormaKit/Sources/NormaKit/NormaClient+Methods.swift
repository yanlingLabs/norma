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

    public func listSessions() async throws -> [(sessionId: String, scope: String, createdAt: Int, lastSeq: Int)] {
        let r = try await request("session.list", params: nil)
        return (r["sessions"]?.arrayValue ?? []).compactMap { s in
            guard let id = s["sessionId"]?.stringValue, let scope = s["scope"]?.stringValue,
                  let created = s["createdAt"]?.intValue, let last = s["lastSeq"]?.intValue else { return nil }
            return (id, scope, created, last)
        }
    }

    /// Attaches (server replays events with seq > fromSeq). Seeds the client-side dedupe
    /// watermark BEFORE the request so replayed events pass `seq > lastSeq`.
    public func attach(sessionId: String, fromSeq: Int = 0) async throws -> Int {
        attachedSessionId = sessionId
        lastSeq = fromSeq
        let r = try await request("session.attach", params: obj([
            "sessionId": .string(sessionId), "fromSeq": .number(Double(fromSeq)),
        ]))
        guard let last = r["lastSeq"]?.intValue else { throw RpcError(code: -3, message: "invalid result from server for session.attach") }
        return last
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
}
