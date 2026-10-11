import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { transform, version as esbuildVersion } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sealedRoot = resolve(root, 'packages/daemon/test/fixtures/v7-compiler-closure');
const closurePath = resolve(root, 'packages/daemon/src/agent/paseo/closure.json');
const residualPath = resolve(sealedRoot, 'residual.txt');
const preRoot = resolve(sealedRoot, 'pre-type');
const readPre = (file) => readFileSync(resolve(preRoot, `${file}.txt`), 'utf8');
const reportPath = resolve(root, '.audit/v7-compiler-closure/ledger-verification.json');
const proofPath = resolve(root, '.audit/v7-compiler-closure/identity-proof.json');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const suppression = /@ts-(?:ignore|expect-error|nocheck)|eslint-(?:disable|enable)/;
const evidenceHashes = new Map([
  ['packages/daemon/test/fixtures/v7-compiler-closure/residual.txt', '021c611ba671335fdccdb7a1d27f22aafff60bb0f9afbd9851c17bd732210a2b'],
  ['packages/daemon/test/fixtures/v7-compiler-closure/typecheck-01.txt', '1d301beb2071d846f638a50d61c8595e20c912d897aef77c1ad357b68d73bae4'],
  ['packages/daemon/test/fixtures/v7-compiler-closure/typecheck-02.txt', 'ee731d5c0165f78a50e6bdf292434b76139b34c53aa69321b3ed1926085d6e6f'],
  ['packages/daemon/test/fixtures/v7-compiler-closure/typecheck-04.txt', '1ef686390955de6937d764902ea6eb085631afb30d9fa9b587173508c90320a5'],
]);
const intermediateProofs = new Map([
  ['packages/daemon/test/paseo/providers/acp-agent.test.ts:3948:68', ['typecheck-01.txt', 3948, 21]],
  ['packages/daemon/test/paseo/providers/acp-agent.test.ts:3980:42', ['typecheck-01.txt', 3980, 21]],
  ['packages/daemon/test/paseo/providers/acp-agent.test.ts:4037:42', ['typecheck-01.txt', 4037, 21]],
  ['packages/daemon/test/paseo/providers/acp-agent.test.ts:4100:42', ['typecheck-01.txt', 4100, 21]],
  ['packages/daemon/test/paseo/providers/acp-agent.test.ts:4122:69', ['typecheck-01.txt', 4122, 21]],
  ['packages/daemon/test/paseo/providers/acp-agent.test.ts:4138:60', ['typecheck-02.txt', 4138, 21]],
  ['packages/daemon/test/paseo/providers/pi/extensions/index.test.ts:128:98', ['typecheck-02.txt', 128, 9]],
  ['packages/daemon/test/paseo/providers/opencode/test-utils/v2-harness.ts:167:6', ['typecheck-04.txt', 133, 14]],
]);

export function assertTS2352Diagnostic(evidence, proof, ownedMessage, file, start) {
  const location = `${proof.file.slice('packages/daemon/'.length)}(${proof.line},${proof.column}): error TS2352:`;
  if (!evidence.split('\n').some((line) => line.startsWith(location) && (ownedMessage === undefined || line.slice(location.length).trim() === ownedMessage))) fail(`TS2352 evidence position ${file}:${start}`);
}

