import { createPlugin } from "@norma/plugin-sdk";

/**
 * sample-echo — the reference Tier-2 (`platform`) plugin (Phase 4b Task 6, design spec §3/§4).
 * `createPlugin({tools, tile}).serve()` (from `@norma/plugin-sdk`) owns the ENTIRE lifecycle
 * contract — connect, hello, register, dispatch, reconnect-with-backoff, clean SIGTERM/SIGINT
 * shutdown — so everything below is purely this plugin's own behavior, nothing wire-level.
 *
 * Two tools:
 *  - `echo {text}` -> `{echo: text, pluginPid: process.pid}`: proves a real round trip through
 *    the supervisor's tool.invoke bridge, and identifies WHICH OS process answered (used by
 *    packages/core/test/plugins/supervised-e2e.test.ts to confirm the reply came from the real
 *    spawned child, not a stub).
 *  - `sleep {ms}` -> `{slept: ms}` after an ACTUAL delay (not instant): Phase 4b Task 7's gate
 *    `kill -9`s this plugin mid-call to exercise the supervisor's crash-during-invoke typed-error
 *    + backoff-restart path — a synchronous tool would resolve before the kill ever lands.
 */
const plugin = createPlugin({
  tools: {
    echo: {
      description: "Echoes `text` back, tagged with this plugin process's OS pid.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      run: (args) => {
        const { text } = args as { text: string };
        return { echo: text, pluginPid: process.pid };
      },
    },
    sleep: {
      description: "Waits `ms` milliseconds (a real delay, not instant) then resolves with `{slept: ms}`.",
      parameters: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"],
      },
      run: async (args) => {
        const { ms } = args as { ms: number };
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { slept: ms };
      },
    },
  },
  tile: () => ({ title: "Sample Echo", value: "ready" }),
});

plugin.serve().catch((err) => {
  console.error(`sample-echo: failed to start: ${(err as Error).message}`);
  process.exit(1);
});
