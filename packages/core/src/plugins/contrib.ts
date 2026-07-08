import { z } from "zod";
import { ShortcutRegisterParams, TileUpdateParams, ProviderRegisterParams } from "@norma/protocol";

/**
 * Latest-per-plugin storage for the three "declarative UI contribution" plugin verbs
 * (`shortcut.register`/`tile.update`/`provider.register`, design spec §3/§6) — Phase 4b Task 4
 * wires the wire handlers (ipc/server.ts) to write into this; Phase 4d (Plugin Manager UI /
 * central shortcuts + tiles, spec §6/§7) is the reader.
 *
 * Deliberately dumb: no validation beyond the wire schemas ipc/server.ts's `parseParams` already
 * applied, no events, no broadcast (unlike `PluginSupervisor`'s connection-scoped `plugin_tool_
 * invoke` push, none of these three verbs need a live round-trip back to the plugin) — "last
 * write wins" per plugin id, exactly like a plugin process re-declaring its own shortcuts/tile/
 * provider info on every reconnect (the SDK's `serve()` re-registers everything on reconnect,
 * Task 5's contract).
 */
export interface PluginContribState {
  shortcuts?: z.infer<typeof ShortcutRegisterParams>["shortcuts"];
  tile?: z.infer<typeof TileUpdateParams>["tile"];
  provider?: z.infer<typeof ProviderRegisterParams>["info"];
}

export class PluginContribRegistry {
  private byPlugin = new Map<string, PluginContribState>();

  private entry(pluginId: string): PluginContribState {
    let e = this.byPlugin.get(pluginId);
    if (!e) {
      e = {};
      this.byPlugin.set(pluginId, e);
    }
    return e;
  }

  setShortcuts(pluginId: string, shortcuts: PluginContribState["shortcuts"]): void {
    this.entry(pluginId).shortcuts = shortcuts;
  }

  setTile(pluginId: string, tile: PluginContribState["tile"]): void {
    this.entry(pluginId).tile = tile;
  }

  setProvider(pluginId: string, provider: PluginContribState["provider"]): void {
    this.entry(pluginId).provider = provider;
  }

  get(pluginId: string): PluginContribState | undefined {
    return this.byPlugin.get(pluginId);
  }

  /** Every plugin with at least one contribution recorded — Phase 4d's read surface. */
  all(): Array<{ pluginId: string; state: PluginContribState }> {
    return [...this.byPlugin.entries()].map(([pluginId, state]) => ({ pluginId, state }));
  }
}
