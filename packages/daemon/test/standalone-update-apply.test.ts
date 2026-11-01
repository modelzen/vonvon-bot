import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { readCurrent, switchCurrent } from '../src/service/current-release';
import { RESTART_PENDING_MS, startStandaloneUpdate, type ApplyDeps } from '../src/service/standalone-update';
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
/** The update code as the daemon of another data directory runs it, on the same install root (the check after review 207). */
async function dataDirectory(): Promise<typeof import('../src/service/standalone-update')> {
  const appDir = mkdtempSync(join(paths.appDir, 'data-'));
  vi.resetModules();
  vi.doMock('../src/config/paths', () => ({ paths: { appDir, secretsGetterScript: join(appDir, 'secrets-getter') } }));
  try { return await import('../src/service/standalone-update'); }
  finally { vi.doMock('../src/config/paths', () => ({ paths })); vi.resetModules(); }
}

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
  // the check after review 207: daemons of other data directories share releases/, and each update held only its own update.lock
  it('lets one update at a time write into releases/, whichever data directory asks', async () => {
    const { installRoot, deps } = await setup();
    const first = (await dataDirectory()).startStandaloneUpdate({}, { ...deps, requestRestart: undefined });
    // Before: this one cleared the other's releases/1.0.1.part, and the other's unpacking crashed on ENOENT.
    expect(() => startStandaloneUpdate({}, deps)).toThrow(UpdateBusyError);
    expect(await first.done).toMatchObject({ phase: 'done', to: '1.0.1' });
    expect(existsSync(join(installRoot, 'releases.lock'))).toBe(false);
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
