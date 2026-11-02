import { rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import type { CoreUpdateStatus, MachineReply } from '@vonvon/protocol';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { paths: { appDir: mkdtempSync(joinPath(tmpdir(), 'vonvon-cli-update-')) } };
});

import { paths } from '../src/config/paths';
import { commandExitCodes, CommandError } from '../src/cli/command-error';
import { runUpdateCommand, type UpdateCommandDeps } from '../src/cli/commands/update';
import { withDaemon } from '../src/cli/daemon-client';
import { switchCurrent } from '../src/service/current-release';
import { acquireUpdateLock } from '../src/service/update';
import { BASE, fakeCdn, manifestPayload, signManifest, testKeys } from './helpers/fake-cdn';

// main 必败: there was no `vonvon update` for a standalone server; `update` only ran npm i -g (server-3 4.8)
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));
const keys = testKeys();
const ROOT = join(paths.appDir, 'install');
const standalone = { kind: 'standalone' as const, cliPath: join(ROOT, 'current', 'app', 'bin', 'vonvon.mjs'), installRoot: ROOT };
type Machine = (payload: { type: string }) => Promise<MachineReply>;

function harness(fields: { machine?: Machine; running?: boolean; ownerAlive?: () => boolean; env?: NodeJS.ProcessEnv; distribution?: Awaited<ReturnType<UpdateCommandDeps['distribution']>>; file?: () => CoreUpdateStatus | null } = {}) {
  let clock = 1_000_000;
  let out = '';
  const sent: Array<{ type: string }> = [];
  const machine: Machine = async payload => { sent.push(payload); return fields.machine!(payload); };
  const connect = async () => ({ close: async () => {}, machine }) as unknown as VonvonClient;
  const cdn = fakeCdn();
  cdn.routes.set(`${BASE}/stable/manifest.json`, { body: signManifest(manifestPayload('1.0.1', 10), keys.privateKey) });
  const deps: UpdateCommandDeps = {
    distribution: async () => fields.distribution ?? standalone,
    daemonRunning: async () => fields.running ?? true,
    ownerAlive: async () => fields.ownerAlive?.() ?? false,
    daemon: fn => withDaemon(fn, connect, { local: 50, feishu: 50 }),
    readStatus: fields.file ?? (() => null),
    now: () => clock,
    pause: async ms => { clock += ms; },
    local: installRoot => ({ installRoot, currentVersion: '1.0.0', config: () => keys.config, fetch: cdn.fetch, platform: 'linux', arch: 'x64' }),
    env: fields.env ?? {},
    npm: { check: async () => ({ current: '1.0.0', latest: '1.0.1', hasUpdate: true, dev: false }), install: vi.fn(async () => ({ ok: true, message: '' })) },
  };
  const io = (json = false) => ({ json, write: (text: string) => { out += text; } });
  return { deps, io, out: () => out, sent, time: () => clock };
}
const failed = (kind: keyof typeof commandExitCodes) => expect.objectContaining({ kind });
const status = (phase: string, extra: Partial<CoreUpdateStatus> = {}): CoreUpdateStatus => ({ phase, from: '1.0.0', at: 2_000_000, ...extra });
const statusReply = (value: CoreUpdateStatus | null): MachineReply => ({ type: 'coreUpdateStatus', status: value });
const accepted: MachineReply = { type: 'done', message: '开始更新…' };
/** A daemon of a global npm install (or of `kind`): its check, its update accepted by `apply`, then a done record. */
const npmDaemon = (apply: () => Promise<MachineReply> = async () => accepted, kind = 'global-npm', latest: string | null = '1.0.1') => harness({
  distribution: { kind: 'global-npm', cliPath: '/x' }, file: () => status('done', { ok: true, to: '1.0.1' }),
  machine: async payload => (payload.type === 'checkCoreUpdate' ? { type: 'coreUpdate', distribution: { kind, cliPath: '/x' }, current: '1.0.0', latest, hasUpdate: latest !== null, dev: false }
    : payload.type === 'applyCoreUpdate' ? apply() : statusReply(status('done', { ok: true, to: '1.0.1' }))),
});