export function validateUnknownBridge(edit, file, preText, readEvidence = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const isBridge = edit.form === 'E4' && edit.insertedText.includes(' as unknown');
  if (!isBridge) {
    if (edit.ts2352Evidence !== undefined) fail(`unexpected TS2352 evidence ${file}:${edit.start}`);
    return;
  }
  const path = edit.ts2352Evidence;
  if (!evidenceHashes.has(path)) fail(`missing TS2352 evidence ${file}:${edit.start}`);
  const evidence = readEvidence(path);
  if (digest(evidence) !== evidenceHashes.get(path)) fail(`TS2352 evidence hash ${file}:${edit.start}`);
  const owned = edit.diagnostics.filter((diagnostic) => diagnostic.code === 'TS2352');
  const intermediate = intermediateProofs.get(`${file}:${edit.line}:${edit.column}`);
  if (owned.length > 1 || (owned.length === 1) === Boolean(intermediate)) fail(`TS2352 evidence association ${file}:${edit.start}`);
  const proof = owned[0] ?? { file, line: intermediate?.[1], column: intermediate?.[2], code: 'TS2352' };
  if (intermediate && !path.endsWith(`/${intermediate[0]}`)) fail(`TS2352 evidence path ${file}:${edit.start}`);
  if (owned.length && !path.endsWith('/residual.txt')) fail(`TS2352 residual path ${file}:${edit.start}`);
  assertTS2352Diagnostic(evidence, proof, owned[0]?.message, file, edit.start);
  const tree = ts.createSourceFile(file, preText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const proofOffset = tree.getPositionOfLineAndCharacter(proof.line - 1, proof.column - 1);
  let encloses = false;
  const visit = (node) => {
    if (node.end === edit.start && node.getStart(tree) <= proofOffset && proofOffset < node.end) encloses = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!encloses) fail(`TS2352 source span ${file}:${edit.start}`);
}

export function analyzeSource(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const comments = new Map();
  let anyTypes = 0;
  const add = (ranges) => {
    for (const range of ranges ?? []) comments.set(`${range.pos}:${range.end}`, source.slice(range.pos, range.end));
  };
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyTypes++;
    add(ts.getLeadingCommentRanges(source, node.getFullStart()));
    add(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(tree)) visit(child);
  };
  visit(tree);
  return { anyTypes, directives: [...comments.values()].filter((comment) => suppression.test(comment)).length, comments: comments.size };
}

export function assertSyntaxIdentity(file, beforeText, afterText) {
  const before = analyzeSource(file, beforeText);
  const after = analyzeSource(file, afterText);
  if (before.anyTypes !== after.anyTypes || before.directives !== after.directives) fail(`type or directive increase ${file}: ${JSON.stringify({ before, after })}`);
}

function checkType(type, insideExtract = false) {
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    for (const argument of type.typeArguments ?? []) checkType(argument, name === 'Extract' || name === 'Exclude');
    return;
  }
  if (ts.isTypeQueryNode(type)) {
    if (type.typeArguments?.length || !(ts.isIdentifier(type.exprName) || ts.isQualifiedName(type.exprName))) fail('E4 forbidden typeof argument');
    return;
  }
  if (ts.isIndexedAccessTypeNode(type)) {
    checkType(type.objectType);
    const index = type.indexType;
    if (index.kind !== ts.SyntaxKind.NumberKeyword && !(ts.isLiteralTypeNode(index) && (ts.isStringLiteral(index.literal) || ts.isNumericLiteral(index.literal)))) fail('E4 indexed access must use a literal or number');
    return;
  }
  if (ts.isArrayTypeNode(type)) return checkType(type.elementType);
  if (ts.isTupleTypeNode(type)) return type.elements.forEach((element) => checkType(element));
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.forEach((member) => checkType(member));
  if (ts.isParenthesizedTypeNode(type)) return checkType(type.type, insideExtract);
  if (ts.isTypeOperatorNode(type) && [ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.KeyOfKeyword].includes(type.operator)) return checkType(type.type);
  if (ts.isLiteralTypeNode(type) && (ts.isStringLiteral(type.literal) || ts.isNumericLiteral(type.literal) || type.literal.kind === ts.SyntaxKind.NullKeyword)) return;
  if (ts.isFunctionTypeNode(type)) {
    if (type.typeParameters?.length) fail('E4 generic function type');
    for (const parameter of type.parameters) {
      if (parameter.questionToken || !parameter.type || (!ts.isIdentifier(parameter.name) && !ts.isObjectBindingPattern(parameter.name))) fail('E4 function parameter');
      checkType(parameter.type);
    }
    return checkType(type.type);
  }
  if (ts.isTypeLiteralNode(type)) {
    if (!insideExtract) fail('E4 object type outside Extract or Exclude');
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.type || !(ts.isLiteralTypeNode(member.type) || allowedKeyword(member.type))) fail('E4 object member');
      checkType(member.type);
    }
    return;
  }
  if (allowedKeyword(type)) return;
  fail(`E4 forbidden type node ${ts.SyntaxKind[type.kind]}`);
}

function allowedKeyword(type) {
  return [ts.SyntaxKind.VoidKeyword, ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.UndefinedKeyword,
    ts.SyntaxKind.NeverKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.BooleanKeyword].includes(type.kind);
}

