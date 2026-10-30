import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import type { ScheduleReply, ScheduleRequest, ScheduledTaskView } from '@vonvon/protocol';
import { commandFailure } from '../src/cli/command-error';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runSchedule, type ScheduleAction, type ScheduleTarget } from '../src/cli/commands/schedule';

const NOW = Date.UTC(2026, 9, 31, 2, 0);
// Asia/Shanghai is UTC+8 all year: 09:00 there is 01:00 UTC.
const task = (over: Partial<ScheduledTaskView> = {}): ScheduledTaskView => ({
  id: 'st_0123456789abcdef', botId: 'cli_test', chatId: 'oc_group', revision: 'r1', name: '日报', instruction: '汇总昨天合入的 PR',
  spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, timeZone: 'Asia/Shanghai', placement: { kind: 'follow' },
  state: 'active', createdBy: { via: 'cli' }, createdAt: NOW, updatedAt: NOW, nextRunAt: Date.UTC(2026, 10, 2, 1, 0), running: false,
  counts: { runs: 3, missed: 0, skipped: 0, consecutiveFailures: 0 },
  lastResult: { at: Date.UTC(2026, 10, 1, 1, 0), status: 'done', excerpt: '好了' }, recent: [], describe: '每个工作日 09:00', ...over,
});
const tasks = (list: ScheduledTaskView[], timeZone = 'Asia/Shanghai'): ScheduleReply => ({ kind: 'tasks', tasks: list, now: NOW, timeZone });

