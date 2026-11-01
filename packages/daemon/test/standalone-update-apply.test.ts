import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const appDir = mkdtempSync(joinPath(tmpdir(), 'vonvon-standalone-apply-'));
  return { paths: { appDir, secretsGetterScript: joinPath(appDir, 'secrets-getter') } };
});

import { paths } from '../src/config/paths';
import { getterContents } from '../src/config/data-compatibility';
import { readCurrent, switchCurrent } from '../src/service/current-release';
import { observeShutdown } from '../src/host/lifecycle';
import { RESTART_PENDING_MS, settleUpdateAtStartup, startStandaloneUpdate, type ApplyDeps } from '../src/service/standalone-update';
import { abandonOwnedUpdate, acquireUpdateLock, readUpdateStatus, UpdateBusyError, writeUpdateStatus, type UpdateStatus } from '../src/service/update';
import { BASE, fakeCdn, manifestPayload, signManifest, testKeys } from './helpers/fake-cdn';
import { packRelease } from './helpers/fake-release';

// main 必败: applyCoreUpdate refused every install but global npm (server-3 4.5)
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));
const keys = testKeys();
let count = 0;
const packages = new Map<string, Awaited<ReturnType<typeof packRelease>>>();
const pack = async (version: string) => packages.get(version) ?? packages.set(version, await packRelease(paths.appDir, version)).get(version)!;
const URL_1_0_1 = `${BASE}/1.0.1/vonvon-server-1.0.1-linux-x64.tar.gz`;

