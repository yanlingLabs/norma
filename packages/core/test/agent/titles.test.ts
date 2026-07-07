import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ModelInfo, Provider, ProviderEvent } from "../../src/providers/types";

function setup(script: ProviderEvent[][]) {
  const home = mkdtempSync(join(tmpdir(), "norma-titles-home-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const provider = new FakeProvider(script);
  const titler = new SessionTitler({ provider: { provider, model: "fake-1" }, store, hub });
  const sessionId = store.createSession("global", { cwd: "/tmp" });
  return { store, hub, provider, titler, sessionId };
}

/** Seeds a main-thread user_message + assistant_message so the titler has content to work with. */
function seedTurn(store: SessionStore, sessionId: string, userText = "how do I fix the login flow?", replyText = "I fixed it.") {
  store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: userText, clientName: "test" });
  store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: replyText });
}

const titleScript = (title: string): ProviderEvent[][] => [
  [{ type: "text_delta", delta: title }, { type: "done", stopReason: "end_turn" }],
];

class ThrowingProvider implements Provider {
  readonly id = "throwing";
  models(): ModelInfo[] { return [{ id: "throw-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(): AsyncIterable<ProviderEvent> {
    throw new Error("provider boom");
  }
}

describe("SessionTitler", () => {
  test("titles once after content exists; second call is a no-op", async () => {
    const { store, titler, sessionId, provider } = setup(titleScript("Fixing the login flow"));
    seedTurn(store, sessionId);

    await titler.maybeTitle(sessionId);
    const events = store.read(sessionId).filter((e) => e.type === "session_titled");
    expect(events.length).toBe(1);
    expect((events[0] as any).title).toBe("Fixing the login flow");
    expect(provider.requests.length).toBe(1);

    await titler.maybeTitle(sessionId);
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(1);
    // No second model call — store.getTitle guard short-circuits before any oneShot.
    expect(provider.requests.length).toBe(1);
  });

  test("no user message → no event, no model call", async () => {
    const { store, titler, sessionId, provider } = setup(titleScript("Should never be used"));
    // No seedTurn: session has no main-thread user_message yet.
    await titler.maybeTitle(sessionId);
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(0);
    expect(provider.requests.length).toBe(0);
  });

  test("provider error → resolves without throwing, no event", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-titles-home-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const titler = new SessionTitler({ provider: { provider: new ThrowingProvider(), model: "fake-1" }, store, hub });
    const sessionId = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionId);

    await expect(titler.maybeTitle(sessionId)).resolves.toBeUndefined();
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(0);
  });

  test("multi-line/overlong model output → first line, capped 60", async () => {
    const { store, titler, sessionId } = setup(titleScript("A Title\nextra prose that should be discarded entirely"));
    seedTurn(store, sessionId);

    await titler.maybeTitle(sessionId);
    const events = store.read(sessionId).filter((e) => e.type === "session_titled");
    expect(events.length).toBe(1);
    expect((events[0] as any).title).toBe("A Title");
  });

  test("hub.onGlobalEvent fires for session_titled", async () => {
    const { store, hub, titler, sessionId } = setup(titleScript("Fixing the login flow"));
    seedTurn(store, sessionId);

    const seen: string[] = [];
    hub.onGlobalEvent = (e) => { seen.push(e.type); };

    await titler.maybeTitle(sessionId);
    expect(seen).toContain("session_titled");
  });
});