export function validateE4(edit, file) {
  if (!file.startsWith('packages/daemon/test/')) fail(`E4 production path ${file}`);
  const text = edit.insertedText;
  let wrapper;
  let pick;
  if (text.startsWith(' as ')) {
    wrapper = `const value = input${text};`;
    pick = (tree) => tree.statements[0]?.declarationList?.declarations[0]?.initializer;
  } else if (text.startsWith('<')) {
    wrapper = `call${text}(input);`;
    pick = (tree) => tree.statements[0]?.expression;
  } else if (text.startsWith(': ')) {
    wrapper = `const value${text} = input;`;
    pick = (tree) => tree.statements[0]?.declarationList?.declarations[0];
  } else fail(`E4 unrecognized text ${file}:${edit.start}`);
  const tree = ts.createSourceFile('e4.ts', wrapper, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) fail(`E4 parse error ${file}:${edit.start}`);
  if (tree.statements.length !== 1 || tree.statements[0].end !== wrapper.length) fail(`E4 trailing syntax ${file}:${edit.start}`);
  const syntax = analyzeSource('e4.ts', wrapper);
  if (syntax.anyTypes) fail(`E4 any type ${file}:${edit.start}`);
  if (syntax.comments) fail(`E4 comment ${file}:${edit.start}`);
  const node = pick(tree);
  if (text.startsWith(' as ')) {
    if (!ts.isVariableStatement(tree.statements[0]) || tree.statements[0].declarationList.declarations.length !== 1) fail(`E4 wrapper ${file}:${edit.start}`);
    if (!ts.isAsExpression(node)) fail('E4 expected assertion');
    let current = node;
    while (ts.isAsExpression(current)) {
      checkType(current.type);
      current = current.expression;
    }
    if (!ts.isIdentifier(current) || current.text !== 'input') fail(`E4 changed base expression ${file}:${edit.start}`);
  } else if (text.startsWith('<')) {
    if (!ts.isExpressionStatement(tree.statements[0])) fail(`E4 wrapper ${file}:${edit.start}`);
    if (!ts.isCallExpression(node) || !node.typeArguments?.length) fail('E4 expected generic call');
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'call' || node.arguments.length !== 1 || !ts.isIdentifier(node.arguments[0]) || node.arguments[0].text !== 'input') fail(`E4 changed generic call ${file}:${edit.start}`);
    node.typeArguments.forEach((type) => checkType(type));
  } else {
    if (!ts.isVariableStatement(tree.statements[0]) || tree.statements[0].declarationList.declarations.length !== 1) fail(`E4 wrapper ${file}:${edit.start}`);
    if (!ts.isVariableDeclaration(node) || !node.type) fail('E4 expected annotation');
    if (!ts.isIdentifier(node.name) || node.name.text !== 'value' || !ts.isIdentifier(node.initializer) || node.initializer.text !== 'input') fail(`E4 changed initializer ${file}:${edit.start}`);
    checkType(node.type);
  }
}

export function validateEdit(edit, file, preText) {
  const { start, end, replacedText, insertedText, form } = edit;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || preText.slice(start, end) !== replacedText || end - start !== replacedText.length) fail(`stale coordinate ${file}:${start}`);
  const prefix = preText.slice(0, start);
  const line = prefix.split('\n').length;
  const column = start - prefix.lastIndexOf('\n');
  if (edit.line !== line || edit.column !== column) fail(`line and column ${file}:${start}`);
  if (suppression.test(insertedText)) fail(`suppression in edit ${file}:${start}`);
  if (form === 'E1') {
    if (replacedText || insertedText !== '!' || !edit.diagnostics.every((diagnostic) => ['TS2532', 'TS2531', 'TS18048', 'TS2322', 'TS2345'].includes(diagnostic.code))) fail(`E1 form ${file}:${start}`);
  } else if (form === 'E1s') {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*): \1!$/.exec(insertedText);
    const before = preText.slice(0, start).trimEnd().at(-1);
    const after = preText.slice(end).trimStart()[0];
    if (!match || replacedText !== match[1] || !['{', ','].includes(before) || ![',', '}'].includes(after) || !['TS2322', 'TS2345'].includes(edit.diagnostics?.[0]?.code)) fail(`E1s form ${file}:${start}`);
  } else if (form === 'E2') {
    if (replacedText || insertedText !== 'override ') fail(`E2 form ${file}:${start}`);
  } else if (form === 'E3') {
    if (replacedText || insertedText !== 'type ') fail(`E3 form ${file}:${start}`);
  } else if (form === 'E4') {
    if (insertedText.startsWith(' as ') && replacedText) fail(`E4 assertion replacement ${file}:${start}`);
    if (insertedText.startsWith('<') && replacedText && !(replacedText.startsWith('<') && replacedText.endsWith('>'))) fail(`E4 generic replacement ${file}:${start}`);
    if (insertedText.startsWith(': ') && replacedText && !replacedText.startsWith(': ')) fail(`E4 annotation replacement ${file}:${start}`);
    validateE4(edit, file);
  } else if (form === 'E5') {
    if (!file.endsWith('/providers/acp-agent.ts') || replacedText !== 'private' || insertedText !== 'protected' || !preText.slice(start).startsWith('private async spawnProcess')) fail(`E5 form ${file}:${start}`);
  } else fail(`unknown edit form ${form} ${file}:${start}`);
  if (!edit.diagnostics?.length) fail(`unowned edit ${file}:${start}`);
  validateUnknownBridge(edit, file, preText);
}

