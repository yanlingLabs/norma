import Foundation

public enum SessionEvent: Codable, Equatable {
    case sessionCreated(SessionCreated)
    case harnessAttached(HarnessAttached)
    case harnessDetached(HarnessDetached)
    case userMessage(UserMessage)
    case turnStarted(TurnStarted)
    case assistantMessage(AssistantMessage)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case approvalRequested(ApprovalRequested)
    case approvalResolved(ApprovalResolved)
    case turnCompleted(TurnCompleted)
    case agentError(AgentError)
    case directoryAdded(DirectoryAdded)
    case bgTaskStarted(BgTaskStarted)
    case bgTaskOutput(BgTaskOutput)
    case bgTaskExited(BgTaskExited)
    case checkpoint(Checkpoint)

    public struct SessionCreated: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let scope: String
    }

    public struct HarnessAttached: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let clientName: String
    }

    public struct HarnessDetached: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let clientName: String
    }

    public struct UserMessage: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let text: String
        public let clientName: String
    }

    public struct TurnStarted: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
    }

    public struct AssistantMessage: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let text: String
    }

    public struct ToolCall: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let name: String
        public let argsJson: String
    }

    public struct ToolResult: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let output: String
        public let isError: Bool
    }

    public struct ApprovalRequested: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let toolName: String
        public let summary: String
    }

    public struct ApprovalResolved: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let approved: Bool
        public let by: String
    }

    public struct TurnCompleted: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let stopReason: String
        public let inputTokens: Int
        public let outputTokens: Int
    }

    public struct AgentError: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let message: String
    }

    public struct DirectoryAdded: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let path: String
        public let persisted: Bool
    }

    public struct BgTaskStarted: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let command: String
    }

    public struct BgTaskOutput: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let chunk: String
    }

    public struct BgTaskExited: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let exitCode: Int?
        public let killed: Bool
    }

    public struct Checkpoint: Codable, Equatable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let summary: String
        public let uptoSeq: Int
    }

    private enum Discriminator: String, Codable {
        case session_created
        case harness_attached
        case harness_detached
        case user_message
        case turn_started
        case assistant_message
        case tool_call
        case tool_result
        case approval_requested
        case approval_resolved
        case turn_completed
        case agent_error
        case directory_added
        case bg_task_started
        case bg_task_output
        case bg_task_exited
        case checkpoint
    }

    private enum TypeKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TypeKey.self)
        switch try c.decode(Discriminator.self, forKey: .type) {
        case .session_created:      self = .sessionCreated(try SessionCreated(from: decoder))
        case .harness_attached:     self = .harnessAttached(try HarnessAttached(from: decoder))
        case .harness_detached:     self = .harnessDetached(try HarnessDetached(from: decoder))
        case .user_message:         self = .userMessage(try UserMessage(from: decoder))
        case .turn_started:         self = .turnStarted(try TurnStarted(from: decoder))
        case .assistant_message:    self = .assistantMessage(try AssistantMessage(from: decoder))
        case .tool_call:            self = .toolCall(try ToolCall(from: decoder))
        case .tool_result:          self = .toolResult(try ToolResult(from: decoder))
        case .approval_requested:   self = .approvalRequested(try ApprovalRequested(from: decoder))
        case .approval_resolved:    self = .approvalResolved(try ApprovalResolved(from: decoder))
        case .turn_completed:       self = .turnCompleted(try TurnCompleted(from: decoder))
        case .agent_error:          self = .agentError(try AgentError(from: decoder))
        case .directory_added:      self = .directoryAdded(try DirectoryAdded(from: decoder))
        case .bg_task_started:      self = .bgTaskStarted(try BgTaskStarted(from: decoder))
        case .bg_task_output:       self = .bgTaskOutput(try BgTaskOutput(from: decoder))
        case .bg_task_exited:       self = .bgTaskExited(try BgTaskExited(from: decoder))
        case .checkpoint:           self = .checkpoint(try Checkpoint(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .sessionCreated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.session_created.rawValue, forKey: .type)
        case .harnessAttached(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.harness_attached.rawValue, forKey: .type)
        case .harnessDetached(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.harness_detached.rawValue, forKey: .type)
        case .userMessage(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.user_message.rawValue, forKey: .type)
        case .turnStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.turn_started.rawValue, forKey: .type)
        case .assistantMessage(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.assistant_message.rawValue, forKey: .type)
        case .toolCall(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.tool_call.rawValue, forKey: .type)
        case .toolResult(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.tool_result.rawValue, forKey: .type)
        case .approvalRequested(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.approval_requested.rawValue, forKey: .type)
        case .approvalResolved(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.approval_resolved.rawValue, forKey: .type)
        case .turnCompleted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.turn_completed.rawValue, forKey: .type)
        case .agentError(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.agent_error.rawValue, forKey: .type)
        case .directoryAdded(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.directory_added.rawValue, forKey: .type)
        case .bgTaskStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.bg_task_started.rawValue, forKey: .type)
        case .bgTaskOutput(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.bg_task_output.rawValue, forKey: .type)
        case .bgTaskExited(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.bg_task_exited.rawValue, forKey: .type)
        case .checkpoint(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.checkpoint.rawValue, forKey: .type)
        }
    }
}
