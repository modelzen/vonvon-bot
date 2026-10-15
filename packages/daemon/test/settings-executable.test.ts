import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopSnapshot } from '@vonvon/protocol';
import { createHostSettings } from '../src/admin/host-settings';
import { readServiceCodexBin } from '../src/service/codex-bin';
import { settingsRpc } from '../src/server/rpc/settings';
import { fakeService } from './server-fixture';

const snapshot = {
  revision: 0, observedAt: 0, stale: false, host: { kind: 'starting' },
  agents: [], groups: [], memberships: [], tools: [], jobs: [],
  application: { platform: 'unsupported', version: 'test', loginItem: false, dataPath: '' },
} satisfies DesktopSnapshot;

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-executable-'));
  dirs.push(dir);
  const executable = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  const nonExecutable = join(dir, process.platform === 'win32' ? 'plain.txt' : 'plain');
  const link = join(dir, process.platform === 'win32' ? 'codex-link.exe' : 'codex-link');
  await writeFile(executable, '', { mode: 0o700 });
  await writeFile(nonExecutable, '', { mode: 0o600 });
  await symlink(executable, link);
  const settings = createHostSettings({ appDir: dir, runningCodexBin: executable });
  const service = fakeService({ settings: { ...settings, act: async () => { throw new Error('unused'); }, models: async () => { throw new Error('unused'); } } });
  const save = async (codexBin: string | null) => {
    const view = await settings.read({ kind: 'host' });
    if (!('runtime' in view)) throw new Error('Host view missing');
    const outcome = await settingsRpc(service, { type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: view.sections.execution.revision, patch: { codexBin } } });
    if (outcome.kind !== 'mutation') throw new Error('Saved reply missing');
    return outcome.reply(snapshot);
  };
  return { dir, executable, nonExecutable, link, save };
}

describe('host executable RPC', () => {
  it('records H3 bad path behavior before V4 validation', async () => {
    const f = await fixture();
    const settings = createHostSettings({ appDir: f.dir });
    const view = await settings.read({ kind: 'host' });
    if (!('runtime' in view)) throw new Error('Host view missing');
    const result = await settings.save({ scope: { kind: 'host' }, section: 'execution', revision: view.sections.execution.revision, patch: { codexBin: join(f.dir, 'missing') } });
    expect(result).toMatchObject({ kind: 'rejected', fields: [{ field: 'codexBin' }] });
    expect(readServiceCodexBin(f.dir)).toBeUndefined();
  });

  it('rejects invalid paths without writing and accepts executable, symlink, and default', async () => {
    const f = await fixture();
    for (const path of [join(f.dir, 'missing'), 'relative/codex', f.dir, f.nonExecutable]) {
      const reply = await f.save(path);
      expect(reply).toMatchObject({ kind: 'saved', result: { kind: 'rejected', fields: [{ field: 'codexBin' }] } });
      expect(readServiceCodexBin(f.dir)).toBeUndefined();
    }
    expect(await f.save(f.executable)).toMatchObject({ kind: 'saved', result: { kind: 'saved' } });
    expect(readServiceCodexBin(f.dir)).toBe(f.executable);
    expect(await f.save(f.link)).toMatchObject({ kind: 'saved', result: { kind: 'saved' } });
    expect(readServiceCodexBin(f.dir)).toBe(f.link);
    expect(await f.save(null)).toMatchObject({ kind: 'saved', result: { kind: 'saved' } });
    expect(readServiceCodexBin(f.dir)).toBeNull();
  });
});
