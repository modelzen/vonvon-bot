import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { paths: { appDir: mkdtempSync(joinPath(tmpdir(), 'vonvon-standalone-restart-')) } };
});

import { paths } from '../src/config/paths';
import { NEW_OWNER_MS, ROLLBACK_OWNER_MS, runSamePortRestartHelper, STARTING_OWNER_MS, STEADY_OWNER_MS, type RestartHelperDeps } from '../src/host/restart';
import { acquireUpdateLock, finishOwnedUpdate, readUpdateStatus, writeUpdateStatus, type UpdateStatus } from '../src/service/update';
import { settleUpdateAtStartup } from '../src/service/standalone-update';
import { switchCurrent } from '../src/service/current-release';
import { mkdir, writeFile } from 'node:fs/promises';
import type { PidLockInfo } from '../src/server/pid-lock';

// main 必败: the helper wrote done for any new PID, whatever version it ran, and never switched back (server-3 4.6)
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));
const ROOT = '/srv/vonvon-server';
const old: PidLockInfo = { pid: 100, startedAt: '2026-11-01T00:00:00.000Z', listen: '127.0.0.1:43119', version: '1.0.0' };
const owner = (version: string, pid = 200): PidLockInfo => ({ pid, startedAt: '2026-11-01T00:01:00.000Z', listen: '127.0.0.1:43119', version });
const record: UpdateStatus = { phase: 'restarting', ok: true, from: '1.0.0', to: '1.0.1', previous: '1.0.0', at: 9, detail: 'draining' };

function helper(locks: (clock: number, starts: number) => PidLockInfo | null, fields: Partial<RestartHelperDeps> = {}) {
  let clock = 0;
  let current = '1.0.1';
  const calls = { starts: [] as Array<[string, string[]]>, switches: [] as string[], cleanups: [] as string[][] };
  const deps: Partial<RestartHelperDeps> = {
    readLock: async () => locks(clock, calls.starts.length),
    running: () => true,
    verify: async () => {},
    start: async (file, args) => { calls.starts.push([file, args]); return 0; },
    now: () => clock,
    pause: async ms => { clock += ms; },
    installRoot: async () => ROOT,
    switchCurrent: async (_root, version) => { calls.switches.push(version); current = version; },
    readCurrentVersion: async () => current,
    rollsBack: true,
    cleanup: async (_root, keep) => { calls.cleanups.push(keep); },
    ...fields,
  };
  const run = (update: UpdateStatus | null = record) => runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt, ...(update ? { update } : {}) }, deps);
  return { run, calls, time: () => clock };
}

beforeEach(() => { writeUpdateStatus(record); rmSync(join(paths.appDir, 'update.lock'), { force: true }); });

