import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { installBackendDep } from '../src/agent/installer';
import { paths } from '../src/config/paths';

const spawned = vi.hoisted((): { child?: EventEmitter } => ({}));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: () => spawned.child }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));

it.each(['live child kill failure', 'spawn failure'])('waits for close before rollback after %s', async kind => {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-installer-shutdown-'));
  const previous = { backendsDir: paths.backendsDir, npmCacheDir: paths.npmCacheDir };
  Object.assign(paths, { backendsDir: home, npmCacheDir: join(home, 'cache') });
  await mkdir(join(home, 'node_modules', 'fake'), { recursive: true });
  await writeFile(join(home, 'node_modules', 'fake', 'owned'), 'live');
  await writeFile(join(home, 'package.json'), JSON.stringify({ dependencies: { fake: '1' } }));
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  spawned.child = child;
  const settled = vi.fn();
  const result = installBackendDep('fake').then(value => { settled(); return value; });
  try {
    await vi.waitFor(() => expect(child.listenerCount('error')).toBe(1));
    child.emit('error', new Error(kind));
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    expect(settled).not.toHaveBeenCalled();
    expect(await readFile(join(home, 'node_modules', 'fake', 'owned'), 'utf8')).toBe('live');
    child.emit('close', kind === 'spawn failure' ? -2 : 0);
    expect(await result).toMatchObject({ ok: false, tail: expect.stringContaining(kind) });
    await expect(readFile(join(home, 'node_modules', 'fake', 'owned'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(home, 'package.json'), 'utf8')).dependencies).toEqual({});
  } finally { child.emit('close', 1); await result; Object.assign(paths, previous); await rm(home, { recursive: true, force: true }); }
});
