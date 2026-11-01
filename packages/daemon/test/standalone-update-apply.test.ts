import { existsSync, rmSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { paths: { appDir: mkdtempSync(joinPath(tmpdir(), 'vonvon-standalone-apply-')) } };
});

import { paths } from '../src/config/paths';
import { switchCurrent } from '../src/service/current-release';
import { settleUpdateAtStartup, startStandaloneUpdate, type ApplyDeps } from '../src/service/standalone-update';
import { acquireUpdateLock, readUpdateStatus, UpdateBusyError, writeUpdateStatus, type UpdateStatus } from '../src/service/update';
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
    await settleUpdateAtStartup({ version: '1.0.1', installRoot, platform: 'linux' });
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '1.0.1' });
    expect(readUpdateStatus()?.detail).toBeUndefined();
    writeUpdateStatus(record);
    await settleUpdateAtStartup({ version: '1.0.0', installRoot, platform: 'linux' });
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启后仍是 1.0.0' });
    writeUpdateStatus(record);
    await switchCurrent(installRoot, '1.0.0', 'linux');
    await settleUpdateAtStartup({ version: '1.0.1', installRoot, platform: 'linux' });
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '升级和回滚撞上了，当前运行 1.0.1' });
    expect(JSON.parse(await readFile(join(installRoot, 'releases', '1.0.1', 'standalone.json'), 'utf8'))).toMatchObject({ version: '1.0.1' });
  });
});