export function validateNotice(notice, file, preText, firstEditStart) {
  if (!notice || notice.form !== 'N' || notice.replacedText !== '' || notice.start !== notice.end || notice.start >= firstEditStart || preText.slice(notice.start, notice.end) !== '') fail(`N position ${file}`);
  if (notice.diagnostics !== undefined && (!Array.isArray(notice.diagnostics) || notice.diagnostics.length !== 0)) fail(`N diagnostic ownership ${file}`);
  const expectedStart = preText.startsWith('// Modified from Paseo') || preText.startsWith('#!') ? preText.indexOf('\n') + 1 : 0;
  if (notice.start !== expectedStart) fail(`N displaced ${file}`);
  const lines = notice.insertedText.match(/[^\n]*\n/g) ?? [];
  if (lines.length < 1 || lines.length > 3 || lines.join('') !== notice.insertedText || !lines.every((line) => /^\/\/ [\x20-\x7e]*\n$/.test(line)) || !lines[0].startsWith('// Modified from Paseo') || !notice.insertedText.includes('type-only') || !notice.insertedText.includes('packages/daemon/src/agent/paseo/closure.json') || /@|\/\*|\*\/|eslint|<reference/.test(notice.insertedText)) fail(`N text ${file}`);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, notice.insertedText);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (![ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.NewLineTrivia, ts.SyntaxKind.WhitespaceTrivia].includes(token)) fail(`N token ${file}`);
  }
}

export function replay(row, preText, integratedText) {
  const file = row.destination;
  const edits = [...(row.typeOnlyEdits ?? []), row.modificationNotice].sort((a, b) => a.start - b.start);
  if (edits.length !== row.typeOnlyEdits.length + 1) fail(`missing N ${file}`);
  validateNotice(row.modificationNotice, file, preText, edits[1].start);
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (index && edits[index - 1].end > edit.start) fail(`overlap ${file}:${edit.start}`);
    if (edit.form !== 'N') validateEdit(edit, file, preText);
  }
  let forward = preText;
  for (const edit of [...edits].reverse()) {
    if (forward.slice(edit.start, edit.end) !== edit.replacedText) fail(`forward slice ${file}:${edit.start}`);
    forward = forward.slice(0, edit.start) + edit.insertedText + forward.slice(edit.end);
  }
  if (forward !== integratedText) fail(`forward content ${file}`);
  let reverse = integratedText;
  for (const edit of edits) {
    if (reverse.slice(edit.start, edit.start + edit.insertedText.length) !== edit.insertedText) fail(`reverse slice ${file}:${edit.start}`);
    reverse = reverse.slice(0, edit.start) + edit.replacedText + reverse.slice(edit.start + edit.insertedText.length);
  }
  if (reverse !== preText) fail(`reverse content ${file}`);
  assertSyntaxIdentity(file, preText, integratedText);
}

