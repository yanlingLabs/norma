import { z } from "zod";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
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
};
for (const [name, value] of Object.entries(fixtures)) {
  SessionEvent.parse(value); // fixtures must be valid by construction
  writeFileSync(join(fixDir, `${name}.json`), JSON.stringify(value, null, 2));
}

// 3. Sync fixtures into the Swift test bundle.
const swiftFixDir = join(import.meta.dir, "..", "..", "..", "apple", "NormaProtocol", "Tests", "NormaProtocolTests", "Fixtures");
mkdirSync(swiftFixDir, { recursive: true });
cpSync(fixDir, swiftFixDir, { recursive: true });
console.log(`generated: schema + ${Object.keys(fixtures).length} fixtures (synced to Swift test bundle)`);