beforeEach(async () => {
  rmSync(join(paths.appDir, 'update.lock'), { force: true });
  await mkdir(join(ROOT, 'releases', '1.0.0'), { recursive: true });
  await writeFile(join(ROOT, 'releases', '1.0.0', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.0' }));
  await switchCurrent(ROOT, '1.0.0');
});

describe('vonvon update --check', () => {
  it('prints what the daemon found as it is under --json', async () => {
    const reply: MachineReply = { type: 'coreUpdate', distribution: { kind: 'standalone', cliPath: '/x' }, current: '1.0.0', latest: '1.0.1', hasUpdate: true, dev: false, channel: 'stable' };
    const { deps, io, out, sent } = harness({ machine: async () => reply });
    await runUpdateCommand({ check: true }, io(true), deps);
    expect(sent).toEqual([{ type: 'checkCoreUpdate' }]);
    expect(JSON.parse(out())).toEqual({ ok: true, ...reply });
  });
  it('checks here when no daemon runs, and says so', async () => {
    const { deps, io, out } = harness({ running: false });
    await runUpdateCommand({ check: true }, io(true), deps);
    expect(JSON.parse(out())).toEqual({ ok: true, current: '1.0.0', latest: '1.0.1', hasUpdate: true, channel: 'stable', source: 'local' });
  });
  it('names a refused manifest in words', async () => {
    const reply: MachineReply = { type: 'coreUpdate', distribution: { kind: 'standalone', cliPath: '/x' }, current: '1.0.0', latest: null, hasUpdate: false, dev: false, channel: 'stable', refused: 'signature' };
    const { deps, io, out } = harness({ machine: async () => reply });
    await runUpdateCommand({ check: true }, io(), deps);
    expect(out()).toBe('当前 1.0.0，没查到新版本：发布清单的签名不对，没有应用\n');
  });
});

describe('vonvon update', () => {
  it('refuses --allow-downgrade without --to, and a --to that is not a version', async () => {
    const { deps, io, sent } = harness();
    await expect(runUpdateCommand({ allowDowngrade: true }, io(), deps)).rejects.toEqual(failed('bad-args'));
    await expect(runUpdateCommand({ to: 'latest' }, io(), deps)).rejects.toEqual(failed('bad-args'));
    expect(sent).toEqual([]);
  });
  it('refuses a source checkout and a desktop CLI with no daemon', async () => {
    await expect(runUpdateCommand({}, harness().io(), harness({ distribution: { kind: 'development', cliPath: '/x' } }).deps)).rejects.toEqual(failed('refused'));
    await expect(runUpdateCommand({}, harness().io(), harness({ distribution: { kind: 'bundled', cliPath: '/x' }, running: false }).deps)).rejects.toEqual(failed('refused'));
  });
  it('follows the daemon, then the status file once it goes away to restart', async () => {
    let polls = 0;
    const steps = [status('installing', { detail: 'downloading', progress: { transferred: 5, total: 10 } }), status('installing', { detail: 'unpacking' }), status('restarting', { to: '1.0.1', previous: '1.0.0', detail: 'draining' })];
    const { deps, io, out, sent } = harness({
      machine: async payload => {
        if (payload.type === 'applyCoreUpdate') return accepted;
        const next = steps[polls++];
        if (!next) throw new ConnectionError(new Error('closed'));
        return statusReply(next);
      },
      file: () => status('done', { ok: true, to: '1.0.1', previous: '1.0.0' }),
    });
    await runUpdateCommand({}, io(), deps);
    expect(sent[0]).toEqual({ type: 'applyCoreUpdate' });
    expect(out().trim().split('\n')).toEqual(['下载中 50%', '解包中', '等 Bot 做完手上的活', '更新完成', '已更新到 1.0.1']);
  });
  // review 207: under --json a global npm install updated here and left the running daemon on the old code
  it('has a running daemon of a global npm install update and restart itself, under --json too', async () => {
    const { deps, io, out, sent } = npmDaemon();
    await runUpdateCommand({}, io(true), deps);
    expect(sent.slice(0, 2)).toEqual([{ type: 'checkCoreUpdate' }, { type: 'applyCoreUpdate' }]);
    expect(deps.npm.install).not.toHaveBeenCalled();
    expect(JSON.parse(out().trim().split('\n').at(-1)!)).toMatchObject({ ok: true, status: { phase: 'done', to: '1.0.1' } });
  });
  // the check after review 207: that daemon answers only once npm install -g is done, and the call gave up after 30 s
  it('waits for a global npm daemon to install, and follows the record when the call drops', async () => {
    const slow = npmDaemon(() => new Promise(resolve => setTimeout(() => resolve(accepted), 200)));
    await runUpdateCommand({}, slow.io(), slow.deps);
    expect(slow.out().trim().split('\n').at(-1)).toBe('已更新到 1.0.1');
    const dropped = npmDaemon(async () => { throw new ConnectionError(new Error('closed')); });
    await runUpdateCommand({}, dropped.io(true), dropped.deps);
    expect(JSON.parse(dropped.out().trim().split('\n').at(-1)!)).toMatchObject({ ok: true, status: { phase: 'done', to: '1.0.1' } });
    expect(slow.deps.npm.install).not.toHaveBeenCalled();
  });
  it('installs here when the daemon is not a global npm install, and exits 1 when npm has no answer', async () => {
    const desktop = npmDaemon(undefined, 'bundled');
    await runUpdateCommand({}, desktop.io(true), desktop.deps);
    expect(desktop.sent).toEqual([{ type: 'checkCoreUpdate' }]);
    expect(desktop.deps.npm.install).toHaveBeenCalled();
    const offline = npmDaemon(undefined, 'global-npm', null);
    try {
      await runUpdateCommand({}, offline.io(), offline.deps);
      expect(offline.out()).toContain('查不到最新版本');
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = undefined; }
  });
  it('passes --to and --allow-downgrade to the daemon', async () => {
    const { deps, io, sent } = harness({ machine: async payload => (payload.type === 'applyCoreUpdate' ? accepted : statusReply(status('done', { ok: true, to: '0.9.0' }))) });
    await runUpdateCommand({ to: '0.9.0', allowDowngrade: true }, io(), deps);
    expect(sent[0]).toEqual({ type: 'applyCoreUpdate', version: '0.9.0', allowDowngrade: true });
  });
  it('gives up after 120 s without an outcome, as unknown', async () => {
    const { deps, io, time } = harness({
      machine: async payload => { if (payload.type === 'applyCoreUpdate') return accepted; throw new ConnectionError(new Error('closed')); },
      file: () => status('restarting', { to: '1.0.1', previous: '1.0.0', detail: 'waiting' }),
    });
    const start = time();
    await expect(runUpdateCommand({}, io(), deps)).rejects.toEqual(failed('outcome-unknown'));
    expect(time() - start).toBeGreaterThanOrEqual(120_000);
  });
  it('fails, saying it went back, when the new version did not come up', async () => {
    const { deps, io } = harness({
      machine: async payload => (payload.type === 'applyCoreUpdate' ? accepted : statusReply(status('error', { ok: false, to: '1.0.1', previous: '1.0.0', rolledBack: true, message: '新版本 1.0.1 没有起来，已切回 1.0.0' }))),
    });
    const error = await runUpdateCommand({}, io(), deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ kind: 'failed', message: '更新没有完成：新版本 1.0.1 没有起来，已切回 1.0.0' });
  });
  it('ignores the record of an earlier update', async () => {
    let polls = 0;
    const { deps, io, out } = harness({
      machine: async payload => {
        if (payload.type === 'applyCoreUpdate') return accepted;
        return statusReply(++polls === 1 ? status('done', { ok: true, to: '0.1.0', at: 1 }) : status('done', { ok: true, to: '1.0.1' }));
      },
    });
    await runUpdateCommand({}, io(), deps);
    expect(out()).not.toContain('0.1.0');
    expect(polls).toBe(2);
  });
  it('says conflict while another update holds the lock, with no daemon running', async () => {
    const { deps, io } = harness({ running: false });
    const release = acquireUpdateLock();
    try { await expect(runUpdateCommand({}, io(), deps)).rejects.toEqual(failed('conflict')); }
    finally { release?.(); }
  });
  // review F6: the connection drops when the drain starts, and a long drain used up the 120 s
  it('starts the 120 s only once the old daemon no longer drains', async () => {
    let draining = true;
    const { deps, io, time } = harness({
      machine: async payload => { if (payload.type === 'applyCoreUpdate') return accepted; throw new ConnectionError(new Error('closed')); },
      ownerAlive: () => draining,
      file: () => (time() < 1_300_000 ? status('restarting', { to: '1.0.1', previous: '1.0.0', detail: 'draining' }) : (draining = false, status('restarting', { to: '1.0.1', previous: '1.0.0', detail: 'waiting' }))),
    });
    await expect(runUpdateCommand({}, io(), deps)).rejects.toEqual(failed('outcome-unknown'));
    expect(time()).toBeGreaterThan(1_300_000 + 119_000);
  });
  // review F1: with no daemon listening, a second update overwrote the record a restart helper still waited on
  it('says conflict while an earlier update waits for its restart, with no daemon listening', async () => {
    const { deps, io } = harness({ running: false, ownerAlive: () => true });
    const { writeUpdateStatus } = await import('../src/service/update');
    writeUpdateStatus({ phase: 'restarting', ok: true, from: '1.0.0', to: '1.0.1', previous: '1.0.0', at: 1, detail: 'waiting' });
    try { await expect(runUpdateCommand({}, io(), deps)).rejects.toEqual(failed('conflict')); }
    finally { rmSync(join(paths.appDir, 'update-status.json'), { force: true }); }
  });
  // I3-SEC-3: a Bot's agent could restart or downgrade the server it runs under
  it('refuses in a Bot session, with the daemon running or not', async () => {
    for (const running of [true, false]) {
      const { deps, io, sent } = harness({ running, env: { VONVON_SESSION: '1' }, machine: async () => accepted });
      await expect(runUpdateCommand({}, io(), deps)).rejects.toEqual(expect.objectContaining({ kind: 'refused', reason: 'not_in_session' }));
      await expect(runUpdateCommand({ to: '1.0.0', allowDowngrade: true }, io(), deps)).rejects.toEqual(expect.objectContaining({ kind: 'refused', reason: 'not_in_session' }));
      expect(sent).toEqual([]);
    }
  });
  it('turns the daemon refusing a second update into conflict', async () => {
    const { RpcError } = await import('@vonvon/client');
    const { deps, io } = harness({ machine: async () => { throw new RpcError('conflict', '已有更新正在进行。'); } });
    await expect(runUpdateCommand({}, io(), deps)).rejects.toEqual(failed('conflict'));
  });
});
