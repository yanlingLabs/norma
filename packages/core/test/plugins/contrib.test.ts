import { expect, test } from "bun:test";
import { PluginContribRegistry } from "../../src/plugins/contrib";

test("clear removes a plugin's contributions", () => {
  const r = new PluginContribRegistry();
  r.setTile("p1", { title: "T", value: "1" });
  expect(r.get("p1")?.tile).toEqual({ title: "T", value: "1" });
  r.clear("p1");
  expect(r.get("p1")).toBeUndefined();
});

test("set* MERGE per-plugin state (shortcuts then tile keeps both)", () => {
  const r = new PluginContribRegistry();
  r.setShortcuts("p1", [{ id: "s1" }]);
  r.setTile("p1", { title: "T" });
  expect(r.get("p1")).toEqual({ shortcuts: [{ id: "s1" }], tile: { title: "T" } });
});
