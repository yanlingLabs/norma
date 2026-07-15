import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ModelInfo, ProviderEvent } from "../../src/providers/types";
import { makePng } from "./read-fixtures";

// multimodal-read T1 (engine e2e): the whole point of generalizing ctx.attachImage past
// computer-use is that the `read` tool can stage a vision image with NO computer-use service
// configured at all. This mirrors engine-computer.test.ts's "a screenshot tool_call stages an
// image into the NEXT round's provider input" test byte-for-byte, but drives it through `read`
// on a real image fixture instead of the `computer` tool's screenshot action — and, critically,
// EngineConfig never sets `computerUse` here (not even to a getter returning undefined-by-default
// service — the key is simply absent), so this is a clean proof the bridge no longer needs CU.
function setup(script: ProviderEvent[][], vision: boolean, cwd: string) {
  const home = mkdtempSync(join(tmpdir(), "norma-read-img-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  const approval = new ApprovalBroker();
  const models: ModelInfo[] = [{ id: "m", family: "fake", contextWindow: 100_000, supportsVision: vision }];
  const provider = new FakeProvider(script, models);
  const dirs = new SessionDirectories(() => [cwd]);
  const aHome = mkdtempSync(join(tmpdir(), "norma-read-img-actx-"));
  const aTrust = new TrustStore(join(aHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: aHome, trust: aTrust, skills: new SkillStore({ normaHome: aHome, trust: aTrust }) });
  const compactor = new Compactor({ provider: { provider, model: "m" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker: approval,
    gate: new PermissionGate(),
    provider: { provider, model: "m" },
    dirs, assembler, compactor,
    // NO `computerUse` key at all — cfg.computerUse?.() resolves undefined for every call. This
    // session never had, and will never have, a computer-use service.
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, sessionId, provider };
}

const usage: ProviderEvent = { type: "usage", inputTokens: 5, outputTokens: 1 };
function readRound(path: string): ProviderEvent[] {
  return [{ type: "tool_call", callId: "c1", name: "read", argsJson: JSON.stringify({ path }) }, usage, { type: "done", stopReason: "tool_calls" }];
}
function endRound(): ProviderEvent[] {
  return [{ type: "text_delta", delta: "done" }, usage, { type: "done", stopReason: "end_turn" }];
}

describe("engine read-image bridge (multimodal-read T1) — no computer-use service involved", () => {
  test("a `read` tool_call on an image file stages it into the NEXT round's provider input, with no CU service configured", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-read-img-cwd-")));
    const png = makePng(3, 3);
    writeFileSync(join(cwd, "photo.png"), png);
    const { engine, store, sessionId, provider } = setup([readRound("photo.png"), endRound()], true, cwd);

    await engine.runTurn(sessionId);

    expect(provider.requests.length).toBe(2);
    const round2Input = provider.requests[1]!.input;
    const imageItem = round2Input.find((i) => i.type === "image");
    expect(imageItem).toBeDefined();
    expect((imageItem as { imageUrl: string }).imageUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);

    // The image comes AFTER the tool_result (batch intact, image trailing as a user turn) — same
    // ordering guarantee drainRoundImages gives the `computer` tool's screenshots.
    const trIdx = round2Input.findIndex((i) => i.type === "tool_result");
    const imgIdx = round2Input.findIndex((i) => i.type === "image");
    expect(trIdx).toBeGreaterThanOrEqual(0);
    expect(imgIdx).toBeGreaterThan(trIdx);

    // The persisted tool_result is the short TEXT note — the image bytes never land in the log
    // (MAX_OUTPUT bypass intact: the note is a few dozen bytes, the image rides ctx.attachImage).
    const toolResult = store.read(sessionId).find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: false });
    expect((toolResult as any).output).toContain("3×3");
    expect((toolResult as any).output).toContain("The image follows this result as the next message.");
    expect((toolResult as any).output).not.toContain("base64");
  });

  test("a non-vision model refuses the image read — never staged, next round carries no image", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-read-img-cwd2-")));
    writeFileSync(join(cwd, "photo.png"), makePng(3, 3));
    const { engine, store, sessionId, provider } = setup([readRound("photo.png"), endRound()], false, cwd);

    await engine.runTurn(sessionId);

    const toolResult = store.read(sessionId).find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as any).output).toContain("cannot view images");
    expect(provider.requests[1]!.input.some((i) => i.type === "image")).toBe(false);
  });
});
