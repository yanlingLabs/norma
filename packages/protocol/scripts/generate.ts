import { z } from "zod";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionEvent } from "../src/events";

const outDir = join(import.meta.dir, "..", "generated");
const fixDir = join(outDir, "fixtures");
mkdirSync(fixDir, { recursive: true });

// 1. JSON Schema (for quicktype / external consumers)
const schema = z.toJSONSchema(SessionEvent);
writeFileSync(join(outDir, "session-event.schema.json"), JSON.stringify(schema, null, 2));

// 2. Canonical fixtures — one per variant; Swift must decode + re-encode all of them.
const base = { seq: 7, sessionId: "s_fixture", ts: 1781270000000 };
const fixtures: Record<string, unknown> = {
  "session_created": { ...base, type: "session_created", scope: "global" },
  "harness_attached": { ...base, type: "harness_attached", clientName: "orb" },
  "harness_detached": { ...base, type: "harness_detached", clientName: "orb" },
  "user_message": { ...base, type: "user_message", threadId: "main", text: "héllo \"world\" — done ✓", clientName: "cli-1" },
  "turn_started": { ...base, threadId: "main", type: "turn_started" },
  "assistant_message": { ...base, threadId: "main", type: "assistant_message", text: "done ✓" },
  "tool_call": { ...base, threadId: "main", type: "tool_call", callId: "call_1", name: "read", argsJson: '{"path":"a.txt"}' },
  "tool_result": { ...base, threadId: "main", type: "tool_result", callId: "call_1", output: "line1\nline2", isError: false },
  "approval_requested": { ...base, threadId: "main", type: "approval_requested", callId: "call_2", toolName: "write", summary: "write a.txt" },
  "approval_resolved": { ...base, threadId: "main", type: "approval_resolved", callId: "call_2", approved: true, by: "orb" },
  "turn_completed": { ...base, threadId: "main", type: "turn_completed", stopReason: "end_turn", inputTokens: 12, outputTokens: 3 },
  "agent_error": { ...base, threadId: "main", type: "agent_error", message: "provider unavailable" },
  "directory_added": { ...base, threadId: "main", type: "directory_added", path: "/opt/data", persisted: true },
  "bg_task_started": { ...base, threadId: "main", type: "bg_task_started", taskId: "bg_a1", command: "npm run dev" },
  "bg_task_output":  { ...base, threadId: "main", type: "bg_task_output",  taskId: "bg_a1", chunk: "listening on :3000\n" },
  "bg_task_exited":  { ...base, threadId: "main", type: "bg_task_exited",  taskId: "bg_a1", exitCode: 0, killed: false },
};
for (const [name, value] of Object.entries(fixtures)) {
  SessionEvent.parse(value); // fixtures must be valid by construction
  writeFileSync(join(fixDir, `${name}.json`), JSON.stringify(value, null, 2));
}

// 3. Sync fixtures into the Swift test bundle.
const swiftFixDir = join(import.meta.dir, "..", "..", "..", "apple", "NormaProtocol", "Tests", "NormaProtocolTests", "Fixtures");
rmSync(swiftFixDir, { recursive: true, force: true }); // delete-then-copy: no orphaned fixtures after variant renames
mkdirSync(swiftFixDir, { recursive: true });
cpSync(fixDir, swiftFixDir, { recursive: true });
console.log(`generated: schema + ${Object.keys(fixtures).length} fixtures (synced to Swift test bundle)`);
