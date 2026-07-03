import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerNotebookTool } from "../../src/agent/tools/notebook";

function nb() {
  return {
    cells: [
      { id: "c1", cell_type: "code", source: ["print(1)\n"], metadata: {}, outputs: [{ output_type: "stream", text: ["1\n"] }], execution_count: 3 },
      { id: "c2", cell_type: "markdown", source: ["# Title\n"], metadata: {} },
    ],
    metadata: { kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "norma-nb-"));
  const path = join(dir, "n.ipynb");
  writeFileSync(path, JSON.stringify(nb(), null, 1));
  const r = new ToolRegistry();
  registerNotebookTool(r);
  const ctx = { cwd: dir, roots: [dir], sessionId: "s", signal: new AbortController().signal } as any;
  return { dir, path, r, ctx, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

describe("notebook_edit", () => {
  test("replace sets source + clears outputs/execution_count on a code cell", async () => {
    const { r, ctx, read } = setup();
    const out = await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "c1", new_source: "print(2)\n" }, ctx);
    expect(out.isError).toBe(false);
    const n = read();
    expect(n.cells[0].source).toEqual(["print(2)\n"]);
    expect(n.cells[0].outputs).toEqual([]);
    expect(n.cells[0].execution_count).toBeNull();
    expect(n.cells[1].source).toEqual(["# Title\n"]); // untouched
  });

  test("replace can change cell_type", async () => {
    const { r, ctx, read } = setup();
    const out = await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "c1", new_source: "# now markdown\n", cell_type: "markdown" }, ctx);
    expect(out.isError).toBe(false);
    const n = read();
    expect(n.cells[0].cell_type).toBe("markdown");
    expect(n.cells[0].outputs).toBeUndefined();
    expect(n.cells[0].execution_count).toBeUndefined();
  });

  test("insert after cell_id adds a new cell with a fresh id + given cell_type", async () => {
    const { r, ctx, read } = setup();
    await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "c1", new_source: "## Notes\n", cell_type: "markdown", edit_mode: "insert" }, ctx);
    const n = read();
    expect(n.cells.length).toBe(3);
    expect(n.cells[1].cell_type).toBe("markdown");
    expect(typeof n.cells[1].id).toBe("string");
    expect(n.cells[1].id).not.toBe("c1");
    expect(n.cells[1].source).toEqual(["## Notes\n"]);
  });

  test("insert with no cell_id inserts at index 0", async () => {
    const { r, ctx, read } = setup();
    await r.execute("notebook_edit", { notebook_path: "n.ipynb", new_source: "import os\n", edit_mode: "insert" }, ctx);
    const n = read();
    expect(n.cells.length).toBe(3);
    expect(n.cells[0].cell_type).toBe("code");
    expect(n.cells[0].source).toEqual(["import os\n"]);
    expect(n.cells[0].outputs).toEqual([]);
    expect(n.cells[0].execution_count).toBeNull();
    expect(n.cells[1].id).toBe("c1");
  });

  test("delete removes the cell", async () => {
    const { r, ctx, read } = setup();
    const out = await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "c2", new_source: "", edit_mode: "delete" }, ctx);
    expect(out.isError).toBe(false);
    const n = read();
    expect(n.cells.length).toBe(1);
    expect(n.cells[0].id).toBe("c1");
  });

  test("cell_id not found → isError", async () => {
    const { r, ctx } = setup();
    expect((await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "nope", new_source: "x" }, ctx)).isError).toBe(true);
  });

  test("missing cell_id for replace/delete → isError", async () => {
    const { r, ctx } = setup();
    expect((await r.execute("notebook_edit", { notebook_path: "n.ipynb", new_source: "x", edit_mode: "delete" }, ctx)).isError).toBe(true);
  });

  test("non-notebook JSON → isError", async () => {
    const { dir, r, ctx } = setup();
    writeFileSync(join(dir, "bad.ipynb"), "not json");
    expect((await r.execute("notebook_edit", { notebook_path: "bad.ipynb", cell_id: "c1", new_source: "x" }, ctx)).isError).toBe(true);
  });

  test("nbformat/metadata/other cells preserved (round-trip)", async () => {
    const { r, ctx, read } = setup();
    await r.execute("notebook_edit", { notebook_path: "n.ipynb", cell_id: "c1", new_source: "print(2)\n" }, ctx);
    const n = read();
    expect(n.metadata).toEqual({ kernelspec: { name: "python3" } });
    expect(n.nbformat).toBe(4);
    expect(n.nbformat_minor).toBe(5);
    expect(n.cells[1]).toEqual({ id: "c2", cell_type: "markdown", source: ["# Title\n"], metadata: {} });
  });
});
