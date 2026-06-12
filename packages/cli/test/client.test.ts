import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, FileSecretStore, type RunningDaemon } from "@norma/core";
import { NormaClient } from "../src/client";

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
