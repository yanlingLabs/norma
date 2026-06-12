import Foundation

public enum SessionEvent: Codable, Equatable {
    case sessionCreated(SessionCreated)
    case harnessAttached(HarnessAttached)
    case harnessDetached(HarnessDetached)
    case userMessage(UserMessage)

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

    private enum Discriminator: String, Codable {
        case session_created
        case harness_attached
        case harness_detached
        case user_message
    }

    private enum TypeKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TypeKey.self)
        switch try c.decode(Discriminator.self, forKey: .type) {
        case .session_created:  self = .sessionCreated(try SessionCreated(from: decoder))
        case .harness_attached: self = .harnessAttached(try HarnessAttached(from: decoder))
        case .harness_detached: self = .harnessDetached(try HarnessDetached(from: decoder))
        case .user_message:     self = .userMessage(try UserMessage(from: decoder))
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
        }
    }
}
