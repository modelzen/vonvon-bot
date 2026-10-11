import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import closure from "../src/e2ee/closure.json";

const sourceDirectory = new URL("../src/e2ee/", import.meta.url);
const expectedFiles = ["base64.ts", "crypto.ts", "e2ee.ts", "encrypted-channel.ts"];
const pinnedHashes: Record<string, string> = {
  "base64.ts": "74d69461af9727aa3fb70b37ee50ae54e467e1eebf26fb0356453557094137e7",
  "crypto.ts": "309d5cb94ceb236ced93a188d0a0bc3b42a0e347815b4dbe6679374d810db845",
  "e2ee.ts": "434a162cdba9cd93097e7a93eeabb68a91c457e2cff9d5de5bc6c17f8fc79001",
  "encrypted-channel.ts": "2b0d31520917d24993644fc30f065be4d46d3517475f8821388a2263ced3e6a6",
};
const directive = /@ts-(?:ignore|expect-error|nocheck)|eslint-(?:disable|enable)/;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

type FileRecord = (typeof closure.files)[number];
type TypeOnlyRecord = (typeof closure.files)[3];
type Edit = TypeOnlyRecord["typeOnlyEdits"][number] | TypeOnlyRecord["modificationNotice"];

function syntaxRule(name: string, source: string): void {
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const comments = new Map<number, string>();
  let anyCount = 0;
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount += 1;
    for (const range of [
      ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.getEnd()) ?? []),
    ]) comments.set(range.pos, source.slice(range.pos, range.end));
    for (const child of node.getChildren(parsed)) visit(child);
  }
  visit(parsed);
  if (parsed.parseDiagnostics.length) throw new Error(`syntax: ${name} does not parse`);
  if (anyCount) throw new Error(`any-syntax: ${name} has ${anyCount} AnyKeyword nodes`);
  if ([...comments.values()].some((comment) => directive.test(comment))) {
    throw new Error(`directive: ${name} has a suppression comment`);
  }
}

function noticeRule(edit: Edit): void {
  if (edit.diagnostics.length !== 0) throw new Error("diagnostic-ownership: N owns no diagnostic");
  if (edit.form !== "N" || edit.start !== 0 || edit.end !== 0 || edit.replacedText !== "") {
    throw new Error("notice: expected one offset-zero N insertion");
  }
  const lines = edit.insertedText.match(/[^\n]*\n/g) ?? [];
  if (lines.length < 1 || lines.length > 3 || lines.join("") !== edit.insertedText ||
      !lines[0]?.startsWith("// Modified from Paseo") ||
      !lines.every((line) => /^\/\/ [\x20-\x7e]*\n$/.test(line)) ||
      !edit.insertedText.includes("type-only edits erased at compile time") ||
      !edit.insertedText.includes("packages/client/src/e2ee/closure.json") ||
      /@|\/\*|\*\/|eslint|<reference/.test(edit.insertedText)) {
    throw new Error("notice: invalid modification notice");
  }
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, edit.insertedText);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (![ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.NewLineTrivia,
      ts.SyntaxKind.WhitespaceTrivia].includes(token)) throw new Error("notice: non-comment token");
  }
}

function replay(text: string, edits: Edit[], direction: "forward" | "reverse"): string {
  const ordered = direction === "forward" ? [...edits].reverse() : edits;
  let result = text;
  for (const edit of ordered) {
    const oldText = direction === "forward" ? edit.replacedText : edit.insertedText;
    const newText = direction === "forward" ? edit.insertedText : edit.replacedText;
    if (result.slice(edit.start, edit.start + oldText.length) !== oldText) {
      throw new Error(`replay-${direction}: ${edit.form} at ${edit.start} has a stale slice`);
    }
    result = result.slice(0, edit.start) + newText + result.slice(edit.start + oldText.length);
  }
  return result;
}