export function verifyStatic({ closure, sealedHashes, residualText, readPre, readIntegrated }) {
  const files = closure.v7.files;
  if (files.length !== 76 || closure.v7.testCaseExclusions.length !== 16) fail('V7 inventory count');
  if (new Set(files.map((file) => file.destination)).size !== files.length) fail('duplicate V7 destination');
  if (files.filter((file) => file.modificationKind === 'adapted').length !== 2 || !['opencode/bridge.ts', 'pi/extensions/registry.ts'].every((name) => files.some((file) => file.destination.endsWith(name) && file.modificationKind === 'adapted'))) fail('V7 adapted files');
  const residual = new Map();
  for (const line of residualText.split('\n')) {
    const match = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (!match) continue;
    const key = JSON.stringify([`packages/daemon/${match[1]}`, +match[2], +match[3], match[4], match[5]]);
    if (residual.has(key)) fail(`duplicate sealed diagnostic ${key}`);
    residual.set(key, 0);
  }
  const hashes = {};
  let edits = 0;
  let editedFiles = 0;
  for (const row of files) {
    const file = row.destination;
    const current = readIntegrated(file);
    if (file.startsWith('packages/daemon/src/') && (/\bfrom\s*['"]pino['"]/.test(current) || current.includes('Promise.withResolvers'))) fail(`forbidden production dependency ${file}`);
    hashes[file] = digest(current);
    if (hashes[file] !== row.integratedSha256) fail(`integrated hash ${file}`);
    if (row.typeOnlyEdits) {
      const pre = readPre(file);
      if (digest(pre) !== sealedHashes[file]) fail(`sealed pre hash ${file}`);
      editedFiles++;
      edits += row.typeOnlyEdits.length;
      if (row.preTypeEditSha256 !== sealedHashes[file]) fail(`ledger pre hash ${file}`);
      replay(row, pre, current);
      for (const edit of row.typeOnlyEdits) {
        for (const diagnostic of edit.diagnostics) {
          const key = JSON.stringify([diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.code, diagnostic.message]);
          if (!residual.has(key)) fail(`unsealed diagnostic ${key}`);
          residual.set(key, residual.get(key) + 1);
        }
      }
    } else if (hashes[file] !== sealedHashes[file]) fail(`unledgered change ${file}`);
  }
  for (const [key, count] of residual) if (count !== 1) fail(`diagnostic ownership ${count} ${key}`);
  if (editedFiles !== 18 || edits !== 102 || residual.size !== 117) fail(`compiler count ${editedFiles}/${edits}/${residual.size}`);
  return { sealedResidualSha256: digest(residualText), files: files.length, editedFiles, edits, modificationNotices: editedFiles, ownedDiagnostics: residual.size, integratedHashes: hashes };
}

export async function runVerification() {
  const closure = JSON.parse(readFileSync(closurePath, 'utf8'));
  const sealedHashes = JSON.parse(readFileSync(resolve(sealedRoot, 'pre-type-hashes.json'), 'utf8'));
  const residualText = readFileSync(residualPath, 'utf8');
  const report = verifyStatic({ closure, sealedHashes, residualText, readPre, readIntegrated: (file) => readFileSync(resolve(root, file), 'utf8') });
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
  const check = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'packages/daemon'], { cwd: root, encoding: 'utf8' });
  if (check.status !== 0 || check.stdout.trim() || check.stderr.trim()) fail(`daemon tsc diagnostics or failure: ${check.stdout}${check.stderr}`);
  const identity = await runIdentityProof();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ ...report, daemonTypecheck: 'PASS', typescriptVersion: ts.version, identity }, null, 2) + '\n');
  return report;
}

export function runStaticVerification() {
  const closure = JSON.parse(readFileSync(closurePath, 'utf8'));
  const sealedHashes = JSON.parse(readFileSync(resolve(sealedRoot, 'pre-type-hashes.json'), 'utf8'));
  const residualText = readFileSync(residualPath, 'utf8');
  return verifyStatic({ closure, sealedHashes, residualText, readPre, readIntegrated: (file) => readFileSync(resolve(root, file), 'utf8') });
}

