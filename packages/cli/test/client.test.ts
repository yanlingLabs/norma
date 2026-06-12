import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
    const sessionId = await client.createSession("global");
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
});
