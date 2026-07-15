/**
 * Pure, unit-tested parts of the release pipeline (scripts/release.ts). Nothing in this file
 * shells out, touches the filesystem, or reads process.argv — every real-world check (identity
 * lookup, notary profile probe, gh auth, git tree/tag state) lives in release.ts and is wired
 * into `preflight()` as a closure; this module only aggregates results and renders text.
 */

export interface Preflight {
  ok: boolean;
  failures: string[];
}

/**
 * Runs every named check and aggregates ALL failures at once (never short-circuits on the
 * first one) so a release attempt can be told everything wrong in a single pass. Each check
 * returns `null` on pass or the exact user-facing failure line on fail.
 */
export function preflight(opts: { checks: Record<string, () => string | null> }): Preflight {
  const failures: string[] = [];
  for (const check of Object.values(opts.checks)) {
    const line = check();
    if (line !== null) failures.push(line);
  }
  return { ok: failures.length === 0, failures };
}

// Distribution backbone (design spec 2026-07-15-release-pipeline-design.md) — GitHub Releases
// is the sole download host; matches the `origin` remote and project.yml's SUFeedURL.
const GH_REPO = "evaprotocol/norma";

/**
 * Renders one Sparkle appcast `<item>` for the update-check enclosure (the `.zip`). Schema
 * mirrors scripts/sparkle-feed-gate.ts's local test appcast: title/version/shortVersionString,
 * an optional `sparkle:channel` for beta, minimumSystemVersion, and the signed enclosure.
 */
export function appcastItem(i: {
  version: string;
  zipName: string;
  edSignature: string;
  length: number;
  beta: boolean;
  minSystem: string;
}): string {
  const url = `https://github.com/${GH_REPO}/releases/download/v${i.version}/${i.zipName}`;
  const channel = i.beta ? "\n      <sparkle:channel>beta</sparkle:channel>" : "";
  return `    <item>
      <title>${i.version}</title>
      <sparkle:version>${i.version}</sparkle:version>
      <sparkle:shortVersionString>${i.version}</sparkle:shortVersionString>${channel}
      <sparkle:minimumSystemVersion>${i.minSystem}</sparkle:minimumSystemVersion>
      <enclosure url="${url}" sparkle:edSignature="${i.edSignature}" length="${i.length}" type="application/octet-stream"/>
    </item>`;
}

/** Interpolates a brew cask template (T3's packaging/norma.rb.tmpl) — `{{version}}`/`{{sha256}}`/`{{url}}`. */
export function caskFrom(tmpl: string, i: { version: string; sha256: string; url: string }): string {
  return tmpl
    .replaceAll("{{version}}", i.version)
    .replaceAll("{{sha256}}", i.sha256)
    .replaceAll("{{url}}", i.url);
}
