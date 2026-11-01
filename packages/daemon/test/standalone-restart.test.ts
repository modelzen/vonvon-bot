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
import { runSamePortRestartHelper, type RestartHelperDeps } from '../src/host/restart';
import { readUpdateStatus, writeUpdateStatus, type UpdateStatus } from '../src/service/update';
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
  const calls = { starts: [] as Array<[string, string[]]>, switches: [] as string[] };
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
    ...fields,
  };
  const run = (update: UpdateStatus | undefined = record) => runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt, ...(update ? { update } : {}) }, deps);
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
    expect(time()).toBeGreaterThanOrEqual(60_000);
    expect(time()).toBeLessThan(61_000);
    expect(calls.switches).toEqual(['1.0.0']);
    expect(calls.starts.map(([file]) => file)).toEqual([join(ROOT, 'releases', '1.0.1', 'node', 'bin', 'node'), join(ROOT, 'releases', '1.0.0', 'node', 'bin', 'node')]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true, message: '新版本 1.0.1 没有起来，已切回 1.0.0' });
  });
  it('asks for vonvon daemon start when the previous release does not come up within 25 s either', async () => {
    const { run, time } = helper(() => null);
    await run();
    expect(time()).toBeGreaterThanOrEqual(85_000);
    expect(time()).toBeLessThan(86_000);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', rolledBack: true });
    expect(readUpdateStatus()?.message).toContain('vonvon daemon start');
  });
  it('leaves the record to whoever ended it first', async () => {
    const ended: UpdateStatus = { ...record, phase: 'error', ok: false, message: '重启后仍是 1.0.0', at: 10 };
    const { run, calls } = helper((_clock, starts) => {
      if (starts) { writeUpdateStatus(ended); return owner('1.0.0'); }
      return null;
    });
    await run();
    expect(calls.switches).toEqual([]);
    expect(readUpdateStatus()).toEqual(ended);
  });
  it('does not switch current.txt under the Windows supervisor, which does it itself', async () => {
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.0') : null), { rollsBack: false });
    await run();
    expect(calls.switches).toEqual([]);
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启后运行的是 1.0.0' });
    expect(readUpdateStatus()?.rolledBack).toBeUndefined();
  });
  it('keeps the old start command for a restart that is not a standalone update', async () => {
    const { run, calls } = helper((_clock, starts) => (starts ? owner('1.0.0') : null), { installRoot: async () => { throw new Error('not asked'); } });
    await run({ phase: 'restarting', ok: true, from: '1', to: '2', at: 3 });
    expect(calls.starts).toEqual([[process.execPath, [expect.any(String), 'daemon', 'start', '--port', '43119']]]);
  });
});
