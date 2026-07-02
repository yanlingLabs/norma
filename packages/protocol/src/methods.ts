import { z } from "zod";
import { SessionEvent } from "./events";

export const PROTOCOL_VERSION = 0;

export const Role = z.enum(["harness", "plugin", "admin"]);
export type Role = z.infer<typeof Role>;

export const ApprovalPolicy = z.enum(["ask", "auto"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const HelloParams = z.object({
  protocolVersion: z.number().int(),
  role: Role,
  token: z.string().min(1),
  clientName: z.string().min(1),
});
export const HelloResult = z.object({
  ok: z.literal(true),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
});

export const SessionCreateParams = z.object({
  scope: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/), // slug: no leading/trailing hyphen, ≤41 chars
  cwd: z.string().startsWith("/").optional(),        // absolute path; session working directory for tools
  approvalPolicy: ApprovalPolicy.default("ask"),
});
export const SessionCreateResult = z.object({ sessionId: z.string() });

export const SessionListResult = z.object({
  sessions: z.array(z.object({
    sessionId: z.string(),
    scope: z.string(),
    createdAt: z.number().int(),
    lastSeq: z.number().int().nonnegative(),
  })),
});

export const SessionAttachParams = z.object({
  sessionId: z.string(),
  fromSeq: z.number().int().nonnegative().optional().default(0),
});
export const SessionAttachResult = z.object({ ok: z.literal(true), lastSeq: z.number().int().nonnegative() });

export const SessionSendParams = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
});
export const SessionSendResult = z.object({ seq: z.number().int() });

export const ApprovalRespondParams = z.object({
  sessionId: z.string(),
  callId: z.string().min(1),
  approved: z.boolean(),
});
export const ApprovalRespondResult = z.object({ ok: z.literal(true), alreadyResolved: z.boolean() });

export const SessionAddDirParams = z.object({
  sessionId: z.string(),
  path: z.string().min(1),
  persist: z.boolean().default(false),
});
export const SessionAddDirResult = z.object({ ok: z.literal(true), roots: z.array(z.string()) });
export const SessionSetCwdParams = z.object({ sessionId: z.string(), cwd: z.string().startsWith("/") });
export const SessionSetCwdResult = z.object({ ok: z.literal(true), cwd: z.string() });

/** Server → client notification: method "event", params = SessionEvent. */
export const EventNotificationParams = SessionEvent;

export const METHODS = {
  hello: "protocol.hello",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionAttach: "session.attach",
  sessionSend: "session.send",
  approvalRespond: "approval.respond",
  sessionAddDir: "session.addDir",
  sessionSetCwd: "session.setCwd",
  event: "event",
} as const;