async function setup() {
  const installRoot = join(paths.appDir, `install-${++count}`);
  await mkdir(join(installRoot, 'releases', '1.0.0', 'app', 'bin'), { recursive: true });
  await writeFile(join(installRoot, 'releases', '1.0.0', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.0' }));
  await switchCurrent(installRoot, '1.0.0', 'linux');
  const pkg = await pack('1.0.1');
  const cdn = fakeCdn();
  cdn.routes.set(`${BASE}/stable/manifest.json`, { body: signManifest(manifestPayload('1.0.1', 10, { 'linux-x64': { sha512: pkg.sha512, size: pkg.size } }), keys.privateKey) });
  cdn.routes.set(URL_1_0_1, { body: pkg.bytes });
  const restarts: UpdateStatus[] = [];
  const deps: ApplyDeps = {
    installRoot, currentVersion: '1.0.0', config: () => keys.config, fetch: cdn.fetch, platform: 'linux', arch: 'x64',
    requestRestart: status => { restarts.push(status); },
  };
  return { installRoot, cdn, deps, restarts };
}
const details = (statuses: UpdateStatus[]) => statuses.map(status => status.detail ?? status.phase);

beforeEach(() => { rmSync(join(paths.appDir, 'update-status.json'), { force: true }); rmSync(join(paths.appDir, 'update.lock'), { force: true }); });

describe('startStandaloneUpdate', () => {
  it('downloads, checks, unpacks, switches current, records previous and only then restarts', async () => {
    const { installRoot, deps, restarts } = await setup();
    const statuses: UpdateStatus[] = [];
    const job = startStandaloneUpdate({}, { ...deps, onStatus: status => { statuses.push(status); }, requestRestart: status => {
      expect(readUpdateStatus()).toEqual(status);
      expect(existsSync(join(paths.appDir, 'update.lock'))).toBe(false);
      deps.requestRestart?.(status);
    } });
    expect(readUpdateStatus()).toMatchObject({ phase: 'installing', from: '1.0.0', detail: 'downloading' });
    const final = await job.done;
    expect(details(statuses)).toEqual(['downloading', 'verifying', 'unpacking', 'switching', 'draining']);
    expect(final).toMatchObject({ phase: 'restarting', from: '1.0.0', to: '1.0.1', previous: '1.0.0', detail: 'draining' });
    expect(restarts).toEqual([final]);
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.1');
    expect(await readdir(join(installRoot, 'releases'))).toEqual(['1.0.0', '1.0.1']);
    expect(existsSync(join(paths.appDir, 'update.lock'))).toBe(false);
  });
  it('drops a download that does not match the manifest and leaves current alone', async () => {
    const { installRoot, deps, cdn, restarts } = await setup();
    const changed = Buffer.from((await pack('1.0.1')).bytes);
    changed.writeUInt8(changed.readUInt8(changed.length >> 1) ^ 0xff, changed.length >> 1);
    cdn.routes.set(URL_1_0_1, { body: changed });
    expect(await startStandaloneUpdate({}, deps).done).toMatchObject({ phase: 'error', message: '下载内容和发布清单不一致' });
    expect(existsSync(join(installRoot, 'releases', '1.0.1.part'))).toBe(false);
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.0');
    expect(restarts).toEqual([]);
  });
  it('refuses a length the manifest does not give without reading the body', async () => {
    const { deps, cdn } = await setup();
    let read = false;
    cdn.routes.set(URL_1_0_1, { body: (await pack('1.0.1')).bytes, headers: { 'content-length': '7' } });
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const response = await cdn.fetch(url);
      if (String(url) !== URL_1_0_1) return response;
      return new Response(new ReadableStream({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 }), { status: 200, headers: response.headers });
    };
    expect(await startStandaloneUpdate({}, { ...deps, fetch: fetcher }).done).toMatchObject({ phase: 'error', message: '下载的大小和发布清单不一致' });
    expect(read).toBe(false);
  });
  it('refuses while another update holds the lock', async () => {
    const { deps } = await setup();
    const release = acquireUpdateLock();
    try { expect(() => startStandaloneUpdate({}, deps)).toThrow(UpdateBusyError); }
    finally { release?.(); }
  });
  it('says already current and lets the lock go', async () => {
    const { deps } = await setup();
    expect(await startStandaloneUpdate({}, { ...deps, currentVersion: '1.0.1' }).done).toMatchObject({ phase: 'done', message: '已是最新' });
    expect(existsSync(join(paths.appDir, 'update.lock'))).toBe(false);
  });
  it('goes back only to a release kept here, without downloading', async () => {
    const { installRoot, deps, cdn, restarts } = await setup();
    await mkdir(join(installRoot, 'releases', '0.9.0'), { recursive: true });
    await writeFile(join(installRoot, 'releases', '0.9.0', 'standalone.json'), JSON.stringify({ v: 1, version: '0.9.0' }));
    expect(await startStandaloneUpdate({ version: '0.8.0', allowDowngrade: true }, deps).done).toMatchObject({ phase: 'error', message: '本机没有 0.8.0，只能降到保留着的上一版 0.9.0。' });
    const down = await startStandaloneUpdate({ version: '0.9.0', allowDowngrade: true }, deps).done;
    expect(down).toMatchObject({ phase: 'restarting', to: '0.9.0', previous: '1.0.0' });
    expect(cdn.requests).toEqual([]);
    expect(restarts).toHaveLength(1);
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/0.9.0');
  });
  it('leaves a half-unpacked release after a crash, and the next run clears it before downloading again', async () => {
    const { installRoot, deps, cdn } = await setup();
    const crashed = await startStandaloneUpdate({}, { ...deps, extract: async (_archive, into) => { await writeFile(join(into, 'half'), ''); throw new Error('power cut'); } }).done;
    expect(crashed).toMatchObject({ phase: 'error' });
    expect(await readdir(join(installRoot, 'releases', '1.0.1.part'))).toContain('half');
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.0');
    await startStandaloneUpdate({}, deps).done;
    expect(cdn.requests.filter(url => url === URL_1_0_1)).toHaveLength(2);
    expect(existsSync(join(installRoot, 'releases', '1.0.1.part'))).toBe(false);
    expect(existsSync(join(installRoot, 'releases', '1.0.1', 'half'))).toBe(false);
  });
  it('takes the zip on Windows and switches current.txt', async () => {
    const { installRoot, deps, cdn } = await setup();
    await rm(join(installRoot, 'current'));
    await switchCurrent(installRoot, '1.0.0', 'win32');
    const zip = await packRelease(paths.appDir, '1.0.1', true);
    cdn.routes.set(`${BASE}/stable/manifest.json`, { body: signManifest(manifestPayload('1.0.1', 10, { 'win-x64': { sha512: zip.sha512, size: zip.size } }), keys.privateKey) });
    cdn.routes.set(`${BASE}/1.0.1/vonvon-server-1.0.1-win-x64.zip`, { body: zip.bytes });
    expect(await startStandaloneUpdate({}, { ...deps, platform: 'win32' }).done).toMatchObject({ phase: 'restarting', to: '1.0.1', previous: '1.0.0' });
    expect(await readFile(join(installRoot, 'current.txt'), 'utf8')).toBe('1.0.1\n1.0.0\n');
  });
  it('ends at the switch when no daemon restarts it (the CLI with the daemon stopped)', async () => {
    const { deps } = await setup();
    const { requestRestart: _restart, ...local } = deps;
    expect(await startStandaloneUpdate({}, local).done).toMatchObject({ phase: 'done', to: '1.0.1', previous: '1.0.0', message: '已切到 1.0.1，运行 vonvon daemon start 生效。' });
  });
  // review F1, I3-SEC-1: a second update overwrote the record the restart helper rolls back by
  it('refuses another update while the last one waits for its restart, and lets a stale one go', async () => {
    const { deps } = await setup();
    const first = await startStandaloneUpdate({}, deps).done;
    expect(first).toMatchObject({ phase: 'restarting', to: '1.0.1', previous: '1.0.0' });
    expect(() => startStandaloneUpdate({}, { ...deps, currentVersion: '1.0.1' })).toThrow(UpdateBusyError);
    expect(() => startStandaloneUpdate({ version: '1.0.0', allowDowngrade: true }, deps)).toThrow(UpdateBusyError);
    expect(readUpdateStatus()).toEqual(first);
    expect(existsSync(join(paths.appDir, 'update.lock'))).toBe(false);
    // Long past: its helper is gone, unless a daemon still holds the pid lock (one starting).
    writeUpdateStatus({ ...first, at: Date.now() - RESTART_PENDING_MS - 1 });
    expect(() => startStandaloneUpdate({}, { ...deps, currentVersion: '1.0.1', ownerAlive: true })).toThrow(UpdateBusyError);
    expect(await startStandaloneUpdate({}, { ...deps, currentVersion: '1.0.1' }).done).toMatchObject({ phase: 'done', message: '已是最新' });
    // Taken by the helper (`waiting`), it is the helper's lock that holds updates off: with the lock free, the helper is gone.
    writeUpdateStatus({ ...first, detail: 'waiting', at: Date.now() });
    expect(await startStandaloneUpdate({}, { ...deps, currentVersion: '1.0.1' }).done).toMatchObject({ phase: 'done', message: '已是最新' });
  });
  it('starts no update once the daemon stops or restarts, and does not switch when that comes during the download', async () => {
    const { installRoot, deps, restarts } = await setup();
    expect(() => startStandaloneUpdate({}, { ...deps, stopping: () => true })).toThrow(UpdateBusyError);
    let stopping = false;
    const ended = await startStandaloneUpdate({}, { ...deps, stopping: () => stopping, onStatus: status => { if (status.detail === 'unpacking') stopping = true; } }).done;
    expect(ended).toMatchObject({ phase: 'error', to: '1.0.1' });
    expect(ended.message).toContain('没有切换版本');
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.0');
    expect(restarts).toEqual([]);
    // The download is kept: the next update switches to it without fetching it again.
    expect(await readdir(join(installRoot, 'releases'))).toEqual(['1.0.0', '1.0.1']);
  });
  // review F2: a stop during the drain left `current` on the new release while the record said it was cancelled
  it('switches current back when a stop cancels the restart', async () => {
    const { installRoot, deps } = await setup();
    const control = observeShutdown(false, { installRoot: async () => installRoot });
    try {
      await startStandaloneUpdate({}, { ...deps, requestRestart: status => { control.requestStop(); control.requestRestart(43119, status); } }).done;
      await control.completeShutdown(async () => {
        expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.0');
      });
      expect(readUpdateStatus()).toMatchObject({ phase: 'error', to: '1.0.1', rolledBack: true, message: '重启已被停止取消，已切回 1.0.0' });
    } finally { control.dispose(); }
  });
  it('only ends the record of an update that never switched current', async () => {
    const record: UpdateStatus = { phase: 'restarting', ok: true, from: '1', to: '2', at: 4 };
    writeUpdateStatus(record);
    await abandonOwnedUpdate(record, 'helper_lost', async () => { throw new Error('not asked'); });
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: 'helper_lost' });
  });
  // review F3, I3-SEC-1: `previous` was whatever `current` named, which can be the target itself
  it('records the running release as previous even when current already names the target', async () => {
    const { installRoot, deps } = await setup();
    await startStandaloneUpdate({}, { ...deps, requestRestart: undefined }).done;
    rmSync(join(paths.appDir, 'update-status.json'), { force: true });
    expect(await startStandaloneUpdate({}, deps).done).toMatchObject({ phase: 'restarting', from: '1.0.0', to: '1.0.1', previous: '1.0.0' });
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.1');
  });
  it('keeps the running release as the fallback in current.txt when switching to the release current.txt already names', async () => {
    const { installRoot, deps } = await setup();
    await rm(join(installRoot, 'current'));
    await cp(join(installRoot, 'releases', '1.0.0'), join(installRoot, 'releases', '1.0.1'), { recursive: true });
    await writeFile(join(installRoot, 'releases', '1.0.1', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.1' }));
    await writeFile(join(installRoot, 'current.txt'), '1.0.1\n1.0.0\n');
    expect(await startStandaloneUpdate({ version: '1.0.1', allowDowngrade: true }, { ...deps, platform: 'win32' }).done).toMatchObject({ phase: 'restarting', previous: '1.0.0' });
    expect(await readCurrent(installRoot, 'win32')).toEqual({ version: '1.0.1', previous: '1.0.0' });
  });
  it('does not drain to go to the version already running', async () => {
    const { deps, restarts } = await setup();
    expect(await startStandaloneUpdate({ version: '1.0.0', allowDowngrade: true }, deps).done).toMatchObject({ phase: 'done', ok: true, message: '已经是 1.0.0，不用切换。' });
    expect(restarts).toEqual([]);
  });
  // review F7, I3-SEC-2: an error the user reads carried the install root's path
  it('names a file system error by its code, not by a path', async () => {
    const { deps } = await setup();
    const ended = await startStandaloneUpdate({}, { ...deps, extract: async () => { throw Object.assign(new Error(`ENOSPC: no space left, write '${paths.appDir}/x'`), { code: 'ENOSPC' }); } }).done;
    expect(ended).toMatchObject({ phase: 'error', message: '更新失败：ENOSPC' });
  });
});

describe('settleUpdateAtStartup', () => {
  it('marks an install nobody holds as cut short', async () => {
    writeUpdateStatus({ phase: 'installing', from: '1.0.0', at: 5, detail: 'unpacking' });
    await writeFile(join(paths.appDir, 'update.lock'), JSON.stringify({ pid: 2 ** 31 - 2, at: 1 }));
    await settleUpdateAtStartup({ version: '1.0.0' });
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '上次更新中断' });
  });
  it('ends the restart that brought this version up, or says it is still the old one', async () => {
    const { installRoot } = await setup();
    await cp(join(installRoot, 'releases', '1.0.0'), join(installRoot, 'releases', '1.0.1'), { recursive: true });
    await writeFile(join(installRoot, 'releases', '1.0.1', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.1' }));
    await switchCurrent(installRoot, '1.0.1', 'linux');
    const record: UpdateStatus = { phase: 'restarting', ok: true, from: '1.0.0', to: '1.0.1', previous: '1.0.0', at: 7, detail: 'draining' };
    writeUpdateStatus(record);
    await settleUpdateAtStartup({ version: '1.0.1', installRoot, platform: 'linux', pause: async () => {} });
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '1.0.1' });
    expect(readUpdateStatus()?.detail).toBeUndefined();
    writeUpdateStatus(record);
    await settleUpdateAtStartup({ version: '1.0.0', installRoot, platform: 'linux', pause: async () => {} });
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启后仍是 1.0.0' });
    writeUpdateStatus(record);
    await switchCurrent(installRoot, '1.0.0', 'linux');
    await settleUpdateAtStartup({ version: '1.0.1', installRoot, platform: 'linux', pause: async () => {} });
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '升级和回滚撞上了，当前运行 1.0.1' });
    expect(JSON.parse(await readFile(join(installRoot, 'releases', '1.0.1', 'standalone.json'), 'utf8'))).toMatchObject({ version: '1.0.1' });
  });
  // review 207: the getter wrapper named the release the Bot was created on, which the second update's cleanup removed
  it('keeps the secrets getter working for outside callers after two updates', async () => {
    const { installRoot } = await setup();
    for (const version of ['1.0.0', '1.0.1', '1.0.2']) {
      const release = join(installRoot, 'releases', version);
      for (const dir of ['node/bin', 'app/bin']) await mkdir(join(release, dir), { recursive: true });
      await writeFile(join(release, 'standalone.json'), JSON.stringify({ v: 1, version }));
      await writeFile(join(release, 'app', 'bin', 'vonvon.mjs'), `process.stdout.write('${version} ' + process.argv.slice(2).join(' '));\n`);
      await symlink(process.execPath, join(release, 'node', 'bin', 'node'));
    }
    await writeFile(paths.secretsGetterScript, getterContents({ nodePath: join(installRoot, 'releases', '1.0.0', 'node', 'bin', 'node'), cliPath: join(installRoot, 'releases', '1.0.0', 'app', 'bin', 'vonvon.mjs') }, paths.appDir), { mode: 0o700 });
    await switchCurrent(installRoot, '1.0.1', 'linux').then(() => switchCurrent(installRoot, '1.0.2', 'linux'));
    writeUpdateStatus({ phase: 'done', ok: true, from: '1.0.1', to: '1.0.2', previous: '1.0.1', at: 9 });
    await settleUpdateAtStartup({ version: '1.0.2', installRoot, platform: 'linux' });
    expect((await readdir(join(installRoot, 'releases'))).sort()).toEqual(['1.0.1', '1.0.2']);
    expect(execFileSync(paths.secretsGetterScript, { encoding: 'utf8' })).toBe('1.0.2 secrets get');
  });
  // I3-SEC-1 (d): a record whose previous is the current release left releases/ with nothing to go back to
  it('keeps a release to go back to even when the record names the current one as previous', async () => {
    const { installRoot } = await setup();
    await cp(join(installRoot, 'releases', '1.0.0'), join(installRoot, 'releases', '1.0.1'), { recursive: true });
    await writeFile(join(installRoot, 'releases', '1.0.1', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.1' }));
    await switchCurrent(installRoot, '1.0.1', 'linux');
    writeUpdateStatus({ phase: 'done', ok: true, from: '1.0.0', to: '1.0.1', previous: '1.0.1', at: 8 });
    await settleUpdateAtStartup({ version: '1.0.1', installRoot, platform: 'linux' });
    expect((await readdir(join(installRoot, 'releases'))).sort()).toEqual(['1.0.0', '1.0.1']);
  });
});
