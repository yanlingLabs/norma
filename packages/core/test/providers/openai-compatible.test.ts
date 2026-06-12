import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function serveSse(file: string, opts: { status?: number; headers?: Record<string, string>; capture?: (body: any) => void } = {}) {
  const sse = readFileSync(join(import.meta.dir, "fixtures", file), "utf8");
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/responses") return new Response("nope", { status: 404 });
      opts.capture?.(await req.json());
      if (opts.status && opts.status !== 200) return new Response("err", { status: opts.status, headers: opts.headers });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  return `http://localhost:${server.port}`;
}

async function collect(iter: AsyncIterable<any>) {
  const out = []; for await (const e of iter) out.push(e); return out;
}

describe("OpenAICompatibleProvider", () => {
  test("streams a text turn and shapes the request body correctly", async () => {
    let body: any;
    const base = serveSse("simple-text.sse", { capture: (b) => { body = b; } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk-test" });
    const events = await collect(p.streamTurn({
      model: "gpt-5.2",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [{ name: "bash", description: "run a command", parameters: { type: "object" } }],
    }));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.delta).join("")).toBe("Hello");
    expect(body.model).toBe("gpt-5.2");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("be brief");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools).toEqual([{ type: "function", name: "bash", description: "run a command", parameters: { type: "object" }, strict: false }]);
  });

  test("401 yields an auth error event", async () => {
    const base = serveSse("simple-text.sse", { status: 401 });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "bad" });
    const events = await collect(p.streamTurn({ model: "m", input: [] }));
    expect(events).toEqual([{ type: "error", code: "auth", message: expect.stringContaining("401") }]);
  });

  test("429 with Retry-After yields rate_limit with retryAfterMs", async () => {
    const base = serveSse("simple-text.sse", { status: 429, headers: { "retry-after": "3" } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk" });
    const events = await collect(p.streamTurn({ model: "m", input: [] }));
    expect(events[0]).toMatchObject({ type: "error", code: "rate_limit", retryAfterMs: 3000 });
  });

  test("tool_result input items map to function_call_output", async () => {
    let body: any;
    const base = serveSse("simple-text.sse", { capture: (b) => { body = b; } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk" });
    await collect(p.streamTurn({
      model: "m",
      input: [{ type: "tool_result", callId: "call_abc", output: "file1\nfile2" }],
    }));
    expect(body.input).toEqual([{ type: "function_call_output", call_id: "call_abc", output: "file1\nfile2" }]);
  });
});
