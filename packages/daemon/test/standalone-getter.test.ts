import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// Review 221: the cleanup of releases/ must never break a persisted secrets getter, the getter of a data directory
// whose daemon does not run included, whatever the install root's path holds.
const state = vi.hoisted(() => ({ appDir: '/nonexistent-vonvon-getter-test', afterRead: undefined as undefined | (() => Promise<unknown>) }));
vi.mock('../src/config/paths', async () => {
  const { join: joinPath } = await import('node:path');
  return { paths: { get appDir() { return state.appDir; }, get secretsGetterScript() { return joinPath(state.appDir, 'secrets-getter'); } } };
});
// What another data directory's update does between this daemon's read of `current` and its cleanup.
vi.mock('../src/service/current-release', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/service/current-release')>();
  return { ...actual, readCurrent: async (...args: Parameters<typeof actual.readCurrent>) => {
    const read = await actual.readCurrent(...args);
    const meanwhile = state.afterRead;
    state.afterRead = undefined;
    await meanwhile?.();
    return read;
  } };
});

import { getterContents } from '../src/config/data-compatibility';
import { ensureSecretsGetterWrapper } from '../src/config/store';
import { switchCurrent } from '../src/service/current-release';
import { settleUpdateAtStartup } from '../src/service/standalone-update';
import { writeUpdateStatus } from '../src/service/update';

const root = mkdtempSync(join(tmpdir(), 'vonvon-getter-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;

/** Names a shell would split, expand or end a quote at. No `\`: Node refuses an ES module entry whose path holds one, getter or not. */
const NASTY = [`it's`, `'`, `two  spaces`, `$HOME $(id) \${x}`, 'back`id`tick', `new\nline`, `trailing\n`, `"dq"`, `semi;amp&pipe|<>`, `glob*?[a]~`, `-dash`];

/** releases/<version> whose Node is this one and whose entry prints the version, its arguments and VONVON_HOME. */
async function release(installRoot: string, version: string): Promise<void> {
  const dir = join(installRoot, 'releases', version);
  for (const sub of ['node/bin', 'app/bin']) await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, 'standalone.json'), JSON.stringify({ v: 1, version }));
  await writeFile(join(dir, 'app', 'bin', 'vonvon.mjs'), `process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), home: process.env.VONVON_HOME }));\n`);
  await symlink(process.execPath, join(dir, 'node', 'bin', 'node'));
}
/** An install root and two data directories under a directory named `name`, with the given releases. */
async function install(name: string, versions: string[]): Promise<{ installRoot: string; a: string; b: string }> {
  const base = join(root, `case-${++count}`, name);
  const installRoot = join(base, 'server');
  for (const version of versions) await release(installRoot, version);
  const a = join(base, 'data A');
  const b = join(base, 'data B');
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  return { installRoot, a, b };
}
/** Runs a data directory's getter as lark-cli does: by its path, with arguments, no shell between. */
const runGetter = (appDir: string): unknown => JSON.parse(execFileSync(join(appDir, 'secrets-getter'), ['one two', `it's`], { encoding: 'utf8' }));
const ran = (version: string, appDir: string) => ({ version, args: ['secrets', 'get', 'one two', `it's`], home: appDir });
/** The getter a standalone build before I3b wrote: its own release, by its versioned path. */
const legacyGetter = (installRoot: string, version: string, appDir: string): string =>
  getterContents({ nodePath: join(installRoot, 'releases', version, 'node', 'bin', 'node'), cliPath: join(installRoot, 'releases', version, 'app', 'bin', 'vonvon.mjs') }, appDir);

it('writes a getter that runs current for any install root and data directory path', async () => {
  for (const name of NASTY) {
    const { installRoot, a } = await install(name, ['1.0.0', '1.0.1']);
    await switchCurrent(installRoot, '1.0.1', 'linux');
    state.appDir = a;
    await ensureSecretsGetterWrapper(installRoot);
    expect(runGetter(a), JSON.stringify(name)).toEqual(ran('1.0.1', a));
    await switchCurrent(installRoot, '1.0.0', 'linux');
    expect(runGetter(a), JSON.stringify(name)).toEqual(ran('1.0.0', a));
  }
});

