import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORMAT, ROOT, readCanonical, stampAll } from "./version-lib";

const mode = process.argv[2] ?? "--patch";
const cur = readCanonical();
const m = cur.match(FORMAT)!;
const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];

let next: string;
if (mode === "--major") next = `${maj + 1}.0.000`;
else if (mode === "--minor") next = `${maj}.${min + 1}.000`;
else if (mode === "--patch") {
  // patch overflow at 999 auto-rolls to the next minor
  next = pat >= 999 ? `${maj}.${min + 1}.000` : `${maj}.${min}.${String(pat + 1).padStart(3, "0")}`;
} else {
  throw new Error(`unknown mode ${mode} (use --patch | --minor | --major)`);
}

writeFileSync(join(ROOT, "VERSION"), next + "\n");
stampAll(next);
console.log(`${cur} -> ${next}`);
