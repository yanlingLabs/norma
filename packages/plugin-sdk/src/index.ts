export * from "@norma/protocol";

/** Plugin SDK lands in Phase 4 (spec §7). This package reserves the API surface. */
export function registerPlugin(): never {
  throw new Error("@norma/plugin-sdk: not implemented until Phase 4");
}
