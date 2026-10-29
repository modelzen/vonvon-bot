import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { codexShellReadRoot } from '../src/agent/codex-appserver/workspace-policy';
const roots: string[] = [];
function runtime(name = 'powershell') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-shell-'))); roots.push(root);
  const dir = join(root, name); mkdirSync(dir);
  for (const name of ['pwsh.exe', 'pwsh.dll', 'System.Management.Automation.dll']) writeFileSync(join(dir, name), 'fixture');
  return { root, dir, shell: join(dir, 'pwsh.exe') };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('reads only a dedicated portable PowerShell installation, including its DLLs', () => {
  const f = runtime();
  expect(codexShellReadRoot(f.shell)).toEqual({ path: f.dir, kind: 'dir' });
});
it('never expands an arbitrary directory just because it contains a shell executable', () => {
  const f = runtime('Documents');
  expect(() => codexShellReadRoot(f.shell)).toThrow('运行时');
});
it('never grants a Codex credential directory or workspace ancestor as a runtime', () => {
  const f = runtime();
  vi.stubEnv('CODEX_HOME', f.dir);
  expect(() => codexShellReadRoot(f.shell)).toThrow('运行时');
  vi.unstubAllEnvs();
  expect(() => codexShellReadRoot(f.shell, [{ path: join(f.dir, 'project'), access: 'write' }])).toThrow('运行时');
});
