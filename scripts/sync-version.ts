import { readCanonical, stampAll } from "./version-lib";

const v = readCanonical();
const files = stampAll(v);
console.log(`synced ${v} -> ${files.length} files`);
