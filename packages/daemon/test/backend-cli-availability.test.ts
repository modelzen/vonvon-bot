import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { isBackendEntryInstalled } from '../src/agent/backend-loader';
import { catalogById, isInstallable, projectCreatableBackends } from '../src/agent/catalog';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('keeps Claude selectable only while its external CLI exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'backend-cli-availability-'));
  roots.push(root);
  vi.stubEnv('PATH', root);
  const entry = catalogById('claude-agent');
  if (!entry) throw new Error('Missing Claude catalog entry');
  expect(entry.dep.kind).toBe('external-cli');
  expect(isInstallable(entry)).toBe(false);
  expect(isBackendEntryInstalled(entry)).toBe(false);
  const executable = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  writeFileSync(executable, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  expect(isBackendEntryInstalled(entry)).toBe(true);
  for (const mode of ['qa', 'write', 'full'] as const) {
    expect(projectCreatableBackends(mode, isBackendEntryInstalled).map(backend => backend.id))
      .toEqual(['codex-appserver', 'claude-agent']);
  }
  rmSync(executable);
  expect(projectCreatableBackends('full', isBackendEntryInstalled).map(backend => backend.id))
    .toEqual(['codex-appserver']);
});