function validate(records: FileRecord[], sources: Record<string, string>, pinned: Record<string, string>): void {
  if (records.length !== 4 || records.map((file) => file.path).sort().join() !== expectedFiles.join()) {
    throw new Error("file-set: expected the four pinned files");
  }
  const edited = records.filter((file) => file.kind === "type-only");
  if (edited.length !== 1 || edited[0]?.path !== "encrypted-channel.ts") {
    throw new Error("type-only-count: expected encrypted-channel.ts alone");
  }
  for (const file of records) {
    const actual = sources[file.path];
    const original = pinned[file.path];
    if (actual === undefined || original === undefined) throw new Error(`file-set: ${file.path} missing`);
    syntaxRule(file.path, actual);
    syntaxRule(`pinned/${file.path}`, original);
    if (hash(original) !== pinnedHashes[file.path] || file.pinnedSha256 !== pinnedHashes[file.path]) {
      throw new Error(`pinned-hash: ${file.path}`);
    }
    if (file.kind === "pinned") {
      if (actual !== original || hash(actual) !== file.integratedSha256) throw new Error(`integrated-hash: ${file.path}`);
      continue;
    }
    if (file.preTypeEditSha256 !== file.pinnedSha256 || file.typeOnlyEdits.length !== 2) {
      throw new Error("edit-count: expected two E1 insertions");
    }
    noticeRule(file.modificationNotice);
    if (actual.split("// Modified from Paseo").length !== 2) throw new Error("notice: expected exactly one notice");
    const edits: Edit[] = [file.modificationNotice, ...file.typeOnlyEdits];
    for (const [index, edit] of edits.entries()) {
      if (index && (edit.form !== "E1" || edit.start !== [18451, 18458][index - 1] ||
          edit.end !== edit.start || edit.line !== 576 || edit.column !== [23, 30][index - 1] ||
          edit.replacedText !== "" || edit.insertedText !== "!")) {
        throw new Error(`edit-form: edit ${index}`);
      }
      if (index && edit.start <= edits[index - 1]!.start) throw new Error("edit-order: offsets must increase");
    }
    for (const [index, edit] of file.typeOnlyEdits.entries()) {
      const expectedColumn = [19, 26][index];
      if (edit.diagnostics.length !== 1 || edit.diagnostics[0]?.code !== 2532 ||
          edit.diagnostics[0]?.line !== 576 || edit.diagnostics[0]?.column !== expectedColumn) {
        throw new Error(`diagnostic-ownership: E1 ${index + 1} must own TS2532 at 576:${expectedColumn}`);
      }
    }
    if (replay(actual, edits, "reverse") !== original) throw new Error("replay-reverse: pinned bytes differ");
    if (replay(original, edits, "forward") !== actual) throw new Error("replay-forward: integrated bytes differ");
    if (hash(actual) !== file.integratedSha256) throw new Error("integrated-hash: encrypted-channel.ts");
  }
}

const sources = Object.fromEntries(expectedFiles.map((name) => [name,
  readFileSync(new URL(name, sourceDirectory), "utf8")]));
const pinned = { ...sources, "encrypted-channel.ts": replay(sources["encrypted-channel.ts"]!,
  [closure.files[3]!.modificationNotice, ...closure.files[3]!.typeOnlyEdits], "reverse") };

describe("Paseo E2EE closure", () => {
  it("matches the pinned source and reversible type-only ledger", () => {
    validate(closure.files, sources, pinned);
  });

  it.each([
    ["third edit", "edit-count", (copy: typeof closure.files, files: Record<string, string>) => { copy[3]!.typeOnlyEdits.push({ ...copy[3]!.typeOnlyEdits[0]! }); }],
    ["non-bang edit", "edit-form", (copy: typeof closure.files) => { copy[3]!.typeOnlyEdits[0]!.insertedText = "?"; }],
    ["changed hash", "integrated-hash", (copy: typeof closure.files) => { copy[3]!.integratedSha256 = "0".repeat(64); }],
    ["misplaced ledger offset", "edit-form", (copy: typeof closure.files) => { copy[3]!.typeOnlyEdits[0]!.start += 1; copy[3]!.typeOnlyEdits[0]!.end += 1; }],
    ["stale inserted slice", "replay-reverse", (_copy: typeof closure.files, files: Record<string, string>) => { files["encrypted-channel.ts"] = files["encrypted-channel.ts"].replace("a[i]! ^", "a[i]  ^"); }],
    ["duplicate diagnostic column", "diagnostic-ownership", (copy: typeof closure.files) => { copy[3]!.typeOnlyEdits[1]!.diagnostics[0]!.column = 19; }],
    ["wrong diagnostic column", "diagnostic-ownership", (copy: typeof closure.files) => { copy[3]!.typeOnlyEdits[0]!.diagnostics[0]!.column = 20; }],
    ["notice claiming diagnostic", "diagnostic-ownership", (copy: typeof closure.files) => { copy[3]!.modificationNotice.diagnostics.push({ code: 2532, line: 576, column: 19 }); }],
    ["missing notice", "notice", (copy: typeof closure.files) => { copy[3]!.modificationNotice.insertedText = ""; }],
    ["second notice", "notice", (_copy: typeof closure.files, files: Record<string, string>) => { files["encrypted-channel.ts"] = closure.files[3]!.modificationNotice.insertedText + files["encrypted-channel.ts"]; }],
    ["notice directive character", "notice", (copy: typeof closure.files) => { copy[3]!.modificationNotice.insertedText += "// @\n"; }],
    ["any type", "any-syntax", (_copy: typeof closure.files, files: Record<string, string>) => { files["encrypted-channel.ts"] = files["encrypted-channel.ts"].replace("a[i]! ^", "(a[i]! as any) ^"); }],
    ["suppression", "directive", (_copy: typeof closure.files, files: Record<string, string>) => { files["encrypted-channel.ts"] += "\n// @ts-expect-error\n"; }],
  ])("rejects %s by %s", (_label, rule, mutate) => {
    const copy = structuredClone(closure.files);
    const files = { ...sources };
    mutate(copy, files);
    expect(() => validate(copy, files, pinned)).toThrow(rule);
  });

  it.each(expectedFiles)("rejects one-byte mutation of %s", (name) => {
    const files = { ...sources, [name]: `${sources[name]}x` };
    expect(() => validate(structuredClone(closure.files), files, pinned))
      .toThrow(name === "encrypted-channel.ts" ? "replay-reverse" : "integrated-hash");
  });
});
