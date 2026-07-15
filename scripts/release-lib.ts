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
// is the sole download host; matches the `origin` remote and project.yml's SUFeedURL. Exported
// so release.ts's publish tail (gh release URL, cask url) shares this single source of truth.
export const GH_REPO = "evaprotocol/norma";

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

export interface DmgStageOp {
  kind: "copy" | "symlink";
  /** copy: absolute source path to copy from. symlink: the link TARGET it should point to. */
  source: string;
  /** Path, relative to the stage dir, where this entry lands. */
  destName: string;
}

/**
 * Plans the DMG staging directory layout: the (already notarized+stapled) app copied in,
 * plus the conventional `/Applications` symlink so a user can drag-install. Pure — returns an
 * operation list; release.ts performs the actual copy/symlink before handing the dir to
 * `hdiutil create -srcfolder`.
 */
export function dmgStagePlan(appPath: string): DmgStageOp[] {
  const appName = appPath.split("/").filter(Boolean).pop();
  if (!appName || !appName.endsWith(".app")) {
    throw new Error(`dmgStagePlan: expected a path ending in .app, got "${appPath}"`);
  }
  return [
    { kind: "copy", source: appPath, destName: appName },
    { kind: "symlink", source: "/Applications", destName: "Applications" },
  ];
}

export interface PublishGuardInputs {
  dryRun: boolean;
  resumePublish: boolean;
  tagExists: boolean;
  releaseExists: boolean;
  version: string;
}

export interface PublishGuardResult {
  action: "dry-run-skip" | "abort" | "publish" | "resume";
  /** dry-run-skip: the skip-list (what would have run). abort: the exact failure line(s).
   * publish/resume: empty. */
  lines: string[];
}

/**
 * Decides what the publish tail should do, given the current tag/release state. `--dry-run`
 * always wins first (never reachable past it, regardless of other flags) and reports a
 * skip-list instead of aborting. Otherwise: an existing tag or release aborts loudly (exact
 * lines, aggregated like `preflight`) unless `--resume-publish` was passed, in which case a
 * MISSING release is itself an abort ("nothing to resume") and an existing one proceeds as
 * "resume" (upload-missing-only; release.ts does the querying).
 */
export function publishGuard(i: PublishGuardInputs): PublishGuardResult {
  const v = i.version;
  if (i.dryRun) {
    return {
      action: "dry-run-skip",
      lines: [
        `gh release create v${v} --title "Norma ${v}" + upload Norma-${v}.zip + Norma-${v}.dmg`,
        `commit + push releases/appcast.xml`,
        `git tag v${v} && git push origin v${v}`,
      ],
    };
  }
  if (i.resumePublish) {
    if (!i.releaseExists) {
      return {
        action: "abort",
        lines: [`--resume-publish given but release v${v} does not exist — nothing to resume`],
      };
    }
    return { action: "resume", lines: [] };
  }
  const aborts: string[] = [];
  if (i.tagExists) {
    aborts.push(
      `tag v${v} already exists — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)`,
    );
  }
  if (i.releaseExists) {
    aborts.push(
      `release v${v} already exists on GitHub — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)`,
    );
  }
  if (aborts.length > 0) return { action: "abort", lines: aborts };
  return { action: "publish", lines: [] };
}
