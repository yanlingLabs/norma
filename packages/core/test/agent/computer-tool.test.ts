import { describe, expect, test } from "bun:test";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerComputerTool } from "../../src/agent/tools/computer";
import type { CuActResult } from "../../src/agent/computer-use";

/** A fake ComputerUseService capturing act() calls and returning a scripted result. */
function fakeCu(result: CuActResult | ((cls: string, payload: string) => CuActResult)) {
  const calls: Array<{ cls: string; payload: string }> = [];
  const act = async (_sid: string, cls: string, payload: string) => {
    calls.push({ cls, payload });
    return typeof result === "function" ? result(cls, payload) : result;
  };
  return { calls, service: { act } as any };
}

function ctx(over: Partial<ToolContext>): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1", ...over } as ToolContext;
}

async function run(reg: ToolRegistry, args: unknown, c: ToolContext) {
  return reg.execute("computer", args, c);
}

describe("computer tool", () => {
  test("ax_snapshot → ax-read class, returns the tree text", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ text: "#0 window\n#1 button 'Save' @ (840,620)" }) });
    const out = await run(reg, { action: "ax_snapshot" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(false);
    expect(out.output).toContain("button 'Save'");
    expect(cu.calls[0]!).toEqual({ cls: "ax-read", payload: JSON.stringify({ op: "ax_snapshot" }) });
  });

  test("screenshot → screenshot class, stages the image via attachImage, needs vision", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const staged: string[] = [];
    const dataUrl = "data:image/png;base64,ABC";
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ dataUrl, width: 1512, height: 982, scaledWidth: 1280, scaledHeight: 831 }) });
    const out = await run(reg, { action: "screenshot" }, ctx({ computerUse: cu.service, attachImage: (u) => staged.push(u), visionCapable: true }));
    expect(out.isError).toBe(false);
    expect(staged).toEqual([dataUrl]);
    expect(out.output).toContain("1512×982");
    expect(out.output).toContain("1280×831");
    expect(cu.calls[0]!.cls).toBe("screenshot");
  });

  test("screenshot refused on a non-vision model, and never leases", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "screenshot" }, ctx({ computerUse: cu.service, visionCapable: false }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("vision-capable");
    expect(cu.calls.length).toBe(0);
  });

  test("click by element_id → input-drive with an elementId target", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ detail: "clicked element #3" }) });
    const out = await run(reg, { action: "click", element_id: 3 }, ctx({ computerUse: cu.service }));
    expect(out.output).toBe("clicked element #3");
    expect(cu.calls[0]!.cls).toBe("input-drive");
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "click", target: { elementId: 3 }, button: "left", clicks: 1 });
  });

  test("click by x,y with double → coordinate target, 2 clicks", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "click", x: 100, y: 200, double: true, button: "right" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "click", target: { x: 100, y: 200 }, button: "right", clicks: 2 });
  });

  test("click with no target → typed error, no lease", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "click" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("needs a target");
    expect(cu.calls.length).toBe(0);
  });

  test("type → op type with text", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "type", text: "hello" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "type", text: "hello" });
  });

  test("key → op key with the chord", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "key", keys: "cmd+s" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "key", keys: "cmd+s" });
  });

  test("scroll with a target and deltas", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "scroll", x: 10, y: 20, dy: -120 }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "scroll", target: { x: 10, y: 20 }, dx: 0, dy: -120 });
  });

  test("scroll without a target scrolls at the current position", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "scroll", dy: 100 }, ctx({ computerUse: cu.service }));
    const p = JSON.parse(cu.calls[0]!.payload);
    expect(p.op).toBe("scroll");
    expect(p.dy).toBe(100);
    expect(p.target).toBeUndefined();
  });

  test("an act failure surfaces as an isError tool_result with the message", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: false, kind: "unavailable", message: "computer use unavailable — Norma.app not running" });
    const out = await run(reg, { action: "ax_snapshot" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(out.output).toBe("computer use unavailable — Norma.app not running");
  });

  test("no computerUse wired → typed error", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const out = await run(reg, { action: "ax_snapshot" }, ctx({}));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("not available");
  });

  test("screenshotMaxDim from registration rides the payload", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg, { screenshotMaxDim: 1024 });
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ dataUrl: "data:,x" }) });
    await run(reg, { action: "screenshot" }, ctx({ computerUse: cu.service, attachImage: () => {}, visionCapable: true }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "screenshot", maxDim: 1024 });
  });
});
