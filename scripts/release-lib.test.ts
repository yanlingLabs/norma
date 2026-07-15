import { describe, expect, test } from "bun:test";
import { appcastItem, caskFrom, preflight } from "./release-lib";

describe("preflight", () => {
  test("every check passing -> ok with no failures", () => {
    const result = preflight({ checks: { a: () => null, b: () => null, c: () => null } });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  test("a single failing check surfaces its exact line", () => {
    const result = preflight({
      checks: { a: () => null, b: () => "exact user-facing failure line" },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["exact user-facing failure line"]);
  });

  test("aggregates every failing check at once, not just the first", () => {
    const result = preflight({
      checks: {
        identity: () => "missing Developer ID identity for team 37N77U9RSZ — create it in Xcode > Settings > Accounts > Manage Certificates",
        notary: () => null,
        prodKey: () => "production Sparkle key missing — run: .tools/sparkle/bin/generate_keys   (60 seconds; back it up with -x)",
        gh: () => null,
        tag: () => "tag v0.2.001 already exists — bump the version or delete the stale tag",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "missing Developer ID identity for team 37N77U9RSZ — create it in Xcode > Settings > Accounts > Manage Certificates",
      "production Sparkle key missing — run: .tools/sparkle/bin/generate_keys   (60 seconds; back it up with -x)",
      "tag v0.2.001 already exists — bump the version or delete the stale tag",
    ]);
  });

  test("no checks -> vacuously ok", () => {
    expect(preflight({ checks: {} })).toEqual({ ok: true, failures: [] });
  });
});

describe("appcastItem", () => {
  const base = {
    version: "0.2.002",
    zipName: "Norma-0.2.002.zip",
    edSignature: "gr6VoIYzbcgIf6ScRRcbnPRnKPKtNGeHmVBqZlHEr3XQ0V6WQdT/E1eeGz1nA9Am==",
    length: 12345678,
    minSystem: "26.0",
  };

  test("stable release (beta:false) has no channel element", () => {
    const xml = appcastItem({ ...base, beta: false });
    expect(xml).not.toContain("sparkle:channel");
  });

  test("beta release (beta:true) has exactly one channel element", () => {
    const xml = appcastItem({ ...base, beta: true });
    const matches = xml.match(/<sparkle:channel>beta<\/sparkle:channel>/g);
    expect(matches?.length).toBe(1);
  });

  test("fields match the Sparkle schema used by the gate rig", () => {
    const xml = appcastItem({ ...base, beta: false });
    expect(xml).toContain("<sparkle:version>0.2.002</sparkle:version>");
    expect(xml).toContain("<sparkle:shortVersionString>0.2.002</sparkle:shortVersionString>");
    expect(xml).toContain("<sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>");
    expect(xml).toContain(`sparkle:edSignature="${base.edSignature}"`);
    expect(xml).toContain(`length="${base.length}"`);
    expect(xml).toContain('type="application/octet-stream"');
    expect(xml).toContain(base.zipName);
    expect(xml).toContain("<item>");
    expect(xml).toContain("</item>");
  });
});

describe("caskFrom", () => {
  const tmpl = `cask "norma" do
  version "{{version}}"
  sha256 "{{sha256}}"
  url "{{url}}"
  name "Norma {{version}}"
end
`;

  test("interpolates every placeholder, including repeats", () => {
    const rendered = caskFrom(tmpl, {
      version: "0.2.002",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      url: "https://github.com/evaprotocol/norma/releases/download/v0.2.002/Norma-0.2.002.dmg",
    });
    expect(rendered).toContain('version "0.2.002"');
    expect(rendered).toContain('sha256 "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"');
    expect(rendered).toContain(
      'url "https://github.com/evaprotocol/norma/releases/download/v0.2.002/Norma-0.2.002.dmg"',
    );
    expect(rendered).toContain('name "Norma 0.2.002"');
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
  });
});
