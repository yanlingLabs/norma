import { createPlugin } from "@norma/plugin-sdk";

/**
 * battery-limiter — the reference Tier-2 (`platform`) plugin for `ctx.hardware()` (Phase 4c Task 5,
 * design spec §5). Every hardware access below goes through `ctx.hardware(verb, args)` — the SDK's
 * thin wrapper around core's `hardware.request` JSON-RPC method, which core then brokers to
 * Norma.app's privileged XPC helper (NormaHelper, Task 3) via a `hardware_requested` push to the
 * active provider connection. This plugin never talks to the helper directly and never needs to —
 * that's the entire point of `ctx.hardware` existing.
 *
 * Two tools, both consent-gated on the "battery" hardware class (`norma-plugin.json`'s
 * `permissions.hardware: ["battery"]`):
 *  - `set_charge_limit {percent}` -> `ctx.hardware("setChargeLimit", {percent})`
 *  - `get_charge_limit {}` -> `ctx.hardware("getChargeLimit")`
 *
 * Both calls THROW on any typed hardware failure (unknown_verb/consent_denied/no_provider/timeout/
 * provider_error — see `@norma/plugin-sdk`'s `PluginContext.hardware` doc comment) rather than
 * returning an error-shaped value, so a failure naturally becomes a typed `plugin.toolResult
 * {error}` — no try/catch needed here, same "let it throw" posture as sample-echo's `boom` tool.
 *
 * `lastKnownLimit` is plain in-process module state (nothing persisted). The SDK pushes exactly ONE
 * `tile.update` per registration cycle (`createPlugin(...).serve()` — see its doc comment: "after
 * EVERY reconnect", never on every state change afterward), so the tile reflects "the last limit
 * THIS plugin process itself observed" as of its most recent (re)registration — a fresh process (or
 * one that's never successfully called either tool yet) reports "unknown", not a stale/guessed
 * value.
 */
let lastKnownLimit: number | undefined;

function extractPercent(result: unknown): number | undefined {
  if (result && typeof result === "object" && "percent" in result) {
    const p = (result as { percent: unknown }).percent;
    if (typeof p === "number") return p;
  }
  return undefined;
}

const plugin = createPlugin({
  tools: {
    set_charge_limit: {
      description: "Sets the battery charge limit (percent, 1-100) via Norma.app's XPC helper.",
      parameters: {
        type: "object",
        properties: { percent: { type: "number" } },
        required: ["percent"],
      },
      run: async (args, ctx) => {
        const { percent } = args as { percent: number };
        const result = await ctx.hardware("setChargeLimit", { percent });
        // The provider's own reply is the source of truth when it echoes back a `percent`
        // (confirms what actually got set); fall back to the requested value otherwise.
        lastKnownLimit = extractPercent(result) ?? percent;
        return result;
      },
    },
    get_charge_limit: {
      description: "Reads the current battery charge limit via Norma.app's XPC helper.",
      parameters: { type: "object", properties: {} },
      run: async (_args, ctx) => {
        const result = await ctx.hardware("getChargeLimit");
        const observed = extractPercent(result);
        if (observed !== undefined) lastKnownLimit = observed;
        return result;
      },
    },
  },
  tile: () => ({
    title: "Battery Limiter",
    value: lastKnownLimit !== undefined ? `${lastKnownLimit}%` : "unknown",
  }),
});

plugin.serve().catch((err) => {
  console.error(`battery-limiter: failed to start: ${(err as Error).message}`);
  process.exit(1);
});