/** The settings CLI tests' harness (s47-cli.test.ts): a fake client behind the real withDaemon. */
function harness(reply: (request: ScheduleRequest) => ScheduleReply | Promise<ScheduleReply>, timeouts = { local: 30_000, feishu: 75_000 }) {
  let out = '';
  const requests: ScheduleRequest[] = [];
  const connect = vi.fn(async () => ({
    snapshot: async () => ({
      agents: [{ id: 'cli_test', name: 'Test' }],
      memberships: [{ agentId: 'cli_test', groupId: 'oc_group', name: '研发群' }, { agentId: 'cli_test', groupId: 'oc_other', name: '运营群' }],
    }),
    schedule: async (botId: string, request: ScheduleRequest) => { expect(botId).toBe('cli_test'); requests.push(request); return reply(request); },
    close: async () => {},
  }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, timeouts);
  const run = (action: ScheduleAction, target: ScheduleTarget, json = false, env: NodeJS.ProcessEnv = {}) =>
    runSchedule(action, { group: '研发群', ...target }, { json, write: (text: string) => { out += text; } }, daemon, env);
  const failure = async (action: ScheduleAction, target: ScheduleTarget, env?: NodeJS.ProcessEnv) => commandFailure(await run(action, target, true, env).then(() => undefined, (error: unknown) => error));
  return { run, failure, requests, connect, out: () => out, json: () => JSON.parse(out) };
}
const created = (request: ScheduleRequest): ScheduleReply => request.action === 'list' ? tasks([]) : { kind: 'task', task: task() };

describe('parsing the time options', () => {
  it('refuses two time options, or none on add, with 2 and without connecting', async () => {
    const h = harness(created);
    expect(await h.failure('add', { name: '日报', instruction: 'x', every: '30m', daily: '09:00' })).toMatchObject({ exitCode: 2, error: { kind: 'bad-args', message: '时间只能给一个，这次给了 --every、--daily。' } });
    expect(await h.failure('add', { name: '日报', instruction: 'x' })).toMatchObject({ exitCode: 2 });
    expect(await h.failure('add', { name: '日报', instruction: 'x', weekly: 'mon,xyz@10:00' })).toMatchObject({ exitCode: 2 });
    expect(await h.failure('add', { name: '日报', instruction: 'x', at: '2026-02-30 10:00' })).toMatchObject({ exitCode: 2 });
    expect(await h.failure('add', { name: '日报', instruction: 'x', every: '0m' })).toMatchObject({ exitCode: 2, error: { message: '间隔最短 1 分钟，最长 7 天' } });
    expect(await h.failure('add', { name: '日报', instruction: 'x', every: '1m', tz: 'Mars/Base' })).toMatchObject({ exitCode: 2, error: { message: '不认识这个时区：Mars/Base' } });
    expect(await h.failure('edit', { taskId: 'st_1', revision: 'r1' })).toMatchObject({ exitCode: 2 });
    expect(h.connect).not.toHaveBeenCalled();
    // what only the protocol's schema catches is still a bad argument, and nothing is sent
    expect(await h.failure('add', { name: '日报', instruction: 'x', cron: `${Array.from({ length: 60 }, (_, minute) => minute).join(',')} * * * *` })).toMatchObject({ exitCode: 2, error: { kind: 'bad-args' } });
    expect(h.requests).toEqual([]);
  });

  it('checks the --cron format before connecting', async () => {
    const h = harness(created);
    expect(await h.failure('add', { name: '日报', instruction: 'x', cron: '61 * * * *' })).toMatchObject({ exitCode: 2, error: { kind: 'bad-args', message: 'cron 不合法：范围或步长超出限制' } });
    expect(await h.failure('edit', { taskId: 'st_1', revision: 'r1', cron: '* * *' })).toMatchObject({ exitCode: 2, error: { message: 'cron 不合法：需要 5 段' } });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('turns --every 2h, --weekly and --new-topic into the spec and placement', async () => {
    const h = harness(created);
    await h.run('add', { name: '巡检', instruction: '看 CI', every: '2h', newTopic: true });
    await h.run('add', { name: '周会', instruction: '提醒', weekly: 'wed,mon@10:00' });
    await h.run('add', { name: '日报', instruction: '汇总', cron: '0 9 * * 1-5' });
    expect(h.requests).toEqual([
      { action: 'create', chatId: 'oc_group', name: '巡检', instruction: '看 CI', spec: { kind: 'every', minutes: 120 }, placement: { kind: 'newTopic' } },
      { action: 'create', chatId: 'oc_group', name: '周会', instruction: '提醒', spec: { kind: 'weekly', days: [1, 3], time: '10:00' } },
      { action: 'create', chatId: 'oc_group', name: '日报', instruction: '汇总', spec: { kind: 'cron', expr: '0 9 * * 1-5' } },
    ]);
  });

  it("reads --at in the daemon's time zone from a first list, or in --tz without one", async () => {
    const h = harness(request => request.action === 'list' ? tasks([], 'Asia/Tokyo') : { kind: 'task', task: task() });
    await h.run('add', { name: '提醒', instruction: '发版', at: '2026-11-01 14:00' });
    expect(h.requests).toEqual([
      { action: 'list', chatId: 'oc_group' },
      // 14:00 in Tokyo (UTC+9), whatever zone this test runs in
      { action: 'create', chatId: 'oc_group', name: '提醒', instruction: '发版', spec: { kind: 'once', at: Date.UTC(2026, 10, 1, 5, 0) } },
    ]);
    h.requests.length = 0;
    await h.run('add', { name: '提醒', instruction: '发版', at: '2026-11-01 14:00', tz: 'America/New_York' });
    expect(h.requests).toEqual([{ action: 'create', chatId: 'oc_group', name: '提醒', instruction: '发版', spec: { kind: 'once', at: Date.UTC(2026, 10, 1, 19, 0) }, timeZone: 'America/New_York' }]);
  });

  it("edit reads --at in the task's own time zone, not the daemon's", async () => {
    const h = harness(request => request.action === 'list' ? tasks([task({ timeZone: 'Asia/Tokyo' })], 'Asia/Shanghai') : { kind: 'task', task: task() });
    await h.run('edit', { taskId: 'st_0123456789abcdef', revision: 'r1', at: '2026-11-05 14:00' });
    expect(h.requests).toEqual([
      { action: 'list', chatId: 'oc_group' },
      // 14:00 in Tokyo (UTC+9); the daemon's Shanghai would be 06:00 UTC
      { action: 'edit', chatId: 'oc_group', taskId: 'st_0123456789abcdef', revision: 'r1', patch: { spec: { kind: 'once', at: Date.UTC(2026, 10, 5, 5, 0) } } },
    ]);
    expect(await h.failure('edit', { taskId: 'st_gone', revision: 'r1', at: '2026-11-05 14:00' })).toMatchObject({ exitCode: 4, error: { message: '改任务没有完成：本群没有这个任务。' } });
  });

  it('edits only the given fields with the given revision', async () => {
    const h = harness(created);
    await h.run('edit', { taskId: 'st_0123456789abcdef', revision: 'r7', daily: '10:00', name: ' 早报 ' });
    expect(h.requests).toEqual([{ action: 'edit', chatId: 'oc_group', taskId: 'st_0123456789abcdef', revision: 'r7', patch: { name: '早报', spec: { kind: 'daily', time: '10:00' } } }]);
  });
});

describe('requests that read first', () => {
  it('delete without --revision lists and sends the current revision; with one it only deletes', async () => {
    const h = harness(request => request.action === 'list' ? tasks([task({ revision: 'r9' })]) : { kind: 'deleted', taskId: 'st_0123456789abcdef' });
    await h.run('delete', { taskId: 'st_0123456789abcdef' });
    await h.run('delete', { taskId: 'st_0123456789abcdef', revision: 'r1' });
    expect(h.requests).toEqual([
      { action: 'list', chatId: 'oc_group' },
      { action: 'delete', chatId: 'oc_group', taskId: 'st_0123456789abcdef', revision: 'r9' },
      { action: 'delete', chatId: 'oc_group', taskId: 'st_0123456789abcdef', revision: 'r1' },
    ]);
    expect(await h.failure('delete', { taskId: 'st_gone' })).toMatchObject({ exitCode: 4, error: { kind: 'refused', message: '删任务没有完成：本群没有这个任务。' } });
  });

  it("an unbound group's raw id works for list, runs, delete and pause, and nothing else", async () => {
    const gone = task({ chatId: 'oc_gone', revision: 'r9', state: 'paused', pausedReason: 'unavailable', nextRunAt: undefined });
    const h = harness(request => request.action === 'list' ? tasks([gone]) : request.action === 'delete' ? { kind: 'deleted', taskId: gone.id } : { kind: 'task', task: gone });
    await h.run('list', { group: 'oc_gone' });
    await h.run('runs', { group: 'oc_gone', taskId: gone.id });
    await h.run('delete', { group: 'oc_gone', taskId: gone.id });
    await h.run('pause', { group: 'oc_gone', taskId: gone.id });
    expect(h.requests).toEqual([
      { action: 'list', chatId: 'oc_gone' }, { action: 'list', chatId: 'oc_gone' }, { action: 'list', chatId: 'oc_gone' },
      { action: 'delete', chatId: 'oc_gone', taskId: gone.id, revision: 'r9' }, { action: 'pause', chatId: 'oc_gone', taskId: gone.id },
    ]);
    h.requests.length = 0;
    for (const [action, target] of [['add', { name: '日报', instruction: 'x', every: '30m' }], ['edit', { revision: 'r9', name: '早报' }], ['resume', {}], ['run', {}]] as const) {
      expect(await h.failure(action, { group: 'oc_gone', taskId: gone.id, ...target })).toMatchObject({ exitCode: 2, error: { message: 'Bot「Test」没有绑定「oc_gone」。用 vonvon group list 查看。' } });
    }
    // a name, not an id, is still only a bound group's
    expect(await h.failure('list', { group: '旧群' })).toMatchObject({ exitCode: 2 });
    expect(h.requests).toEqual([]);
  });

  it('runs sends only a list and prints the count and one line per record', async () => {
    const recent = [
      { runId: 'a', slot: Date.UTC(2026, 10, 1, 1, 0), trigger: 'schedule', status: 'done', startedAt: Date.UTC(2026, 10, 1, 1, 0), durationMs: 12_000, link: 'https://example.feishu.cn/x' },
      { runId: 'b', slot: Date.UTC(2026, 10, 2, 1, 0), trigger: 'schedule', status: 'failed', startedAt: Date.UTC(2026, 10, 2, 1, 0), durationMs: 125_000, error: '后端失败' },
      { runId: 'c', slot: Date.UTC(2026, 10, 3, 1, 0), trigger: 'schedule', status: 'skipped', reason: 'running' },
    ] as const;
    const h = harness(() => tasks([task({ recent: [...recent], counts: { runs: 12, missed: 2, skipped: 1, consecutiveFailures: 1 } })]));
    await h.run('runs', { taskId: 'st_0123456789abcdef' });
    expect(h.requests).toEqual([{ action: 'list', chatId: 'oc_group' }]);
    expect(h.out()).toBe([
      'st_0123456789abcdef 日报 · 共运行 12 次（错过 2 次，跳过 1 次）',
      '11-01 09:00 · 完成 · 12 秒 · https://example.feishu.cn/x',
      '11-02 09:00 · 失败（后端失败） · 2 分 5 秒 · —',
      '11-03 09:00 · 跳过（上一次还没跑完） · — · —',
    ].join('\n') + '\n');
    expect(await h.failure('runs', { taskId: 'st_gone' })).toMatchObject({ exitCode: 4, error: { kind: 'refused' } });
  });
});

describe('output', () => {
  it('prints one line per task word for word', async () => {
    const h = harness(() => tasks([
      task(),
      task({ id: 'st_1', name: '巡检', describe: '每 30 分钟', state: 'paused', pausedReason: 'manual', nextRunAt: undefined, lastResult: undefined }),
      task({ id: 'st_2', name: '巡检', describe: '每 30 分钟', state: 'paused', pausedReason: 'failures', nextRunAt: undefined, lastResult: { at: Date.UTC(2026, 10, 1, 1, 30), status: 'failed', excerpt: '' } }),
      task({ id: 'st_3', name: '周报', state: 'paused', pausedReason: 'unavailable', nextRunAt: undefined }),
      task({ id: 'st_4', name: '发版提醒', describe: '11 月 1 日 14:00 一次', state: 'finished', nextRunAt: undefined }),
    ]));
    await h.run('list', {});
    expect(h.out()).toBe([
      'st_0123456789abcdef 日报 · 每个工作日 09:00 · 下次 11-02 09:00 · 已启用 · 上次 完成 11-01 09:00',
      'st_1 巡检 · 每 30 分钟 · 已暂停（手动）',
      'st_2 巡检 · 每 30 分钟 · 已暂停（连续失败） · 上次 失败 11-01 09:30',
      'st_3 周报 · 每个工作日 09:00 · 已暂停（群已解绑） · 上次 完成 11-01 09:00',
      'st_4 发版提醒 · 11 月 1 日 14:00 一次 · 已结束 · 上次 完成 11-01 09:00',
    ].join('\n') + '\n');
  });

  it('--all sends listBot and groups the tasks under their group, an unbound one by its id', async () => {
    const h = harness(() => tasks([task(), task({ id: 'st_9', chatId: 'oc_gone', lastResult: undefined, nextRunAt: undefined, state: 'paused', pausedReason: 'unavailable' })]));
    await h.run('list', { group: undefined, all: true });
    expect(h.requests).toEqual([{ action: 'listBot' }]);
    expect(h.out().split('\n')).toEqual(['群 研发群（oc_group）', `  ${'st_0123456789abcdef 日报 · 每个工作日 09:00 · 下次 11-02 09:00 · 已启用 · 上次 完成 11-01 09:00'}`, '群 oc_gone（没有绑定）', '  st_9 日报 · 每个工作日 09:00 · 已暂停（群已解绑）', '']);
    expect(await h.failure('list', { all: true })).toMatchObject({ exitCode: 2 }); // --group 研发群 and --all
  });

  it('--json prints the reply as it is', async () => {
    const reply = tasks([task()]);
    const h = harness(() => reply);
    await h.run('list', {}, true);
    expect(h.json()).toEqual(reply);
    const started = harness(() => ({ kind: 'started', taskId: 'st_0123456789abcdef', runId: 'r1' }));
    await started.run('run', { taskId: 'st_0123456789abcdef' }, true);
    expect(started.json()).toEqual({ kind: 'started', taskId: 'st_0123456789abcdef', runId: 'r1' });
    expect(started.requests).toEqual([{ action: 'runNow', chatId: 'oc_group', taskId: 'st_0123456789abcdef' }]);
  });
});

describe('exit codes (s47)', () => {
  it('refused 4 with the daemon\'s words, conflict 5 with the current task', async () => {
    const refused = harness(() => ({ kind: 'refused', reason: 'bot-not-running', message: 'Bot 没在运行，任务暂时看不到；启动后再来。' }));
    expect(await refused.failure('run', { taskId: 'st_1' })).toEqual({ ok: false, exitCode: 4, error: { kind: 'refused', message: '运行任务没有完成：Bot 没在运行，任务暂时看不到；启动后再来。' } });
    const conflict = harness(() => ({ kind: 'conflict', current: task({ revision: 'r2' }) }));
    expect(await conflict.failure('edit', { taskId: 'st_0123456789abcdef', revision: 'r1', daily: '10:00' })).toMatchObject({ exitCode: 5, error: { kind: 'conflict', current: { revision: 'r2' } } });
  });

  it('a conflicting delete says it did not delete', async () => {
    const conflict = harness(() => ({ kind: 'conflict', current: task({ revision: 'r2' }) }));
    expect(await conflict.failure('delete', { taskId: 'st_0123456789abcdef', revision: 'r1' })).toMatchObject({ exitCode: 5, error: { kind: 'conflict', message: '这个任务刚在别处改过，没有删除。现在的 revision 是 r2，先看过现在的内容再删。' } });
    expect(await conflict.failure('edit', { taskId: 'st_0123456789abcdef', revision: 'r1', daily: '10:00' })).toMatchObject({ error: { message: '这个任务刚在别处改过，没有保存。现在的 revision 是 r2，先看过现在的内容再改。' } });
  });

  it('a change without a reply is outcome-unknown 6, a read without one is connection 3, a failed call 1', async () => {
    const never = harness(() => new Promise<never>(() => {}), { local: 20, feishu: 20 });
    expect(await never.failure('pause', { taskId: 'st_1' })).toMatchObject({ exitCode: 6, error: { kind: 'outcome-unknown' } });
    expect(await never.failure('list', {})).toMatchObject({ exitCode: 3, error: { kind: 'connection' } });
    // the list before a delete only reads: a lost reply to it is not outcome-unknown
    expect(await never.failure('delete', { taskId: 'st_1' })).toMatchObject({ exitCode: 3 });
    const failed = harness(() => { throw new RpcError('internal', 'boom'); });
    expect(await failed.failure('list', {})).toMatchObject({ exitCode: 1, error: { kind: 'failed' } });
  });

  it("the bot process's lost IPC reply to a change is not confirmed, with the hint; to a read it failed", async () => {
    const lost = harness(() => { throw new RpcError('operation_failed', 'Bot 进程 15000ms 未响应（可能正忙或已假死）'); });
    expect(await lost.failure('add', { name: '日报', instruction: 'x', every: '30m' })).toEqual({ ok: false, exitCode: 6, error: { kind: 'outcome-unknown', message: '建任务没有确认：Bot 进程 15000ms 未响应（可能正忙或已假死）\n可能已经建好了，运行 vonvon schedule list 查看。' } });
    expect(await lost.failure('list', {})).toMatchObject({ exitCode: 1, error: { kind: 'failed', message: '读取任务失败：Bot 进程 15000ms 未响应（可能正忙或已假死）' } });
  });

  it('refuses in a Bot session before connecting', async () => {
    const h = harness(created);
    expect(await h.failure('list', {}, { VONVON_SESSION: 'abc' })).toMatchObject({ exitCode: 4, error: { kind: 'refused' } });
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('vonvon schedule through the CLI entry', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.doUnmock('../src/config/data-access'); vi.doUnmock('../src/host/lifecycle'); });

  it('with no daemon reports only the connection: no data root, no lease, no daemon started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-cli-'));
    try {
      const enter = vi.fn();
      vi.resetModules();
      vi.doMock('../src/config/data-access', () => ({ enterDataAccess: enter }));
      vi.doMock('../src/host/lifecycle', () => ({ observeShutdown: () => ({ dispose() {} }) }));
      const fake = Object.assign(Object.create(process), {
        argv: ['node', '/cli', 'schedule', 'list', '--group', '研发群', '--json'], exitCode: undefined,
        env: { HOME: join(root, 'home'), VONVON_HOME: join(root, 'data') },
      }) as NodeJS.Process;
      vi.stubGlobal('process', fake);
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(text => { out += String(text); return true; });
      await import('../src/cli/index');
      await vi.waitFor(() => expect(fake.exitCode).toBe(3));
      expect(JSON.parse(out)).toMatchObject({ ok: false, exitCode: 3, error: { kind: 'connection', message: 'daemon 没有运行。先运行 vonvon daemon start。' } });
      expect(enter).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
