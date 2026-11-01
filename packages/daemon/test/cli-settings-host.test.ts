import { expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import type { SettingsRequest } from '@vonvon/protocol';
import { commandFailure } from '../src/cli/command-error';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { parseAssignments, runSettingsAccess, runSettingsGet, runSettingsSet, type Target } from '../src/cli/commands/settings';

/** cli-6-settings: `settings get|set --host`, the web page's 本机, through the real withDaemon and a fake client. */
const section = (stored: object, effective = stored, revision = `rev-${Object.keys(stored)[0]}`) => ({ stored, effective, revision, access: { kind: 'writable' }, apply: [] });
const hostView = (over: object = {}) => ({
  scope: { kind: 'host' },
  sections: {
    execution: section({ codexBin: null }),
    judge: section({ byProvider: { typesafe: { model: 'jev-latest' } } }, { defaultProvider: 'codex-appserver', byProvider: { 'codex-appserver': { model: 'gpt-6-luna', effort: 'low' }, typesafe: { model: 'jev-latest' } } }),
  },
  runtime: { codexBin: null, fallbackCwd: '/home/u/vonvon', platform: 'linux' },
  ...over,
});

function harness(settings: (request: SettingsRequest) => unknown) {
  let out = '';
  const snapshot = vi.fn(async () => ({ agents: [], memberships: [] }));
  const send = vi.fn(async (request: SettingsRequest) => settings(request));
  const connect = vi.fn(async () => ({ snapshot, settings: send, close: async () => {} }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  const failure = async (run: Promise<void>) => commandFailure(await run.then(() => undefined, (error: unknown) => error));
  return { snapshot, send, connect, daemon, failure, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}

// main 必败: there was no --host, and every read went through the snapshot's bots
it('settings get --host reads the host scope without a snapshot, so it works before the first bot', async () => {
  const h = harness(() => ({ kind: 'view', view: hostView() }));
  await runSettingsGet(undefined, { host: true }, h.io(true), h.daemon);
  expect(h.send.mock.calls).toEqual([[{ type: 'read', scope: { kind: 'host' } }]]);
  expect(h.snapshot).not.toHaveBeenCalled();
  expect(JSON.parse(h.out())).toMatchObject({ ok: true, view: { scope: { kind: 'host' }, runtime: { platform: 'linux' } } });

  h.clear(); await runSettingsGet(undefined, { host: true }, h.io(), h.daemon);
  expect(h.out()).toBe([
    '本机设置',
    '[execution]', '  codexBin = null（没设，自动找）',
    '[judge]', '  defaultProvider = codex-appserver（Codex），用默认',
    '  Codex（codex-appserver）：gpt-6-luna，推理强度 low（默认）', '  TypeSafe（typesafe）：jev-latest',
    '[runtime]（只读）', '  实际用的 Codex：自动找', '  找不到文件夹时的默认目录：/home/u/vonvon', '  平台：linux', '',
  ].join('\n'));
  h.clear(); await runSettingsGet('execution', { host: true }, h.io(), h.daemon);
  expect(h.out()).toBe('本机设置\n[execution]\n  codexBin = null（没设，自动找）\n');
  await expect(runSettingsGet('cards', { host: true }, h.io(), h.daemon)).rejects.toThrow('没有 cards 这一节。可以看的有：execution、judge');
});

it('settings get --host marks a read-only section and a daemon without the judge section', async () => {
  const preview = { kind: 'readonly', reason: 'preview', message: '只读预览不能更改执行程序，请先启动 daemon。' };
  const h = harness(() => ({ kind: 'view', view: hostView({ sections: { execution: { ...section({ codexBin: '/opt/codex' }), access: preview } }, runtime: { codexBin: '/opt/codex', fallbackCwd: '/w', platform: 'darwin' } }) }));
  await runSettingsGet(undefined, { host: true }, h.io(), h.daemon);
  expect(h.out()).toContain('[execution]（只读：只读预览不能更改执行程序，请先启动 daemon。）\n  codexBin = /opt/codex\n[runtime]（只读）\n  实际用的 Codex：/opt/codex\n');
  h.clear(); await runSettingsGet('judge', { host: true }, h.io(), h.daemon);
  expect(h.out()).toBe('本机设置\ndaemon 没有 judge 这一节。daemon 可能比命令行旧。\n');
});

// main 必败: the host sections were not a scope the CLI knew
it('settings set --host saves with the section revision; the host schema checks the value first', async () => {
  const h = harness(request => request.type === 'read' ? { kind: 'view', view: hostView() }
    : { kind: 'saved', result: { kind: 'saved', section: { scope: { kind: 'host' }, section: 'execution', value: section({ codexBin: '/usr/local/bin/codex' }) }, effects: [{ fields: ['codexBin'], when: 'restart', detail: '已保存，下次启动 daemon 时使用。' }] } });
  await runSettingsSet(['execution.codexBin=/usr/local/bin/codex'], { host: true }, h.io(), h.daemon);
  expect(h.send.mock.calls).toEqual([
    [{ type: 'read', scope: { kind: 'host' } }],
    [{ type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'rev-codexBin', patch: { codexBin: '/usr/local/bin/codex' } } }],
  ]);
  expect(h.snapshot).not.toHaveBeenCalled();
  expect(h.out()).toBe('已保存 execution.codexBin = /usr/local/bin/codex。\n已保存，下次启动 daemon 时使用。\n');
  // null goes back to finding it; the caller's revision is sent as given
  h.send.mockClear();
  await runSettingsSet(['execution.codexBin=null'], { host: true, revision: 'r0' }, h.io(), h.daemon);
  expect(h.send).toHaveBeenLastCalledWith({ type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'r0', patch: { codexBin: null } } });

  expect(parseAssignments('host', ['judge.defaultProvider=typesafe'])).toEqual({ section: 'judge', patch: { defaultProvider: 'typesafe' } });
  expect(() => parseAssignments('host', ['judge.defaultProvider=nope'])).toThrow('judge.defaultProvider 只能是 codex-appserver、claude-agent、typesafe');
  expect(() => parseAssignments('host', ['runtime.fallbackCwd=/x'])).toThrow('没有 runtime 这一节。可以改的有：execution、judge');
  h.send.mockClear();
  expect(await h.failure(runSettingsSet(['judge.defaultProvider=nope'], { host: true }, h.io(true), h.daemon))).toMatchObject({ exitCode: 2, error: { kind: 'bad-args' } });
  expect(h.connect).toHaveBeenCalledTimes(2);
});

// main 必败: --host did not exist
it('--host goes with no other scope, refused before connecting', async () => {
  const h = harness(() => ({ kind: 'view', view: hostView() }));
  for (const target of [{ host: true, group: '研发' }, { host: true, bot: 'cli_a' }, { host: true, session: 'omt_x' }] as Target[]) {
    expect(await h.failure(runSettingsGet(undefined, target, h.io(true), h.daemon))).toMatchObject({ exitCode: 2, error: { kind: 'bad-args', message: expect.stringContaining('--host 是这台电脑的设置') } });
    expect(await h.failure(runSettingsSet(['execution.codexBin=null'], target, h.io(true), h.daemon))).toMatchObject({ exitCode: 2 });
  }
  expect(h.connect).not.toHaveBeenCalled();
});

it('a save the host refuses: read-only 4 with its reason, rejected 2 with the fields, conflict 5 with the section', async () => {
  const results: unknown[] = [
    { kind: 'unavailable', reason: { kind: 'readonly', reason: 'preview', message: '只读预览不能更改执行程序，请先启动 daemon。' } },
    { kind: 'rejected', fields: [{ field: 'codexBin', message: '文件不存在' }] },
    { kind: 'conflict', current: { scope: { kind: 'host' }, section: 'execution', value: section({ codexBin: '/other' }) } },
  ];
  const h = harness(request => request.type === 'read' ? { kind: 'view', view: hostView() } : { kind: 'saved', result: results.shift() });
  const set = () => runSettingsSet(['execution.codexBin=/nope'], { host: true }, h.io(true), h.daemon);
  expect(await h.failure(set())).toEqual({ ok: false, exitCode: 4, error: { kind: 'refused', reason: 'preview', message: '只读预览不能更改执行程序，请先启动 daemon。' } });
  expect(await h.failure(set())).toEqual({ ok: false, exitCode: 2, error: { kind: 'bad-args', reason: 'rejected', message: '没有保存：codexBin：文件不存在', partial: { fields: [{ field: 'codexBin', message: '文件不存在' }] } } });
  expect(await h.failure(set())).toMatchObject({ exitCode: 5, error: { kind: 'conflict', current: { section: 'execution', value: { stored: { codexBin: '/other' } } } } });
});

it('settings access --host lists the host sections', async () => {
  const h = harness(() => ({ kind: 'view', view: hostView() }));
  await runSettingsAccess({ host: true }, h.io(), h.daemon);
  expect(h.out()).toBe('execution：可以改\njudge：可以改\n');
  expect(h.snapshot).not.toHaveBeenCalled();
});