describe('standalone update restart helper', () => {
  it('writes done when the replacement runs the new version', async () => {
    let reads = 0;
    const { run, calls } = helper(() => (++reads <= 3 ? old : owner('1.0.1')));
    await run();
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '1.0.1' });
    expect(calls.starts).toEqual([]);
    expect(calls.switches).toEqual([]);
    expect(calls.cleanups).toEqual([['1.0.1', '1.0.0']]);
  });
  it('starts the release current points at, not its own entry', async () => {
    let gone = false;
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.1') : gone ? null : (gone = true, old)));
    await run();
    expect(calls.starts).toEqual([[join(ROOT, 'releases', '1.0.1', 'node', 'bin', 'node'), [join(ROOT, 'releases', '1.0.1', 'app', 'bin', 'vonvon.mjs'), 'daemon', 'start', '--port', '43119']]]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'done' });
  });
  it('switches back when the replacement runs another version', async () => {
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.0') : null));
    await run();
    expect(calls.switches).toEqual(['1.0.0']);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true, message: '重启后运行的是 1.0.0，已切回 1.0.0' });
  });
  it('switches back after 60 s without a new owner, and starts the previous release', async () => {
    const { run, calls, time } = helper((clock, starts) => (starts === 2 ? owner('1.0.0', 300) : clock < 0 ? old : null));
    await run();
    expect(time()).toBeGreaterThanOrEqual(NEW_OWNER_MS + STEADY_OWNER_MS);
    expect(time()).toBeLessThan(NEW_OWNER_MS + STEADY_OWNER_MS + 1000);
    expect(calls.switches).toEqual(['1.0.0']);
    expect(calls.starts.map(([file]) => file)).toEqual([join(ROOT, 'releases', '1.0.1', 'node', 'bin', 'node'), join(ROOT, 'releases', '1.0.0', 'node', 'bin', 'node')]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true, message: '新版本 1.0.1 没有起来，已切回 1.0.0' });
  });
  it('asks for vonvon daemon start when the previous release does not come up within 25 s either', async () => {
    const { run, time } = helper(() => null);
    await run();
    expect(time()).toBeGreaterThanOrEqual(NEW_OWNER_MS + ROLLBACK_OWNER_MS);
    expect(time()).toBeLessThan(NEW_OWNER_MS + ROLLBACK_OWNER_MS + 1000);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true });
    expect(readUpdateStatus()?.message).toContain('vonvon daemon start');
  });
  it('leaves the record to whoever ended it first, and starts nothing against a stop', async () => {
    const ended: UpdateStatus = { ...record, phase: 'error', ok: false, message: '重启已被停止取消', at: 10 };
    writeUpdateStatus(ended);
    const { run, calls } = helper(() => null);
    await run();
    expect(calls.switches).toEqual([]);
    expect(calls.starts).toEqual([]);
    expect(readUpdateStatus()).toEqual(ended);
  });
  // review F1: the new daemon's startup check, or another update, took the record while the helper still judged it
  it('holds update.lock while it judges, so nobody else ends or replaces the record', async () => {
    const tries: Array<boolean> = [];
    const { run, calls } = helper((_clock, starts) => {
      if (starts) {
        const release = acquireUpdateLock();
        tries.push(release !== null);
        release?.();
        finishOwnedUpdate(readUpdateStatus()!, 'done');
        return owner('1.0.0');
      }
      return null;
    });
    await run();
    expect(tries.length).toBeGreaterThan(0);
    expect(tries.every(taken => !taken)).toBe(true);
    expect(calls.switches).toEqual(['1.0.0']);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true, message: '重启后运行的是 1.0.0，已切回 1.0.0' });
    const after = acquireUpdateLock();
    expect(after).not.toBeNull();
    after?.();
  });
  it('does not switch current.txt under the Windows supervisor, which does it itself', async () => {
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.0') : null), { rollsBack: false });
    await run();
    expect(calls.switches).toEqual([]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启后运行的是 1.0.0' });
    expect(readUpdateStatus()?.rolledBack).toBeUndefined();
  });
  it('keeps its own start command when this is no standalone server', async () => {
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.0') : null), { installRoot: async () => undefined });
    await run({ phase: 'restarting', ok: true, from: '1', to: '2', at: 3 });
    expect(calls.starts).toEqual([[process.execPath, [expect.any(String), 'daemon', 'start', '--port', '43119']]]);
  });
  // review F8: the pinned entry restarted the old release while `current` named another
  it('starts what current names for a plain restart of a standalone server too', async () => {
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.1') : null));
    await run(null);
    expect(calls.starts.map(([file]) => file)).toEqual([join(ROOT, 'releases', '1.0.1', 'node', 'bin', 'node')]);
  });
  // review F4: a new release that holds the lock but is still migrating was rolled back under it at 60 s
  it('waits for a new release that holds the lock and listens late, and does not switch back under it', async () => {
    const starting = { ...owner('1.0.1'), listen: null };
    const { run, calls, time } = helper(clock => (clock < 70_000 ? starting : owner('1.0.1')));
    await run();
    expect(calls.switches).toEqual([]);
    expect(calls.starts).toEqual([]);
    expect(time()).toBeGreaterThanOrEqual(70_000 + STEADY_OWNER_MS);
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '1.0.1' });
  });
  it('leaves the record to a new release that is still starting at the end, without switching back', async () => {
    const { run, calls, time } = helper(() => ({ ...owner('1.0.1'), listen: null }));
    await run();
    expect(time()).toBeGreaterThanOrEqual(NEW_OWNER_MS + STARTING_OWNER_MS);
    expect(time()).toBeLessThan(NEW_OWNER_MS + STARTING_OWNER_MS + 1000);
    expect(calls.switches).toEqual([]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'restarting', detail: 'waiting', to: '1.0.1' });
  });
  it('switches back when the starting release dies and another takes its place (a crash loop)', async () => {
    let back = -1;
    const { run, calls } = helper(clock => (back >= 0 ? owner('1.0.0', 300) : { ...owner('1.0.1', clock < 62_000 ? 200 : 201), listen: null }), {
      switchCurrent: async () => { back = 1; },
    });
    await run();
    expect(back).toBe(1);
    expect(calls.starts).toEqual([]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true, message: '新版本 1.0.1 没有起来，已切回 1.0.0' });
  });
  it('takes the new release back when it comes up late after the switch back', async () => {
    const { run, calls } = helper((clock, starts) => (starts >= 2 && clock >= NEW_OWNER_MS + 2000 ? owner('1.0.1', 400) : null));
    await run();
    expect(calls.switches).toEqual(['1.0.0', '1.0.1']);
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '1.0.1' });
    expect(readUpdateStatus()?.rolledBack).toBeUndefined();
  });
  // review F5: a replacement that answered the ws check slowly, or a newer protocol, ended the update as start_failed
  it('judges the new owner by its pid lock, without the ws check that a newer protocol may fail', async () => {
    const { run, calls } = helper(() => owner('1.0.1'), { verify: async () => { throw new Error('Cannot verify daemon owner'); } });
    await run();
    expect(calls.switches).toEqual([]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, to: '1.0.1' });
  });
  it('does not count a new release that listens and dies at once', async () => {
    const { run, calls } = helper((clock, starts) => (starts ? owner('1.0.0', 300) : clock < 1000 ? owner('1.0.1') : null));
    await run();
    expect(calls.switches).toEqual(['1.0.0']);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true, message: '新版本 1.0.1 没有起来，已切回 1.0.0' });
  });
  // review 207: a managed restart's new daemon ended the record as it listened, before the helper took it, and died
  it('leaves the record to the helper when the new daemon dies within its first seconds', async () => {
    const root = join(paths.appDir, 'install');
    for (const version of ['1.0.0', '1.0.1']) await mkdir(join(root, 'releases', version), { recursive: true }).then(() => writeFile(join(root, 'releases', version, 'standalone.json'), JSON.stringify({ v: 1, version })));
    await switchCurrent(root, '1.0.1', 'linux');
    let paused: () => void = () => {}, resume: () => void = () => {};
    const settling = settleUpdateAtStartup({ version: '1.0.1', installRoot: root, platform: 'linux', alive: () => false, pause: () => new Promise(resolve => { resume = resolve; paused(); }) });
    await Promise.race([settling, new Promise<void>(resolve => { paused = resolve; })]);
    const { run, calls } = helper(() => null);
    await run();
    await (resume(), settling);
    expect(calls.switches).toEqual(['1.0.0']);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true });
  });
  it('marks the record waiting once the old daemon is gone, so no other update starts meanwhile', async () => {
    let seen: UpdateStatus | null = null;
    const { run } = helper((_clock, starts) => {
      if (starts && !seen) seen = readUpdateStatus();
      return starts ? owner('1.0.1') : null;
    });
    await run();
    expect(seen).toMatchObject({ phase: 'restarting', detail: 'waiting', to: '1.0.1', previous: '1.0.0' });
    expect(seen!.at).toBeGreaterThan(record.at);
  });
});
