import Foundation

public enum SessionEvent: Codable, Equatable, Sendable {
    case sessionCreated(SessionCreated)
    case harnessAttached(HarnessAttached)
    case harnessDetached(HarnessDetached)
    case userMessage(UserMessage)
    case turnStarted(TurnStarted)
    case assistantMessage(AssistantMessage)
    case assistantDelta(AssistantDelta)
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
    case questionAsked(QuestionAsked)
    case questionResolved(QuestionResolved)
    case taskUpdated(TaskUpdated)
    case planPresented(PlanPresented)
    case planResolved(PlanResolved)
    case worktreeEntered(WorktreeEntered)
    case worktreeExited(WorktreeExited)
    case threadStarted(ThreadStarted)
    case threadCompleted(ThreadCompleted)
    case sessionTitled(SessionTitled)
    case leaseGranted(LeaseGranted)
    case leaseLost(LeaseLost)
    case peripheralCallRequested(PeripheralCallRequested)

    public struct SessionCreated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let scope: String
    }

    public struct HarnessAttached: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let clientName: String
    }

    public struct HarnessDetached: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let clientName: String
    }

    public struct UserMessage: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let text: String
        public let clientName: String
    }

    public struct TurnStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
    }

    public struct AssistantMessage: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let text: String
    }

    /// TRANSIENT streaming chunk — broadcast-only, never persisted/replayed; seq is the store's
    /// lastSeq at broadcast time. Exempt from seq-based dedupe and lastSeq tracking (see NormaKit).
    public struct AssistantDelta: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let delta: String
    }

    public struct ToolCall: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let name: String
        public let argsJson: String
    }

    public struct ToolResult: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let output: String
        public let isError: Bool
    }

    public struct ApprovalRequested: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let toolName: String
        public let summary: String
    }

    public struct ApprovalResolved: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let approved: Bool
        public let by: String
    }

    public struct TurnCompleted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let stopReason: String
        public let inputTokens: Int
        public let outputTokens: Int
    }

    public struct AgentError: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let message: String
    }

    public struct DirectoryAdded: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let path: String
        public let persisted: Bool
    }

    public struct BgTaskStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let command: String
    }

    public struct BgTaskOutput: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let chunk: String
    }

    public struct BgTaskExited: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let exitCode: Int?
        public let killed: Bool
    }

    public struct Checkpoint: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let summary: String
        public let uptoSeq: Int
    }

    public struct QuestionOption: Codable, Equatable, Sendable {
        public let label: String
        public let description: String?
    }

    public struct Question: Codable, Equatable, Sendable {
        public let question: String
        public let header: String
        public let options: [QuestionOption]
        public let multiSelect: Bool
    }

    public struct Task: Codable, Equatable, Sendable {
        public let id: String
        public let subject: String
        public let status: String
        public let activeForm: String?
    }

    public struct QuestionAsked: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let questions: [Question]
    }

    public struct QuestionResolved: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let answers: [String: String]
        public let by: String
    }

    public struct TaskUpdated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let task: Task
    }

    public struct PlanPresented: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let plan: String
    }

    public struct PlanResolved: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let approved: Bool
        public let feedback: String?
        public let autoAccept: Bool
        public let by: String
    }

    public struct WorktreeEntered: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let name: String
        public let path: String
        public let branch: String
    }

    public struct WorktreeExited: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let name: String
        public let action: String
        public let removed: Bool
    }

    public struct ThreadStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let parentThreadId: String
        public let agentType: String
        public let prompt: String
        public let description: String?
    }

    public struct ThreadCompleted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let stopReason: String
    }

    public struct SessionTitled: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let title: String
    }

    /// `{kind: "session"|"plugin", id}` — identifies the holder of a peripheral lease.
    public struct Holder: Codable, Equatable, Sendable {
        public let kind: String
        public let id: String
    }

    /// TRANSIENT (broadcast-only, like `assistant_delta`) — leases are runtime state; replay
    /// must never resurrect one. The audit log is the durable record.
    ///
    /// `tokenHash` (sha256 hex of the raw token) lets the PROVIDER validate token+class+expiry
    /// on every `peripheral_call_requested` (spec §A1: "no token, no service") — see
    /// `PeripheralProvider.shouldServe` in the app target. The raw token itself never rides this
    /// event.
    public struct LeaseGranted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let leaseId: String
        public let `class`: String
        public let holder: Holder
        public let expiresAt: Int
        public let tokenHash: String
    }

    /// TRANSIENT — see LeaseGranted.
    public struct LeaseLost: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let leaseId: String
        public let `class`: String
        public let holder: Holder
        public let reason: String
    }

    /// TRANSIENT — core pushes this to the provider's connection (approval-broker request/
    /// response pattern); the provider answers via `peripheral.respond`.
    public struct PeripheralCallRequested: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let requestId: String
        public let leaseId: String
        public let token: String
        public let `class`: String
        public let payloadJson: String
    }

    private enum Discriminator: String, Codable {
        case session_created
        case harness_attached
        case harness_detached
        case user_message
        case turn_started
        case assistant_message
        case assistant_delta
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
        case question_asked
        case question_resolved
        case task_updated
        case plan_presented
        case plan_resolved
        case worktree_entered
        case worktree_exited
        case thread_started
        case thread_completed
        case session_titled
        case lease_granted
        case lease_lost
        case peripheral_call_requested
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
        case .assistant_delta:      self = .assistantDelta(try AssistantDelta(from: decoder))
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
        case .question_asked:       self = .questionAsked(try QuestionAsked(from: decoder))
        case .question_resolved:    self = .questionResolved(try QuestionResolved(from: decoder))
        case .task_updated:         self = .taskUpdated(try TaskUpdated(from: decoder))
        case .plan_presented:       self = .planPresented(try PlanPresented(from: decoder))
        case .plan_resolved:        self = .planResolved(try PlanResolved(from: decoder))
        case .worktree_entered:     self = .worktreeEntered(try WorktreeEntered(from: decoder))
        case .worktree_exited:      self = .worktreeExited(try WorktreeExited(from: decoder))
        case .thread_started:       self = .threadStarted(try ThreadStarted(from: decoder))
        case .thread_completed:     self = .threadCompleted(try ThreadCompleted(from: decoder))
        case .session_titled:       self = .sessionTitled(try SessionTitled(from: decoder))
        case .lease_granted:        self = .leaseGranted(try LeaseGranted(from: decoder))
        case .lease_lost:           self = .leaseLost(try LeaseLost(from: decoder))
        case .peripheral_call_requested: self = .peripheralCallRequested(try PeripheralCallRequested(from: decoder))
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
        case .assistantDelta(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.assistant_delta.rawValue, forKey: .type)
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
        case .questionAsked(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.question_asked.rawValue, forKey: .type)
        case .questionResolved(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.question_resolved.rawValue, forKey: .type)
        case .taskUpdated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.task_updated.rawValue, forKey: .type)
        case .planPresented(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.plan_presented.rawValue, forKey: .type)
        case .planResolved(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.plan_resolved.rawValue, forKey: .type)
        case .worktreeEntered(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.worktree_entered.rawValue, forKey: .type)
        case .worktreeExited(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.worktree_exited.rawValue, forKey: .type)
        case .threadStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.thread_started.rawValue, forKey: .type)
        case .threadCompleted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.thread_completed.rawValue, forKey: .type)
        case .sessionTitled(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.session_titled.rawValue, forKey: .type)
        case .leaseGranted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.lease_granted.rawValue, forKey: .type)
        case .leaseLost(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.lease_lost.rawValue, forKey: .type)
        case .peripheralCallRequested(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.peripheral_call_requested.rawValue, forKey: .type)
        }
    }
}
