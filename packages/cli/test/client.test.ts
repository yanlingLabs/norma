import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, FileSecretStore, type RunningDaemon } from "@norma/core";
import { NormaClient } from "../src/client";
import { encodeLine, METHODS, PROTOCOL_VERSION } from "@norma/protocol";

describe("NormaClient", () => {
  let daemon: RunningDaemon;
  afterEach(() => daemon?.stop());

  async function boot(): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), "norma-cli-"));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")) });
    return home;
  }

  test("connect + hello + create + attach + send + receive own event", async () => {
    await boot();
    const events: any[] = [];
    const client = await NormaClient.connect({
      socketPath: daemon.socketPath,
      token: daemon.tokens.harness,
      clientName: "cli-test",
      onEvent: (e) => events.push(e),
    });
    const { sessionId } = await client.createSession("global");
    await client.attach(sessionId);
    await client.send(sessionId, "ping");
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === "user_message" && e.text === "ping")).toBe(true);
    client.close();
  });

  test("bad token raises a clear error", async () => {
    await boot();
    await expect(NormaClient.connect({
      socketPath: daemon.socketPath, token: "wrong", clientName: "x", onEvent: () => {},
    })).rejects.toThrow(/invalid token/);
  });

  test("client can add a directory and receive directory_added", async () => {
    await boot();
    const events: any[] = [];
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cli", onEvent: (e) => events.push(e) });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-cli-cwd-")) });
    await client.attach(sessionId);
    const extra = mkdtempSync(join(tmpdir(), "norma-cli-extra-"));
    const roots = await client.addDir(sessionId, extra);
    expect(roots).toContain(realpathSync(extra));
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === "directory_added")).toBe(true);
    client.close();
  });

  test("createSession returns trusted; trustDir makes a later create trusted", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "t", onEvent: () => {} });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cli-trust-")));
    const first = await client.createSession("global", { cwd });
    expect(first.trusted).toBe(false);
    expect(await client.trustDir(cwd)).toBe(true);
    const second = await client.createSession("global", { cwd });
    expect(second.trusted).toBe(true);
    client.close();
  });

  test("bg client methods round-trip", async () => {
    if (process.platform !== "darwin") { return; }
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "bg", onEvent: () => {} });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-cli-bg-")), approvalPolicy: "auto" });
    // no tasks yet:
    expect((await client.bgList(sessionId)).length).toBe(0);
    expect((await client.bgKillAll(sessionId)).killed).toBe(0);
    client.close();
  });

  test("steer/interrupt client methods round-trip", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "si", onEvent: () => {} });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-si-")), approvalPolicy: "auto" });
    // idle interrupt → wasRunning:false
    expect((await client.interrupt(sessionId)).wasRunning).toBe(false);
    // steer with no running turn → injected:false (starts a turn)
    expect((await client.steer(sessionId, "hi")).injected).toBe(false);
    client.close();
  });

  test("compact client method round-trip (no engine → nothing to compact)", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cc", onEvent: () => {} });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-cc-")), approvalPolicy: "auto" });
    expect(await client.compact(sessionId)).toEqual({ compacted: false, uptoSeq: 0, summaryChars: 0 });
    client.close();
  });

  test("listSkills client method round-trip (no skills installed)", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "sk", onEvent: () => {} });
    expect(await client.listSkills(process.cwd())).toEqual([]);
    client.close();
  });

  test("pluginsList client method round-trip (no plugins installed)", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "pl", onEvent: () => {} });
    expect(await client.pluginsList()).toEqual({ ok: true, plugins: [] });
    client.close();
  });

  test("init prompt reaches the session (canned NORMA.md-generation prompt)", async () => {
    const { INIT_PROMPT } = await import("../src/main");
    expect(INIT_PROMPT).toMatch(/NORMA\.md/i);
    await boot();
    const events: any[] = [];
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "init", onEvent: (e) => events.push(e) });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-init-")), approvalPolicy: "auto" });
    await client.attach(sessionId);
    await client.send(sessionId, INIT_PROMPT);
    await new Promise((r) => setTimeout(r, 40));
    expect(events.some((e) => e.type === "user_message" && e.text === INIT_PROMPT)).toBe(true);
    client.close();
  });

  test("resume continues an existing session (no new session)", async () => {
    await boot();
    const c1 = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "a", onEvent: () => {} });
    const { sessionId } = await c1.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "r-")), approvalPolicy: "auto" });
    await c1.attach(sessionId); await c1.send(sessionId, "first"); c1.close();
    const seen: any[] = [];
    const c2 = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "b", onEvent: (e) => seen.push(e) });
    const tip = (await c2.listSessions()).sessions.find((r: any) => r.sessionId === sessionId)!.lastSeq;
    await c2.attach(sessionId, tip); await c2.send(sessionId, "second");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((e) => e.type === "user_message" && e.text === "second")).toBe(true);
    // attach-from-tip (not 0): the historical "first" message must NOT be replayed to the resuming client
    expect(seen.some((e) => e.type === "user_message" && e.text === "first")).toBe(false);
    c2.close();
  });
});

describe("NormaClient against a hostile/fake server", () => {
  test("skips unknown future event types and times out hung requests", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "norma-fake-")), "fake.sock");
    Bun.listen({
      unix: sock,
      socket: {
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.hello) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION } }));
              // immediately push an unknown future event, then a known one:
              s.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: { type: "quantum_flux", seq: 1, sessionId: "s_x", ts: 1 } }));
              s.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: { type: "session_created", seq: 1, sessionId: "s_x", ts: 1, scope: "global" } }));
            }
            // all other requests: never answer (hang)
          }
        },
      },
    });
    const events: any[] = [];
    const client = await NormaClient.connect({
      socketPath: sock, token: "t", clientName: "fc", timeoutMs: 200, onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1); // future event skipped, known one delivered
    expect(events[0].type).toBe("session_created");
    await expect(client.request(METHODS.sessionList)).rejects.toThrow(/timed out/);
    client.close();
  });

  test("client rejects a malformed result for a validated method", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "norma-fake2-")), "fake.sock");
    Bun.listen({
      unix: sock,
      socket: {
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.hello) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION } }));
            } else if (msg.method === METHODS.sessionCreate) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { sessionned: 42 } })); // wrong shape
            }
          }
        },
      },
    });
    const client = await NormaClient.connect({ socketPath: sock, token: "t", clientName: "v", timeoutMs: 500, onEvent: () => {} });
    await expect(client.createSession("global")).rejects.toThrow(/invalid result/);
    client.close();
  });
});
