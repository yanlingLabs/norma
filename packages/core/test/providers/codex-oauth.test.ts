import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CodexAuthStore, CodexOAuthProvider } from "../../src/providers/codex-oauth";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function store(): FileSecretStore {
  return new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-codex-")));
}

async function seeded(access = "at_live"): Promise<CodexAuthStore> {
  const s = new CodexAuthStore(store());
  await s.save({ accessToken: access, refreshToken: "rt_live", idToken: null, accountId: "acct_7", expiresAt: Date.now() + 3600_000 });
  return s;
}

const sse = () => readFileSync(join(import.meta.dir, "fixtures", "simple-text.sse"), "utf8");

describe("CodexOAuthProvider", () => {
  test("sends parity headers, bearer token and account id; streams events", async () => {
    let headers: Record<string, string> = {};
    server = Bun.serve({
      port: 0,
      fetch(req) {
        headers = Object.fromEntries(req.headers.entries());
        return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const p = new CodexOAuthProvider({ authStore: await seeded(), backendUrl: `http://localhost:${server.port}` });
    const events = [];
    for await (const e of p.streamTurn({ model: "gpt-5.2-codex", input: [{ type: "message", role: "user", content: "hi" }] })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(headers["authorization"]).toBe("Bearer at_live");
    expect(headers["chatgpt-account-id"]).toBe("acct_7");
    expect(headers["openai-beta"]).toBe("responses=experimental");
    expect(headers["originator"]).toBe("codex_cli_rs");
  });

  test("401 triggers ONE refresh then retry; refreshed token persisted", async () => {
    let calls = 0;
    let sawRefresh = false;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          sawRefresh = true;
          return Response.json({ access_token: "at_fresh", refresh_token: "rt_fresh", expires_in: 3600 });
        }
        calls++;
        if (calls === 1) return new Response("expired", { status: 401 });
        return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const authStore = await seeded("at_stale");
    const p = new CodexOAuthProvider({
      authStore,
      backendUrl: `http://localhost:${server.port}`,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    });
    const events = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(sawRefresh).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((await authStore.load())?.accessToken).toBe("at_fresh");
  });

  test("401 twice yields an auth error (no refresh loop)", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/oauth/token") return Response.json({ access_token: "at_x", expires_in: 3600 });
        return new Response("nope", { status: 401 });
      },
    });
    const p = new CodexOAuthProvider({
      authStore: await seeded(),
      backendUrl: `http://localhost:${server.port}`,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    });
    const events = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(events).toEqual([{ type: "error", code: "auth", message: expect.stringContaining("401") }]);
  });

  test("no stored tokens yields auth error telling the user to log in", async () => {
    const p = new CodexOAuthProvider({ authStore: new CodexAuthStore(store()), backendUrl: "http://localhost:1" });
    const events = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(events).toEqual([{ type: "error", code: "auth", message: expect.stringContaining("norma login") }]);
  });
});
