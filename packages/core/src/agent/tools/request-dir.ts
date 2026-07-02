import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { ToolRegistry } from "./registry";
import type { ApprovalBroker } from "../approvals";
import type { SessionDirectories } from "../dirs";
import { addLocalDir } from "../../settings";
import type { NewSessionEvent } from "@norma/protocol";

export interface RequestDirDeps {
  broker: ApprovalBroker;
  dirs: SessionDirectories;
  emit: (sessionId: string, event: NewSessionEvent) => void;
  projectDir: (sessionId: string) => string | null;
  approvalTimeoutMs?: number;
}

export function registerRequestDirTool(r: ToolRegistry, deps: RequestDirDeps): void {
  r.register({
    name: "request_directory",
    description: "Ask the user to grant write access to a directory outside the current allowed roots. The user must approve; you cannot grant it yourself. Set persist:true to remember the grant for this project.",
    args: z.object({ path: z.string().min(1), persist: z.boolean().default(false) }),
    async run({ path, persist }, { sessionId }) {
      const callId = `dir_${randomBytes(6).toString("hex")}`;
      const waiting = deps.broker.wait(sessionId, callId, deps.approvalTimeoutMs ?? 5 * 60_000);
      deps.emit(sessionId, {
        type: "approval_requested", sessionId, threadId: "main", callId,
        toolName: "request_directory", summary: `grant write access to ${path}${persist ? " (remember)" : ""}`,
      });
      const res = await waiting;
      deps.emit(sessionId, { type: "approval_resolved", sessionId, threadId: "main", callId, approved: res.approved, by: res.by });
      if (!res.approved) throw new Error(`directory request denied by ${res.by}`);
      deps.dirs.add(sessionId, path);
      const project = deps.projectDir(sessionId);
      const persisted = persist && project !== null;
      if (persisted) addLocalDir(project!, path);
      deps.emit(sessionId, { type: "directory_added", sessionId, threadId: "main", path, persisted });
      return `granted write access to ${path}${persisted ? " (remembered)" : ""}`;
    },
  });
}
