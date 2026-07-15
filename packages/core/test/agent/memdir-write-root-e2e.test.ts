import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { memoryDirFor } from "../../src/agent/memory-dir";
import type { ProviderEvent } from "../../src/providers/types";

// T1 (file-based memory, design doc `2026-07-15-file-based-memory-design.md`): the write-root
// join, tested against the REAL daemon (not a hand-rolled SessionDirectories stub) — daemon.ts's
// `sessionDirs` baseDirs closure is internal, reachable only through a running session's tool
// calls, so a real `write` tool call into the computed MEMDIR is the only way to prove the fence
// actually admits it. Mirrors settings-hot-e2e.test.ts's TestClient/driveTurn/writeSettingsFile
// harness (duplicated per this directory's own "each *.test.ts carries its own copy" convention).

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method) {
              c.notifications.push(msg);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }

  completedTurns(): number {
    return this.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length;
  }

  toolResult(callId: string): any {
    return this.notifications.find((n) => n.method === METHODS.event && n.params.type === "tool_result" && n.params.callId === callId)?.params;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function driveTurn(c: TestClient, sessionId: string, text: string, timeoutMs = 5000): Promise<void> {
  const before = c.completedTurns();
  await c.request(METHODS.sessionSend, { sessionId, text });
  const deadline = Date.now() + timeoutMs;
  while (c.completedTurns() <= before) {
    if (Date.now() > deadline) throw new Error("timed out waiting for turn_completed");
    await sleep(10);
  }
}

function writeSettingsFile(home: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      titles: { enabled: false },
      toolSearch: { enabled: false },
      // Reviewer defaults ON under `auto` policy (engine.ts: `reviewerEnabled?.() !== false`) and
      // would consume an EXTRA call from the SAME FakeProvider for every `write` tool call this
      // suite scripts — disabled here so the scripted round count matches exactly, same precedent
      // as `titles`/`toolSearch` above being neutralized for an unrelated confound.
      reviewer: { enabled: false },
      ...overrides,
    }, null, 2) + "\n",
  );
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];

function writeCallScript(callId: string, path: string, content: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId, name: "write", argsJson: JSON.stringify({ path, content }) }, done("tool_calls")],
    text("done"),
  ];
}

describe("MEMDIR write-root join e2e (T1)", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(() => daemon?.stop());

  test("memory.enabled (default true): a write tool call to an absolute path under the project's MEMDIR succeeds and lands on disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-memdir-wr-"));
    writeSettingsFile(home); // memory absent -> default enabled
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwd = mkdtempSync(join(tmpdir(), "norma-memdir-wr-cwd-"));
    const memDir = memoryDirFor(cwd, { normaHome: home });
    const target = join(memDir, "coffee-pref.md");
    const fake = new FakeProvider(writeCallScript("w1", target, "---\nname: coffee-pref\ndescription: d\ntype: user\n---\nfact"));

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "memdir-wr");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    await driveTurn(c, created.sessionId, "save a fact");

    const result = c.toolResult("w1");
    expect(result?.isError).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("fact");
    c.close();
  });

  test("memory.enabled: false: the SAME absolute MEMDIR path is NOT writable — the write tool call fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-memdir-wr-off-"));
    writeSettingsFile(home, { memory: { enabled: false } });
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwd = mkdtempSync(join(tmpdir(), "norma-memdir-wr-off-cwd-"));
    const memDir = memoryDirFor(cwd, { normaHome: home });
    const target = join(memDir, "coffee-pref.md");
    const fake = new FakeProvider(writeCallScript("w1", target, "fact"));

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "memdir-wr-off");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    await driveTurn(c, created.sessionId, "save a fact");

    const result = c.toolResult("w1");
    expect(result?.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
    c.close();
  });

  test("hot toggle: flipping memory.enabled false -> true (no restart) makes the SAME write path start succeeding on the NEXT turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-memdir-wr-hot-"));
    writeSettingsFile(home, { memory: { enabled: false } });
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwd = mkdtempSync(join(tmpdir(), "norma-memdir-wr-hot-cwd-"));
    const memDir = memoryDirFor(cwd, { normaHome: home });
    const target = join(memDir, "coffee-pref.md");
    const fake = new FakeProvider([
      ...writeCallScript("w1", target, "fact v1"),
      ...writeCallScript("w2", target, "fact v2"),
      ...writeCallScript("w3", target, "fact v3"), // extra attempts in case the poll needs a retry
      ...writeCallScript("w4", target, "fact v4"),
    ]);

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const daemonRef = daemon; // captured once — never reassigned, proving no restart below
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "memdir-wr-hot");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    await driveTurn(c, created.sessionId, "attempt 1");
    expect(c.toolResult("w1")?.isError).toBe(true);
    expect(existsSync(target)).toBe(false);

    writeSettingsFile(home, { memory: { enabled: true } });

    let succeeded = false;
    const callIds = ["w2", "w3", "w4"];
    const deadline = Date.now() + 5000;
    let i = 0;
    while (Date.now() < deadline && i < callIds.length) {
      await driveTurn(c, created.sessionId, `attempt ${i + 2}`);
      if (c.toolResult(callIds[i]!)?.isError === false) { succeeded = true; break; }
      i++;
      await sleep(100);
    }
    expect(succeeded).toBe(true);
    expect(existsSync(target)).toBe(true);

    expect(daemon).toBe(daemonRef); // same running daemon throughout — no restart
    c.close();
  });
});
