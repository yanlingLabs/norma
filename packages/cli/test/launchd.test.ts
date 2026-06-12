import { describe, expect, test } from "bun:test";
import { renderPlist, LAUNCHD_LABEL } from "../src/launchd";

describe("renderPlist", () => {
  test("contains label, program arguments, keepalive, and log paths", () => {
    const xml = renderPlist({
      binaryPath: "/usr/local/bin/norma",
      normaHome: "/Users/me/.norma",
    });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/norma</string>");
    expect(xml).toContain("<string>daemon</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<string>/Users/me/.norma/logs/core.out.log</string>");
    expect(xml).toContain("<string>/Users/me/.norma/logs/core.err.log</string>");
    expect(xml).not.toContain("~"); // launchd does not expand tildes
  });
});
