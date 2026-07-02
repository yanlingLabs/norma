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
