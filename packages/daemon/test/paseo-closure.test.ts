import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const daemonRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(daemonRoot, 'src/agent/paseo/closure.json');
type Entry = { destination: string; integratedSha256: string; source: string; sha256: string };
type V7Entry = {
  destination: string;
  integratedSha256: string;
  modificationKind: string;
  typeOnlyEdits?: { form: string; diagnostics: unknown[] }[];
  modificationNotice?: { form: string; insertedText: string };
};
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  pin: string; authorization: string; files: Entry[]; addedFiles: { destination: string; reason: string }[];
  tests: { source: string; state: string; reason: string; destination?: string; integratedSha256?: string }[];
  v7: { files: V7Entry[]; testCaseExclusions: unknown[] };
};
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const fixturePackages = new Set(['@opencode/client', 'pino']);
function moduleSpecifiers(file: string, text: string): string[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}
function checkCopiedImports(file: string, text: string, destinations: Set<string>, fixture: boolean): void {
  for (const spec of moduleSpecifiers(file, text)) {
    if (spec.startsWith('.')) {
      const source = resolve(daemonRoot, '../..', file);
      const target = resolve(dirname(source), spec.replace(/\.js$/, '.ts'));
      expect(destinations.has(target), `${file} -> ${spec}`).toBe(true);
    } else if (fixture) {
      expect(fixturePackages.has(spec), `${file} -> ${spec}`).toBe(true);
    } else {
      expect(spec.startsWith('@getpaseo/'), `${file} -> ${spec}`).toBe(false);
    }
  }
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('pinned Paseo import closure', () => {
  it('contains every listed file with its integrated digest', () => {
    expect(manifest.pin).toBe('0009a7e717a9f7ec587f55ca2985cb91b1310bd8');
    expect(manifest.authorization).toContain('97330b7');
    expect(manifest.files).toHaveLength(71);
    for (const file of manifest.files) {
      const path = resolve(daemonRoot, '../..', file.destination);
      expect(existsSync(path), file.destination).toBe(true);
      expect(hash(readFileSync(path)), file.destination).toBe(file.integratedSha256);
    }
  });

  it('resolves every local import inside the recorded closure', () => {
    const allCopied = [...manifest.files, ...manifest.v7.files];
    const destinations = new Set([...allCopied, ...manifest.addedFiles].map((entry) => resolve(daemonRoot, '../..', entry.destination)));
    const productionDestinations = new Set([...manifest.files, ...manifest.addedFiles, ...manifest.v7.files.filter((entry) => entry.destination.includes('/src/') && entry.destination.endsWith('.ts'))].map((entry) => resolve(daemonRoot, '../..', entry.destination)));
    const actual = [
      ...sourceFiles(resolve(daemonRoot, 'src/agent/paseo')),
      ...sourceFiles(resolve(daemonRoot, 'src/agent/providers')),
    ];
    expect(new Set(actual)).toEqual(productionDestinations);
    for (const file of allCopied) {
      const path = resolve(daemonRoot, '../..', file.destination);
      const text = readFileSync(path, 'utf8');
      if (file.destination.includes('/src/')) expect(text, file.destination).not.toMatch(/from\s+['"]pino['"]|provider-subagents\/store\.js/);
      const fixture = file.destination.includes('/test/') && !file.destination.endsWith('.test.ts');
      checkCopiedImports(file.destination, text, destinations, fixture);
    }
  });

  it('rejects excluded copied imports in tests, fixtures, and assets', () => {
    const destinations = new Set([...manifest.files, ...manifest.v7.files, ...manifest.addedFiles].map((entry) => resolve(daemonRoot, '../..', entry.destination)));
    expect(() => checkCopiedImports('packages/daemon/test/paseo/providers/pi/agent.test.ts', 'import "./excluded.js";', destinations, false)).toThrow();
    expect(() => checkCopiedImports('packages/daemon/test/paseo/test-utils/test-logger.ts', 'import "fs-extra";', destinations, true)).toThrow();
    expect(() => checkCopiedImports('packages/daemon/src/agent/providers/opencode/v2/bridge-plugin.mjs', 'import "./removed.mjs";', destinations, false)).toThrow();
  });

  it('keeps the pinned Windows launcher bytes', () => {
    for (const source of [
      'packages/plugin/src/server/process.ts',
      'packages/plugin/src/server/process-internal/windows-command.ts',
    ]) {
      const file = manifest.files.find((entry) => entry.source === source);
      expect(file).toBeDefined();
      expect(file!.integratedSha256).toBe(file!.sha256);
    }
  });

  it('ports every adjacent unit test whose imports remain in the closure', () => {
    const ported = manifest.tests.filter((entry) => entry.state === 'ported');
    expect(ported).toHaveLength(59);
    expect(manifest.tests.every((entry) => entry.state === 'ported' || entry.state === 'excluded')).toBe(true);
    for (const test of ported) {
      const path = resolve(daemonRoot, '../..', test.destination!);
      expect(existsSync(path), test.source).toBe(true);
      expect(hash(readFileSync(path)), test.source).toBe(test.integratedSha256);
    }
    for (const excluded of manifest.tests.filter((entry) => entry.state === 'excluded')) {
      expect(excluded.reason.length, excluded.source).toBeGreaterThan(0);
    }
  });

  it('records the V7 copied files, type edits, and retained test cases', () => {
    expect(manifest.v7.files).toHaveLength(76);
    expect(manifest.v7.testCaseExclusions).toHaveLength(16);
    const integrated = new Map(manifest.addedFiles.map((entry) => [entry.destination, entry.reason]));
    expect(integrated.get('packages/daemon/src/agent/paseo/runtime/server/paseo-home.ts')).toContain('Vonvon-owned resolvePaseoHome adapter');
    for (const leaf of ['acp-options.ts', 'jsonl-frame-decoder.ts', 'jsonl-rpc-process.ts']) {
      expect(integrated.get(`packages/daemon/src/agent/providers/${leaf}`)).toContain('Earlier V7 mechanical leaf copied from pinned Paseo');
    }
    expect(manifest.v7.files.filter((entry) => entry.modificationKind === 'adapted').map((entry) => entry.destination)).toEqual([
      'packages/daemon/src/agent/providers/opencode/bridge.ts',
      'packages/daemon/src/agent/providers/pi/extensions/registry.ts',
    ]);
    for (const file of manifest.v7.files) {
      const path = resolve(daemonRoot, '../..', file.destination);
      expect(existsSync(path), file.destination).toBe(true);
      expect(hash(readFileSync(path)), file.destination).toBe(file.integratedSha256);
    }
    const edited = manifest.v7.files.filter((entry) => entry.typeOnlyEdits);
    expect(edited).toHaveLength(18);
    expect(edited.reduce((count, entry) => count + entry.typeOnlyEdits!.length, 0)).toBe(102);
    expect(edited.every((entry) => entry.modificationNotice?.form === 'N')).toBe(true);
  });

  it('replays the sealed V7 ledger and rejects its own grammar counterexamples', () => {
    const verifier = resolve(daemonRoot, '../..', 'scripts/verify-type-ledger.mjs');
    const staticReport = JSON.parse(execFileSync(process.execPath, [verifier, '--static'], { cwd: resolve(daemonRoot, '../..'), encoding: 'utf8' })) as { files: number; edits: number; ownedDiagnostics: number };
    expect(staticReport).toMatchObject({ files: 76, edits: 102, ownedDiagnostics: 117 });
    const counterexamples = JSON.parse(execFileSync(process.execPath, [verifier, '--self-test'], { cwd: resolve(daemonRoot, '../..'), encoding: 'utf8' })) as { negativeCases: string[] };
    expect(counterexamples.negativeCases).toEqual([
      'N owns diagnostic', 'authored object type', 'mapped type', 'E4 trailing statement',
      'E4 changed base expression', 'E4 typeof type arguments', 'any type in edit', 'E4 in production',
      'missing TS2352 evidence', 'changed TS2352 evidence bytes', 'wrong TS2352 evidence path',
      'wrong TS2352 proof position',
      'any outside edit', 'TypeScript suppression comment', 'lint suppression comment',
    ]);
  });
});