// Codex 221 P2 (2): the move onto `current` looked for the unquoted install root in the getter's text
it('moves an older getter onto current before the cleanup removes its release, whatever the path holds', async () => {
  for (const name of NASTY) {
    const { installRoot, a } = await install(name, ['1.0.0', '1.0.1', '1.0.2']);
    state.appDir = a;
    await writeFile(join(a, 'secrets-getter'), legacyGetter(installRoot, '1.0.0', a), { mode: 0o700 });
    expect(runGetter(a)).toEqual(ran('1.0.0', a));
    await switchCurrent(installRoot, '1.0.2', 'linux');
    writeUpdateStatus({ phase: 'done', ok: true, from: '1.0.1', to: '1.0.2', previous: '1.0.1', at: 9 });
    await settleUpdateAtStartup({ version: '1.0.2', installRoot, platform: 'linux' });
    // Before, with a `'` in the path: the getter still named 1.0.0, which the cleanup removed; it exited non-zero.
    expect((await readdir(join(installRoot, 'releases'))).sort(), JSON.stringify(name)).toEqual(['1.0.1', '1.0.2']);
    expect(runGetter(a), JSON.stringify(name)).toEqual(ran('1.0.2', a));
  }
});

it('removes no release while the getter of this data directory could not be moved onto current', async () => {
  const { installRoot, a } = await install('plain', ['1.0.0', '1.0.1', '1.0.2']);
  state.appDir = a;
  await writeFile(join(a, 'secrets-getter'), legacyGetter(installRoot, '1.0.0', a), { mode: 0o700 });
  await mkdir(join(a, `secrets-getter.tmp-${process.pid}`)); // the rewrite's temporary file cannot be written
  await switchCurrent(installRoot, '1.0.2', 'linux');
  writeUpdateStatus({ phase: 'done', ok: true, from: '1.0.1', to: '1.0.2', previous: '1.0.1', at: 9 });
  await settleUpdateAtStartup({ version: '1.0.2', installRoot, platform: 'linux' });
  // Before: the failed rewrite was logged and the cleanup went on to remove 1.0.0, which the getter still names.
  expect((await readdir(join(installRoot, 'releases'))).sort()).toEqual(['1.0.0', '1.0.1', '1.0.2']);
  expect(runGetter(a)).toEqual(ran('1.0.0', a));
});

// Codex 221 P2 (1): a data directory whose daemon does not run keeps its getter through other data directories' updates
it('keeps the getter of a data directory whose daemon does not run working through two updates of another', async () => {
  const { installRoot, a, b } = await install(`installer's root`, ['1.0.0', '1.0.1', '1.0.2']);
  await switchCurrent(installRoot, '1.0.0', 'linux');
  state.appDir = b;
  await ensureSecretsGetterWrapper(installRoot);
  expect(await readFile(join(b, 'secrets-getter'), 'utf8')).not.toContain('releases');
  state.appDir = a;
  await switchCurrent(installRoot, '1.0.1', 'linux').then(() => switchCurrent(installRoot, '1.0.2', 'linux'));
  writeUpdateStatus({ phase: 'done', ok: true, from: '1.0.1', to: '1.0.2', previous: '1.0.1', at: 9 });
  await settleUpdateAtStartup({ version: '1.0.2', installRoot, platform: 'linux' });
  expect((await readdir(join(installRoot, 'releases'))).sort()).toEqual(['1.0.1', '1.0.2']);
  expect(runGetter(b)).toEqual(ran('1.0.2', b));
});

it('keeps the release current names when another data directory switched it after this daemon read it', async () => {
  const { installRoot, a, b } = await install('switched meanwhile', ['1.0.0', '1.0.1', '1.0.2']);
  await switchCurrent(installRoot, '1.0.1', 'linux');
  state.appDir = b;
  await ensureSecretsGetterWrapper(installRoot);
  state.appDir = a;
  writeUpdateStatus({ phase: 'done', ok: true, from: '1.0.0', to: '1.0.1', previous: '1.0.0', at: 9 });
  state.afterRead = () => switchCurrent(installRoot, '1.0.2', 'linux');
  await settleUpdateAtStartup({ version: '1.0.1', installRoot, platform: 'linux' });
  expect(state.afterRead).toBeUndefined();
  // Before: the cleanup kept the 1.0.1 and 1.0.0 read before the switch and removed 1.0.2, which `current` named; the
  // getter of data directory B, and the service definitions, then ran nothing.
  expect((await readdir(join(installRoot, 'releases'))).sort()).toEqual(['1.0.0', '1.0.1', '1.0.2']);
  expect(runGetter(b)).toEqual(ran('1.0.2', b));
});
