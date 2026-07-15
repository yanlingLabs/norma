import type { ToolContext } from "./registry";

/** Hard cap on a vision image's DECODED byte size (shared: the `read` tool's source-file refusal,
 *  the notebook image-output attach, and the MCP `read_mcp_resource` blob attach all enforce this
 *  same bound). Was fs-read.ts-local before the parity-tail review moved it here. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Decoded byte size of a base64 payload from its LENGTH alone — no decode, no allocation.
 *  Exact for well-formed base64 (¾ of the length, minus trailing padding). */
export function base64DecodedBytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Size-guarded `ctx.attachImage` — the ONE seam every base64-sourced image attach flows through
 * (notebook `image/png` cell outputs in fs-read.ts, MCP resource blobs in mcp-resources.ts), so
 * no single caller can stage an arbitrarily large decoded image into the model's input. The
 * `read` tool's own image path doesn't route here only because its stricter stat-based refusal
 * (source file > IMAGE_MAX_BYTES → clean tool error BEFORE any decode) plus its downscale/
 * re-encode step already bound it below this cap.
 *
 * Returns `null` when the image was attached (or when `ctx.attachImage` is unwired — presence/
 * vision gating stays with the caller, exactly as before), or a rendered "[image omitted: ...]"
 * note the caller should surface as text instead of its usual attach note. The size check uses
 * `base64DecodedBytes` (length math only) so an oversized payload is rejected WITHOUT ever
 * decoding or copying it.
 */
export function attachImageGuarded(
  ctx: Pick<ToolContext, "attachImage">,
  img: { mime: string; base64: string },
  opts?: { maxBytes?: number },
): string | null {
  const maxBytes = opts?.maxBytes ?? IMAGE_MAX_BYTES;
  const bytes = base64DecodedBytes(img.base64);
  if (bytes > maxBytes) return `[image omitted: ${humanSize(bytes)} exceeds ${humanSize(maxBytes)}]`;
  ctx.attachImage?.(`data:${img.mime};base64,${img.base64}`);
  return null;
}
