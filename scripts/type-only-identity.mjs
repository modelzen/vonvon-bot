import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closurePath = resolve(repository, "packages/client/src/e2ee/closure.json");
const closure = JSON.parse(await readFile(closurePath, "utf8"));
const entry = closure.files.find((file) => file.path === "encrypted-channel.ts");
assert.equal(entry?.kind, "type-only");
assert.equal(entry.typeOnlyEdits.length, 2);
const sourcePath = resolve(repository, "packages/client/src/e2ee/encrypted-channel.ts");
const integrated = await readFile(sourcePath, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(integrated), entry.integratedSha256, "integrated source hash");

const edits = [entry.modificationNotice, ...entry.typeOnlyEdits];
for (let i = 1; i < edits.length; i += 1) {
  assert.ok(edits[i - 1].start < edits[i].start, `edit ${i} order`);
}
function replay(source, records, direction) {
  const ordered = direction === "forward" ? [...records].reverse() : records;
  let result = source;
  for (const edit of ordered) {
    const replaced = direction === "forward" ? edit.replacedText : edit.insertedText;
    const inserted = direction === "forward" ? edit.insertedText : edit.replacedText;
    assert.equal(result.slice(edit.start, edit.start + replaced.length), replaced,
      `${direction} ${edit.form} at pre-edit UTF-16 offset ${edit.start}`);
    result = result.slice(0, edit.start) + inserted + result.slice(edit.start + replaced.length);
  }
  return result;
}

const preEdit = replay(integrated, edits, "reverse");
assert.equal(sha256(preEdit), entry.preTypeEditSha256, "pre-edit source hash before transform");
assert.equal(replay(preEdit, edits, "forward"), integrated, "forward source replay");
const noNotice = replay(integrated, [entry.modificationNotice], "reverse");

const esbuildOptions = {
  loader: "ts", format: "esm", target: "es2022", minify: false, sourcemap: false,
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false, useDefineForClassFields: true } },
};
const esbuildOutput = async (source) => (await esbuild.transform(source, esbuildOptions)).code;
const tsOptions = { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 };
function typescriptOutput(source, removeComments) {
  const result = ts.transpileModule(source, {
    fileName: "encrypted-channel.ts",
    compilerOptions: { ...tsOptions, removeComments },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics ?? [], [], "TypeScript transpile diagnostics");
  return result.outputText;
}

const es = {
  preEdit: await esbuildOutput(preEdit),
  noNotice: await esbuildOutput(noNotice),
  integrated: await esbuildOutput(integrated),
};
const tsc = {
  preEdit: typescriptOutput(preEdit, false),
  noNotice: typescriptOutput(noNotice, false),
  preEditNoComments: typescriptOutput(preEdit, true),
  integratedNoComments: typescriptOutput(integrated, true),
};
assert.equal(es.noNotice, es.preEdit, "esbuild type-only identity");
assert.equal(es.integrated, es.preEdit, "esbuild full identity");
assert.equal(tsc.noNotice, tsc.preEdit, "TypeScript type-only identity");
assert.equal(tsc.integratedNoComments, tsc.preEditNoComments,
  "TypeScript full identity with removeComments");

const evidence = {
  source: sourcePath.replace(`${repository}/`, ""),
  toolVersions: { esbuild: esbuild.version, typescript: ts.version },
  esbuildOptions,
  typescriptOptions: { module: "NodeNext", target: "ES2022", removeComments: [false, true] },
  sourceSha256: {
    preEdit: sha256(preEdit), noNotice: sha256(noNotice), integrated: sha256(integrated),
  },
  outputSha256: {
    esbuild: Object.fromEntries(Object.entries(es).map(([key, value]) => [key, sha256(value)])),
    typescript: Object.fromEntries(Object.entries(tsc).map(([key, value]) => [key, sha256(value)])),
  },
  checks: {
    reverseReplay: true, forwardReplay: true,
    esbuildNoNoticeIdentity: true, esbuildFullIdentity: true,
    typescriptNoNoticeIdentity: true, typescriptRemoveCommentsIdentity: true,
  },
};
const outputPath = resolve(repository, process.argv[2] ?? ".audit/v11-e2ee-compiler/identity-proof.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(outputPath);
