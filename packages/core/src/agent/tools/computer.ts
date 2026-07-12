import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { PeripheralClass } from "../../peripheral/broker";

/**
 * `computer` (Phase 5 CU) — the computer-use tool. ONE tool with an `action` discriminant; each
 * action maps to a peripheral capability class leased from Norma.app (spec §4.6):
 *
 *   ax_snapshot → ax-read      (PRIMARY grounding: a text tree of on-screen elements with ids +
 *                               role/label/value + AX-sourced screen-space center coordinates)
 *   screenshot  → screenshot   (SECONDARY: a downscaled PNG staged as a vision image; needs a
 *                               vision-capable model)
 *   click/move/type/key/scroll → input-drive (act on an element id — native AXPress — or on x,y)
 *
 * A PLAIN TOOL (not an engine bridge): everything it needs is `ctx.computerUse.act(...)` (the
 * lease-holding ComputerUseService) + `ctx.attachImage` (staging a screenshot for the model). The
 * tool builds the provider payload, calls the service, and shapes the model-facing result.
 *
 * Errors surface as isError tool_results (thrown → the registry catches them): "computer use
 * unavailable — Norma.app not running" (no provider / lease gone), a denial message (policy), or the
 * provider's own message (e.g. missing TCC grant).
 */

const Target = { element_id: z.number().int().nonnegative().optional(), x: z.number().optional(), y: z.number().optional() };

const ComputerArgs = z.object({
  action: z.enum(["ax_snapshot", "screenshot", "click", "move", "type", "key", "scroll"]),
  ...Target,
  button: z.enum(["left", "right"]).optional(),
  double: z.boolean().optional(),
  text: z.string().optional(),
  keys: z.string().optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
});
type ComputerArgsT = z.infer<typeof ComputerArgs>;

// Hand-authored JSON Schema (rawParameters) so the description carries the AX-primary guidance the
// model needs — the generated schema would drop the prose.
const RAW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["ax_snapshot", "screenshot", "click", "move", "type", "key", "scroll"],
      description:
        "ax_snapshot: read the accessibility tree of the frontmost app — a numbered list of elements with role, label, value and on-screen center coordinates. PREFER THIS to ground actions (it is exact); screenshot only when the UI is not exposed via accessibility. " +
        "screenshot: capture the screen as an image (needs a vision-capable model). " +
        "click/move: act on element_id (from the latest ax_snapshot) OR x,y coordinates — prefer element_id. " +
        "type: type `text` into the focused element. key: press `keys` (e.g. \"cmd+s\", \"return\", \"cmd+shift+4\"). " +
        "scroll: scroll by dx,dy at element_id or x,y.",
    },
    element_id: { type: "integer", minimum: 0, description: "Target element id from the latest ax_snapshot (preferred over x,y)." },
    x: { type: "number", description: "Target x (screen points) — use only when no element_id fits." },
    y: { type: "number", description: "Target y (screen points)." },
    button: { type: "string", enum: ["left", "right"], description: "Mouse button for click (default left)." },
    double: { type: "boolean", description: "Double-click when true." },
    text: { type: "string", description: "Text to type (action=type)." },
    keys: { type: "string", description: "Key or chord to press, e.g. \"cmd+s\" (action=key)." },
    dx: { type: "number", description: "Horizontal scroll delta (action=scroll)." },
    dy: { type: "number", description: "Vertical scroll delta (action=scroll)." },
  },
};

/** The peripheral class each action leases. */
function classFor(action: ComputerArgsT["action"]): PeripheralClass {
  if (action === "ax_snapshot") return "ax-read";
  if (action === "screenshot") return "screenshot";
  return "input-drive"; // click/move/type/key/scroll
}

/** Resolve the target object for actions that need one; throws a typed error when neither an
 *  element_id nor an x,y pair is supplied. */