export function runNegativeCases() {
  const testFile = 'packages/daemon/test/paseo/providers/acp-agent.test.ts';
  const bad = (name, action, expected) => {
    try { action(); } catch (error) {
      if (String(error).includes(expected)) return name;
      throw new Error(`${name}: failed through wrong rule: ${error}`);
    }
    fail(`${name}: accepted`);
  };
  const e4 = (insertedText, file = testFile) => validateE4({ insertedText, start: 1 }, file);
  const closure = JSON.parse(readFileSync(closurePath, 'utf8'));
  const acp = closure.v7.files.find((row) => row.destination === testFile);
  const historical = acp.typeOnlyEdits.find((edit) => edit.line === 3948 && edit.insertedText.includes(' as unknown'));
  const pre = readPre(testFile);
  const notice = { ...acp.modificationNotice, diagnostics: [{ code: 'TS2352' }] };
  const cases = [
    bad('N owns diagnostic', () => validateNotice(notice, testFile, pre, acp.typeOnlyEdits[0].start), 'N diagnostic ownership'),
    bad('authored object type', () => e4(' as { prompt: string }'), 'E4 object type'),
    bad('mapped type', () => e4(' as { [K in keyof T]: T[K] }'), 'E4 forbidden type node'),
    bad('E4 trailing statement', () => e4(' as string; const extra = 0'), 'E4 trailing syntax'),
    bad('E4 changed base expression', () => e4(' as string + extra'), 'E4 expected assertion'),
    bad('E4 typeof type arguments', () => e4(' as typeof fn<{ p: string }>'), 'E4 forbidden typeof argument'),
    bad('any type in edit', () => e4(' as any'), 'E4 any type'),
    bad('E4 in production', () => e4(' as string', 'packages/daemon/src/agent/providers/acp-agent.ts'), 'E4 production path'),
    bad('missing TS2352 evidence', () => validateUnknownBridge({ ...historical, ts2352Evidence: undefined }, testFile, pre), 'missing TS2352 evidence'),
    bad('changed TS2352 evidence bytes', () => validateUnknownBridge(historical, testFile, pre, () => 'changed log bytes'), 'TS2352 evidence hash'),
    bad('wrong TS2352 evidence path', () => validateUnknownBridge({ ...historical, ts2352Evidence: 'packages/daemon/test/fixtures/v7-compiler-closure/typecheck-02.txt' }, testFile, pre), 'TS2352 evidence path'),
    bad('wrong TS2352 proof position', () => assertTS2352Diagnostic(readFileSync(resolve(root, historical.ts2352Evidence), 'utf8'), { file: testFile, line: 3948, column: 22 }, undefined, testFile, historical.start), 'TS2352 evidence position'),
    bad('any outside edit', () => assertSyntaxIdentity('x.ts', 'const x: string = value;', 'const x: any = value;'), 'type or directive increase'),
    bad('TypeScript suppression comment', () => assertSyntaxIdentity('x.ts', 'const x = value;', '// @ts-expect-error\nconst x = value;'), 'type or directive increase'),
    bad('lint suppression comment', () => assertSyntaxIdentity('x.ts', 'const x = value;', '/* eslint-disable */\nconst x = value;'), 'type or directive increase'),
  ];
  return cases;
}

export async function runIdentityProof() {
  const closure = JSON.parse(readFileSync(closurePath, 'utf8'));
  const options = { loader: 'ts', format: 'esm', target: 'es2022', minify: false, sourcemap: false,
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false, useDefineForClassFields: true } } };
  const files = [];
  for (const row of closure.v7.files.filter((file) => file.typeOnlyEdits)) {
    const pre = readPre(row.destination);
    const integrated = readFileSync(resolve(root, row.destination), 'utf8');
    if (digest(pre) !== row.preTypeEditSha256 || digest(integrated) !== row.integratedSha256) fail(`identity source hash ${row.destination}`);
    replay(row, pre, integrated);
    const [before, after] = await Promise.all([transform(pre, options), transform(integrated, options)]);
    if (before.code !== after.code) fail(`emitted JavaScript changed ${row.destination}`);
    const javascriptSha256 = digest(before.code);
    if (row.destination.endsWith('/pi/cli-runtime.ts') && javascriptSha256 !== '6ba7037950e08952b5b8a9100430c9cf545dad0e56cc84d33b8f7f0c28697559') fail(`Pi shorthand JavaScript hash ${javascriptSha256}`);
    files.push({ file: row.destination, preTypeEditSha256: row.preTypeEditSha256, integratedSha256: row.integratedSha256, javascriptSha256 });
  }
  mkdirSync(dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, JSON.stringify({ esbuildVersion, options, files }, null, 2) + '\n');
  return { esbuildVersion, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--self-test')) console.log(JSON.stringify({ negativeCases: runNegativeCases() }));
    else if (process.argv.includes('--static')) console.log(JSON.stringify(runStaticVerification()));
    else if (process.argv.includes('--identity')) console.log(JSON.stringify(await runIdentityProof()));
    else console.log(JSON.stringify(await runVerification()));
  }
  catch (error) { console.error(error); process.exitCode = 1; }
}
