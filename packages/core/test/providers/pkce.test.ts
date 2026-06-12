import { afterEach, describe, expect, test } from "bun:test";
import { generatePkce, runLoginFlow, refreshTokens, decodeAccountId } from "../../src/providers/pkce";

let authServer: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { authServer?.stop(true); authServer = null; });

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

describe("pkce", () => {
  test("verifier/challenge are well-formed (S256)", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    expect(challenge).toBe(expected);
  });

  test("full login flow: authorize redirect → callback → token exchange", async () => {
    let tokenBody: URLSearchParams | null = null;
    const idToken = `x.${b64url(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_42" } }))}.y`;
    authServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          tokenBody = new URLSearchParams(await req.text());
          return Response.json({ access_token: "at_1", refresh_token: "rt_1", id_token: idToken, expires_in: 3600 });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const flow = runLoginFlow({
      clientId: "app_test",
      authorizeUrl: `http://localhost:${authServer.port}/oauth/authorize`,
      tokenUrl: `http://localhost:${authServer.port}/oauth/token`,
      callbackPort: 0, // ephemeral for tests
      scope: "openid profile email offline_access",
      openBrowser: async (url) => {
        // simulate the user completing auth: hit our callback with code+state from the URL
        const u = new URL(url);
        const state = u.searchParams.get("state")!;
        const redirect = u.searchParams.get("redirect_uri")!;
        await fetch(`${redirect}?code=authcode_1&state=${state}`);
      },
    });
    const tokens = await flow;
    expect(tokens).toMatchObject({ accessToken: "at_1", refreshToken: "rt_1", accountId: "acct_42" });
    expect(tokenBody!.get("grant_type")).toBe("authorization_code");
    expect(tokenBody!.get("code")).toBe("authcode_1");
    expect(tokenBody!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  test("state mismatch is rejected", async () => {
    const flow = runLoginFlow({
      clientId: "app_test",
      authorizeUrl: "http://localhost:1/oauth/authorize", // never fetched by the flow itself
      tokenUrl: "http://localhost:1/oauth/token",
      callbackPort: 0,
      scope: "openid",
      timeoutMs: 1000,
      openBrowser: async (url) => {
        const u = new URL(url);
        const redirect = u.searchParams.get("redirect_uri")!;
        await fetch(`${redirect}?code=evil&state=WRONG`).catch(() => {});
      },
    });
    await expect(flow).rejects.toThrow(/state/);
  });

  test("refreshTokens posts a refresh_token grant", async () => {
    let body: URLSearchParams | null = null;
    authServer = Bun.serve({
      port: 0,
      async fetch(req) {
        body = new URLSearchParams(await req.text());
        return Response.json({ access_token: "at_2", refresh_token: "rt_2", expires_in: 3600 });
      },
    });
    const t = await refreshTokens(`http://localhost:${authServer.port}/oauth/token`, "app_test", "rt_1");
    expect(t.accessToken).toBe("at_2");
    expect(body!.get("grant_type")).toBe("refresh_token");
    expect(body!.get("refresh_token")).toBe("rt_1");
  });

  test("decodeAccountId extracts the chatgpt account claim", () => {
    const idToken = `h.${b64url(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } }))}.s`;
    expect(decodeAccountId(idToken)).toBe("acct_9");
    expect(decodeAccountId("not.a.jwt")).toBeNull();
  });

  test("token exchange 400 error includes response body", async () => {
    authServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response(`{"error":"invalid_grant"}`, { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    await expect(
      refreshTokens(`http://localhost:${authServer.port}/oauth/token`, "app_test", "bad_rt")
    ).rejects.toThrow(/invalid_grant/);
  });

  test("timeout rejects flow and stops server", async () => {
    const flow = runLoginFlow({
      clientId: "x", authorizeUrl: "http://localhost:1/auth",
      tokenUrl: "http://localhost:1/token",
      callbackPort: 0, scope: "openid",
      timeoutMs: 50,
      openBrowser: async () => { await new Promise((r) => setTimeout(r, 5_000)); },
    });
    await expect(flow).rejects.toThrow(/timed out/);
  });
});
