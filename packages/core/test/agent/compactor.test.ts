import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { Compactor } from "../../src/agent/compactor";
import { FakeProvider } from "../../src/agent/fake-provider";

function seedSession(n: number) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-cmp-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const sid = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto" });
  for (let i = 0; i < n; i++) {
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `u${i}`, clientName: "test" });
    store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: `a${i}` });
  }
  return { store, hub, sid };
}

// A FakeProvider that emits a fixed summary as one text_delta then done(end_turn).
function summarizer(summary: string) {
  return new FakeProvider([[{ type: "text_delta", delta: summary }, { type: "done", stopReason: "end_turn" }]]);
}

describe("Compactor", () => {
  test("summarizes older turns, keeps the tail, appends a checkpoint", async () => {
    const { store, hub, sid } = seedSession(10); // 20 messages
    const c = new Compactor({ provider: { provider: summarizer("SUMMARY_TOKEN"), model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(true);
    const cp = store.read(sid).find((e) => e.type === "checkpoint");
    expect(cp && (cp as any).summary).toBe("SUMMARY_TOKEN");
    // uptoSeq must be the seq of the last message BEFORE the kept tail (6 messages kept)
    const msgs = store.read(sid).filter((e) => e.type === "user_message" || e.type === "assistant_message");
    const tailStartSeq = msgs[msgs.length - 6]!.seq;
    expect((cp as any).uptoSeq).toBe(tailStartSeq - 1);
    expect(res.summaryChars).toBe("SUMMARY_TOKEN".length);
  });

  test("too few messages -> not compacted", async () => {
    const { store, hub, sid } = seedSession(2); // 4 messages, <= keepTail
    const c = new Compactor({ provider: { provider: summarizer("X"), model: "fake" }, store, hub, keepTail: 6 });
    expect((await c.compact(sid)).compacted).toBe(false);
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });

  test("an already-checkpointed session folds the prior summary into the next", async () => {
    const { store, hub, sid } = seedSession(10);
    const c1 = new Compactor({ provider: { provider: summarizer("FIRST"), model: "fake" }, store, hub, keepTail: 6 });
    await c1.compact(sid);
    for (let i = 0; i < 6; i++) {
      store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `nu${i}`, clientName: "test" });
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: `na${i}` });
    }
    // capture what the model is asked to summarize: a provider that records its input
    const rec: any = summarizer("SECOND");
    const orig = rec.streamTurn.bind(rec);
    const inputs: any[] = [];
    rec.streamTurn = (req: any) => { inputs.push(req.input); return orig(req); };
    const c2 = new Compactor({ provider: { provider: rec, model: "fake" }, store, hub, keepTail: 6 });
    await c2.compact(sid);
    expect(JSON.stringify(inputs[0])).toContain("FIRST"); // the prior summary was folded into the older set
  });

  test("honors the abort signal (interrupt cancels a running compaction)", async () => {
    const { store, hub, sid } = seedSession(10);
    // a provider whose streamTurn blocks until signal aborts (reuse AbortAwaitProvider)
    const { AbortAwaitProvider } = await import("../../src/agent/test-providers");
    const c = new Compactor({ provider: { provider: new AbortAwaitProvider(), model: "fake" }, store, hub, keepTail: 6 });
    const ac = new AbortController();
    const p = c.compact(sid, ac.signal);
    ac.abort();
    const res = await p;
    expect(res.compacted).toBe(false); // aborted before a summary -> no checkpoint
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });

  test("rate-limited compaction QUEUES then runs (not dropped)", async () => {
    // Wrap the summarizer with the real withQuota + a QuotaManager marked limited-until soon.
    const { withQuota, QuotaManager } = await import("../../src/providers/quota");
    const { store, hub, sid } = seedSession(10);
    const q = new QuotaManager();
    q.noteRateLimit(120); // limited for 120ms from now — the real "mark limited" API
    const wrapped = withQuota(summarizer("QUEUED"), q);
    const c = new Compactor({ provider: { provider: wrapped, model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(true); // waited past the limit, then produced the checkpoint
    expect(store.read(sid).find((e) => e.type === "checkpoint")).toBeTruthy();
  });

  test("empty model summary → not compacted (no blank checkpoint)", async () => {
    const { store, hub, sid } = seedSession(10); // 20 messages
    // a provider that yields NO text_delta — just done(end_turn) → summary === ""
    const emptySummarizer = new FakeProvider([[{ type: "done", stopReason: "end_turn" }]]);
    const c = new Compactor({ provider: { provider: emptySummarizer, model: "fake" }, store, hub, keepTail: 6 });
    const res = await c.compact(sid);
    expect(res.compacted).toBe(false);
    expect(store.read(sid).some((e) => e.type === "checkpoint")).toBe(false);
  });
});
