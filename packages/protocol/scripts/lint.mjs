import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url);
const files = (await readdir(root)).filter(name => name.endsWith(".ts"));
let failed = false;
for (const name of files) {
  const contents = await readFile(new URL(name, root), "utf8");
  for (const [index, line] of contents.split("\n").entries()) {
    if (/\bany\b/.test(line) || /[\t ]$/.test(line)) {
      console.error(`${join("src", name)}:${index + 1}: explicit any or trailing whitespace`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
