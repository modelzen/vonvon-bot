import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const daemonRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(daemonRoot, 'src/agent/paseo/closure.json');
type Entry = { destination: string; integratedSha256: string; source: string; sha256: string };
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  pin: string; authorization: string; files: Entry[]; addedFiles: { destination: string }[];
  tests: { source: string; state: string; reason: string; destination?: string; integratedSha256?: string }[];
};
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const imports = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
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
    const destinations = new Set([...manifest.files, ...manifest.addedFiles].map((entry) => resolve(daemonRoot, '../..', entry.destination)));
    const actual = [
      ...sourceFiles(resolve(daemonRoot, 'src/agent/paseo')),
      ...sourceFiles(resolve(daemonRoot, 'src/agent/providers')),
    ];
    expect(new Set(actual)).toEqual(destinations);
    for (const file of manifest.files) {
      const path = resolve(daemonRoot, '../..', file.destination);
      const text = readFileSync(path, 'utf8');
      expect(text).not.toMatch(/@getpaseo\/|from\s+['"]pino['"]|provider-subagents\/store\.js/);
      for (const match of text.matchAll(imports)) {
        const spec = match[1] ?? match[2];
        if (!spec?.startsWith('.')) continue;
        const target = resolve(dirname(path), spec.replace(/\.js$/, '.ts'));
        expect(destinations.has(target), `${file.destination} -> ${spec}`).toBe(true);
      }
    }
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
});