function target(a: ComputerArgsT): Record<string, unknown> {
  if (a.element_id !== undefined) return { elementId: a.element_id };
  if (a.x !== undefined && a.y !== undefined) return { x: a.x, y: a.y };
  throw new Error(`action '${a.action}' needs a target: either element_id (from ax_snapshot) or both x and y`);
}

/** Build the provider payload for an action (throws a typed error on a missing required field). */
function buildPayload(a: ComputerArgsT, screenshotMaxDim?: number): Record<string, unknown> {
  switch (a.action) {
    case "ax_snapshot":
      return { op: "ax_snapshot" };
    case "screenshot":
      return screenshotMaxDim ? { op: "screenshot", maxDim: screenshotMaxDim } : { op: "screenshot" };
    case "click":
      return { op: "click", target: target(a), button: a.button ?? "left", clicks: a.double ? 2 : 1 };
    case "move":
      return { op: "move", target: target(a) };
    case "type":
      if (a.text === undefined) throw new Error("action 'type' needs `text`");
      return { op: "type", text: a.text };
    case "key":
      if (!a.keys) throw new Error("action 'key' needs `keys` (e.g. \"cmd+s\")");
      return { op: "key", keys: a.keys };
    case "scroll":
      if (a.dx === undefined && a.dy === undefined) throw new Error("action 'scroll' needs dx and/or dy");
      return { op: "scroll", target: a.element_id !== undefined || (a.x !== undefined && a.y !== undefined) ? target(a) : undefined, dx: a.dx ?? 0, dy: a.dy ?? 0 };
  }
}

/** Shape the model-facing result string from a successful capability call. */
function formatResult(a: ComputerArgsT, resultJson: string, attachImage?: (u: string) => void): string {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(resultJson || "{}"); } catch { /* provider returned non-JSON — fall through */ }

  if (a.action === "ax_snapshot") {
    return typeof parsed.text === "string" ? parsed.text : resultJson;
  }
  if (a.action === "screenshot") {
    const dataUrl = typeof parsed.dataUrl === "string" ? parsed.dataUrl : undefined;
    if (dataUrl && attachImage) attachImage(dataUrl);
    const w = parsed.width, h = parsed.height, sw = parsed.scaledWidth, sh = parsed.scaledHeight;
    const dims = typeof w === "number" && typeof h === "number" ? `${w}×${h}` : "screen";
    const scaled = typeof sw === "number" && typeof sh === "number" && (sw !== w || sh !== h) ? `, sent to you at ${sw}×${sh}` : "";
    return dataUrl ? `Screenshot captured (${dims}${scaled}). The image is provided to you above.` : `Screenshot captured (${dims}).`;
  }
  // input actions: prefer a provider-supplied detail, else a generic confirmation.
  if (typeof parsed.detail === "string") return parsed.detail;
  return `${a.action} done`;
}

export function registerComputerTool(
  r: ToolRegistry,
  deps: { screenshotMaxDim?: number; deferred?: boolean } = {},
): void {
  const { screenshotMaxDim, deferred } = deps;
  r.register({
    name: "computer",
    description:
      "Control this Mac: read the accessibility tree (ax_snapshot), take a screenshot, and click/type/press keys/scroll. " +
      "Ground actions on ax_snapshot elements (exact) before falling back to a screenshot. Requires Norma.app running with the relevant permissions granted.",
    args: ComputerArgs,
    rawParameters: RAW_PARAMETERS,
    deferred,
    async run(args, ctx) {
      if (!ctx.computerUse) throw new Error("computer use is not available in this session");
      const a = args as ComputerArgsT;
      if (a.action === "screenshot" && ctx.visionCapable === false) {
        throw new Error("screenshots need a vision-capable model; use action 'ax_snapshot' to read the screen instead");
      }
      const cls = classFor(a.action);
      const payload = JSON.stringify(buildPayload(a, screenshotMaxDim));
      const res = await ctx.computerUse.act(ctx.sessionId, cls, payload);
      if (!res.ok) throw new Error(res.message);
      return formatResult(a, res.resultJson, ctx.attachImage);
    },
  });
}
