import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleReplySchema, type ScheduleReply, type ScheduleRequest } from '@vonvon/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduleCommands, type ScheduleActor } from '../src/admin/schedule-commands';
import type { RunNowResult, Scheduler } from '../src/bot/schedule/scheduler';
import { createScheduleStore } from '../src/bot/schedule/store';
import { ceilToMinute } from '../src/bot/schedule/time';
import type { StoredTask } from '../src/bot/schedule/types';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-01T02:00:00Z');   // when the stored fixtures were made
const NOW = Date.parse('2026-11-02T02:00:23Z');  // 10:00:23 in Shanghai, not on a whole minute
const HOST = 'Asia/Shanghai', G = 'oc_group', OTHER = 'oc_other';
const log = { info: vi.fn(), warn: vi.fn(), fail: vi.fn() };
const owner: ScheduleActor = { kind: 'chat', openId: 'ou_owner', role: 'owner', chatId: G };
const admin: ScheduleActor = { kind: 'chat', openId: 'ou_admin', role: 'admin', chatId: G };
const member: ScheduleActor = { kind: 'chat', openId: 'ou_member', name: '成员甲', role: 'member', chatId: G, messageId: 'om_1', text: '每 30 分钟看一下构建' };
const local: ScheduleActor = { kind: 'local', via: 'cli' };
const unattended = (taskId: string, chatId = G): ScheduleActor => ({ kind: 'scheduled', taskId, runId: 'run-self', chatId });
const stored = (id: string, patch: Partial<StoredTask> = {}): StoredTask => ({
  id, chatId: G, revision: `rev-${id}`, name: `任务 ${id}`, instruction: '看一下构建', spec: { kind: 'every', minutes: 30, anchor: T0 },
  timeZone: HOST, placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'chat', openId: 'ou_someone', role: 'member' },
  createdAt: T0, updatedAt: T0, cursor: T0, counts: { runs: 3, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], ...patch,
});
const create = (patch: Partial<Extract<ScheduleRequest, { action: 'create' }>> = {}): ScheduleRequest => (
  { action: 'create', chatId: G, name: '构建', instruction: '看一下构建', spec: { kind: 'every', minutes: 30 }, ...patch }
);

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup(initial: StoredTask[] = [], runNow: RunNowResult = { kind: 'not-started' }) {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-commands-')); dirs.push(dir);
  const file = join(dir, 'schedules.json');
  if (initial.length) await writeFile(file, JSON.stringify({ version: 1, tasks: initial }));
  let clock = NOW;
  const store = createScheduleStore(file, { now: () => clock, log, diagnostics: vi.fn() });
  await store.load();
  const scheduler = { start: vi.fn(async () => {}), stop: vi.fn(), drain: vi.fn(async () => {}), wake: vi.fn(), runNow: vi.fn((_id: string) => runNow) } satisfies Scheduler;
  const commands = createScheduleCommands({ store, scheduler, botId: 'bot-test', now: () => clock, hostTimeZone: () => HOST });
  /** Every reply must pass the strict protocol schema: no cursor, inflight or notice fields leak into a view. */
  const run = async (actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply> => scheduleReplySchema.parse(await commands.execute(actor, request));
  const onDisk = async (): Promise<StoredTask[]> => JSON.parse(await readFile(file, 'utf8')).tasks;
  return { file, store, scheduler, run, onDisk, setNow: (ms: number) => { clock = ms; } };
}
const refusal = (reason: string, message?: string) => ({ kind: 'refused', reason, ...(message === undefined ? {} : { message }) });
const taskIdOf = (reply: ScheduleReply): string => (reply.kind === 'task' ? reply.task.id : `no task: ${reply.kind}`);

describe('who may do what', () => {
  it.each([['owner', owner], ['admin', admin]] as const)('lets the %s do every group action on anyone\'s task', async (_name, actor) => {
    const f = await setup([stored('st_a'), stored('st_b')], { kind: 'started', runId: 'r1' });
    expect(await f.run(actor, { action: 'list', chatId: G })).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_a' }, { id: 'st_b' }] });
    expect(await f.run(actor, create())).toMatchObject({ kind: 'task', task: { createdBy: { via: 'chat', openId: (actor as { openId: string }).openId } } });
    const edited = await f.run(actor, { action: 'edit', chatId: G, taskId: 'st_a', revision: 'rev-st_a', patch: { name: '改过' } });
    expect(edited).toMatchObject({ kind: 'task', task: { name: '改过' } });
    expect(await f.run(actor, { action: 'pause', chatId: G, taskId: 'st_a' })).toMatchObject({ kind: 'task', task: { state: 'paused', pausedReason: 'manual' } });
    expect(await f.run(actor, { action: 'resume', chatId: G, taskId: 'st_a' })).toMatchObject({ kind: 'task', task: { state: 'active' } });
    expect(await f.run(actor, { action: 'runNow', chatId: G, taskId: 'st_a' })).toEqual({ kind: 'started', taskId: 'st_a', runId: 'r1' });
    expect(await f.run(actor, { action: 'delete', chatId: G, taskId: 'st_b', revision: 'rev-st_b' })).toEqual({ kind: 'deleted', taskId: 'st_b' });
    expect((await f.onDisk()).map(task => task.id)).toEqual(['st_a', expect.stringMatching(/^st_[0-9a-f]{16}$/)]);
  });
  it('lets a member create and manage only what they created', async () => {
    const f = await setup([stored('st_theirs'), stored('st_mine', { createdBy: { via: 'chat', openId: 'ou_member', role: 'member' } })], { kind: 'started', runId: 'r1' });
    const made = await f.run(member, create());
    expect(made).toMatchObject({ kind: 'task', task: { createdBy: { via: 'chat', openId: 'ou_member', name: '成员甲', role: 'member', messageId: 'om_1', text: '每 30 分钟看一下构建' } } });
    expect(await f.run(member, { action: 'list', chatId: G })).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_theirs' }, { id: 'st_mine' }, { id: taskIdOf(made) }] });
    for (const request of [
      { action: 'edit', chatId: G, taskId: 'st_theirs', revision: 'rev-st_theirs', patch: { name: '改过' } },
      { action: 'pause', chatId: G, taskId: 'st_theirs' }, { action: 'resume', chatId: G, taskId: 'st_theirs' },
      { action: 'delete', chatId: G, taskId: 'st_theirs', revision: 'rev-st_theirs' }, { action: 'runNow', chatId: G, taskId: 'st_theirs' },
    ] satisfies ScheduleRequest[]) {
      expect(await f.run(member, request)).toEqual(refusal('not-task-owner', '这个任务是别人建的，只有建它的人、主人和管理员能改。'));
    }
    expect(f.scheduler.runNow).not.toHaveBeenCalled();
    expect(await f.run(member, { action: 'edit', chatId: G, taskId: 'st_mine', revision: 'rev-st_mine', patch: { name: '我的' } })).toMatchObject({ kind: 'task', task: { name: '我的' } });
    expect(await f.run(member, { action: 'runNow', chatId: G, taskId: taskIdOf(made) })).toMatchObject({ kind: 'started' });
    expect((await f.onDisk()).find(task => task.id === 'st_theirs')).toMatchObject({ name: '任务 st_theirs', revision: 'rev-st_theirs' });
  });
  it('keeps an unattended run to its own task: no create, list and change only itself', async () => {
    const f = await setup([stored('st_self'), stored('st_other')]);
    const self = unattended('st_self');
    expect(await f.run(self, create())).toEqual(refusal('no-human-create', '定时任务运行时不能新建任务；要再来一次就改自己这个任务的时间。'));
    expect(await f.run(self, { action: 'list', chatId: G })).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_self' }] });
    expect((await f.run(self, { action: 'list', chatId: G }) as Extract<ScheduleReply, { kind: 'tasks' }>).tasks).toHaveLength(1);
    const scope = refusal('scheduled-run-scope', '定时任务运行时只能改或结束自己这一个任务。');
    expect(await f.run(self, { action: 'edit', chatId: G, taskId: 'st_other', revision: 'rev-st_other', patch: { name: '改过' } })).toEqual(scope);
    expect(await f.run(self, { action: 'delete', chatId: G, taskId: 'st_other', revision: 'rev-st_other' })).toEqual(scope);
    for (const action of ['pause', 'resume', 'runNow'] as const) expect(await f.run(self, { action, chatId: G, taskId: 'st_self' })).toEqual(scope);
    const later = { kind: 'once', at: NOW + 20 * MIN } as const;
    expect(await f.run(self, { action: 'edit', chatId: G, taskId: 'st_self', revision: 'rev-st_self', patch: { spec: later } })).toMatchObject({ kind: 'task', task: { id: 'st_self', spec: later } });
    const revision = (await f.onDisk()).find(task => task.id === 'st_self')!.revision;
    expect(await f.run(self, { action: 'delete', chatId: G, taskId: 'st_self', revision })).toEqual({ kind: 'deleted', taskId: 'st_self' });
    expect((await f.onDisk()).map(task => task.id)).toEqual(['st_other']);
  });
  it('answers another group as not-group, and another group\'s task id as not-found', async () => {
    const f = await setup([stored('st_here'), stored('st_there', { chatId: OTHER, createdBy: { via: 'chat', openId: 'ou_owner', role: 'owner' } })], { kind: 'started', runId: 'r1' });
    const notGroup = refusal('not-group', '定时任务只能在群里管；要看别的群的任务去那个群说，或者用桌面端。');
    for (const actor of [owner, member, unattended('st_there', G)]) {
      expect(await f.run(actor, { action: 'list', chatId: OTHER })).toEqual(notGroup);
      expect(await f.run(actor, { action: 'pause', chatId: OTHER, taskId: 'st_there' })).toEqual(notGroup);
    }
    expect(await f.run(owner, create({ chatId: OTHER }))).toEqual(notGroup);
    const notFound = refusal('not-found', '本群没有这个任务。');
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_there', revision: 'rev-st_there', patch: { name: 'x' } })).toEqual(notFound);
    expect(await f.run(owner, { action: 'delete', chatId: G, taskId: 'st_there', revision: 'rev-st_there' })).toEqual(notFound);
    expect(await f.run(owner, { action: 'runNow', chatId: G, taskId: 'st_there' })).toEqual(notFound);
    expect(await f.run(owner, { action: 'pause', chatId: G, taskId: 'st_there' })).toEqual(notFound);
    expect(await f.run(unattended('st_there', G), { action: 'edit', chatId: G, taskId: 'st_there', revision: 'rev-st_there', patch: { name: 'x' } })).toEqual(notFound);
    expect(f.scheduler.runNow).not.toHaveBeenCalled();
    expect((await f.onDisk()).find(task => task.id === 'st_there')).toMatchObject({ state: 'active', revision: 'rev-st_there' });
  });
  it('gives a chat role outside the table, no role or an actor outside the union no rights', async () => {
    const f = await setup([stored('st_theirs')], { kind: 'started', runId: 'r1' });
    for (const actor of [
      { kind: 'chat', openId: 'ou_x', role: 'bot', chatId: G },
      { kind: 'chat', openId: 'ou_x', chatId: G },
      { kind: 'Chat', openId: 'ou_x', role: 'owner', chatId: G },
    ] as unknown as ScheduleActor[]) {
      const notOwner = refusal('not-task-owner', '这个任务是别人建的，只有建它的人、主人和管理员能改。');
      expect(await f.run(actor, { action: 'edit', chatId: G, taskId: 'st_theirs', revision: 'rev-st_theirs', patch: { name: '改过' } })).toEqual(notOwner);
      expect(await f.run(actor, { action: 'runNow', chatId: G, taskId: 'st_theirs' })).toEqual(notOwner);
      expect(await f.run(actor, { action: 'delete', chatId: G, taskId: 'st_theirs', revision: 'rev-st_theirs' })).toEqual(notOwner);
      expect(await f.run(actor, create())).toEqual(refusal('not-human-turn', '这一轮不是由在场的人发起的，不能改任务。'));
    }
    expect(f.scheduler.runNow).not.toHaveBeenCalled();
    expect(await f.onDisk()).toEqual([stored('st_theirs')]);
  });
  it('gives listBot to the local owner only', async () => {
    const f = await setup([stored('st_here'), stored('st_there', { chatId: OTHER })]);
    expect(await f.run(local, { action: 'listBot' })).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_here', chatId: G }, { id: 'st_there', chatId: OTHER }], timeZone: HOST });
    for (const actor of [owner, admin, unattended('st_here')]) expect(await f.run(actor, { action: 'listBot' })).toMatchObject(refusal('not-group'));
    expect(await f.run({ kind: 'local', via: 'desktop' }, { action: 'pause', chatId: OTHER, taskId: 'st_there' })).toMatchObject({ kind: 'task', task: { state: 'paused' } });
  });
});

describe('limits', () => {
  it('refuses the 21st task of a group with the group text', async () => {
    const f = await setup(Array.from({ length: 20 }, (_, i) => stored(`st_g${i}`)));
    expect(await f.run(owner, create())).toEqual(refusal('task-limit', '本群已有 20 个任务，先删掉不用的。'));
    expect(await f.onDisk()).toHaveLength(20);
    expect(await f.run(owner, create({ chatId: OTHER }))).toMatchObject(refusal('not-group'));
    expect(await f.run(local, create({ chatId: OTHER }))).toMatchObject({ kind: 'task' });
  });
  it('refuses the 201st task of the bot with the bot text', async () => {
    const f = await setup(Array.from({ length: 200 }, (_, i) => stored(`st_b${i}`, { chatId: `oc_${i % 10}` })));
    expect(await f.run(owner, create())).toEqual(refusal('task-limit', '这个 Bot 已有 200 个任务，先删掉不用的。'));
    expect(await f.onDisk()).toHaveLength(200);
    expect(f.scheduler.wake).not.toHaveBeenCalled();
  });
});

describe('create and views', () => {
  it('anchors an every task on the next whole minute and fills the creator, cursor and defaults', async () => {
    const f = await setup();
    const reply = await f.run(local, create());
    const anchor = ceilToMinute(NOW);
    expect(anchor).toBe(Date.parse('2026-11-02T02:01:00Z'));
    expect(reply).toMatchObject({ kind: 'task', task: {
      botId: 'bot-test', chatId: G, spec: { kind: 'every', minutes: 30, anchor }, timeZone: HOST, placement: { kind: 'follow' }, state: 'active',
      createdBy: { via: 'cli' }, createdAt: NOW, nextRunAt: anchor + 30 * MIN, running: false, describe: '每 30 分钟', recent: [],
    } });
    const [saved] = await f.onDisk();
    expect(saved).toMatchObject({ id: taskIdOf(reply), spec: { anchor }, cursor: NOW, createdAt: NOW });
    expect(saved!.id).toMatch(/^st_[0-9a-f]{16}$/);
    expect(saved!.createdBy).toEqual({ via: 'cli' });
    expect(f.scheduler.wake).toHaveBeenCalledTimes(1);
    expect(await f.run(local, { action: 'list', chatId: G })).toMatchObject({ kind: 'tasks', now: NOW, timeZone: HOST, tasks: [{ describe: '每 30 分钟' }] });
  });
  it('anchors on now whatever anchor the request carries', async () => {
    const f = await setup();
    for (const anchor of [1e300, -1e300]) {
      expect(await f.run(local, create({ spec: { kind: 'every', minutes: 30, anchor } }))).toMatchObject({ kind: 'task', task: { spec: { anchor: ceilToMinute(NOW) }, nextRunAt: ceilToMinute(NOW) + 30 * MIN } });
    }
    expect((await f.onDisk()).map(task => task.spec)).toEqual([{ kind: 'every', minutes: 30, anchor: ceilToMinute(NOW) }, { kind: 'every', minutes: 30, anchor: ceilToMinute(NOW) }]);
  });
  it('refuses a bare UTC offset as a time zone, on create and on edit', async () => {
    const f = await setup([stored('st_a')]);
    for (const timeZone of ['+09:00', '+0900', '-23:59']) {
      expect(await f.run(owner, create({ timeZone }))).toEqual(refusal('bad-schedule', `不认识这个时区：${timeZone}`));
      expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_a', revision: 'rev-st_a', patch: { timeZone } })).toEqual(refusal('bad-schedule', `不认识这个时区：${timeZone}`));
    }
    expect(await f.onDisk()).toEqual([stored('st_a')]);
  });
  it('replies for a task whose stored time zone this Intl does not know', async () => {
    const f = await setup([
      stored('st_daily', { spec: { kind: 'daily', time: '09:00' }, timeZone: 'Mars/Olympus' }),
      stored('st_once', { spec: { kind: 'once', at: NOW + HOUR }, timeZone: 'Mars/Olympus' }),
    ]);
    const listed = await f.run(local, { action: 'list', chatId: G });
    // A once task's instant needs no zone; it is described in the host's.
    expect(listed).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_daily', describe: '每天 09:00（Mars/Olympus）' }, { id: 'st_once', describe: '11 月 2 日 11:00 一次', nextRunAt: NOW + HOUR }] });
    expect((listed as Extract<ScheduleReply, { kind: 'tasks' }>).tasks[0]).not.toHaveProperty('nextRunAt');
    expect(await f.run(local, { action: 'listBot' })).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_daily' }, { id: 'st_once' }] });
    expect(await f.run(owner, { action: 'pause', chatId: G, taskId: 'st_daily' })).toMatchObject({ kind: 'task', task: { state: 'paused' } });
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_once', revision: 'rev-st_once', patch: { name: '改名' } })).toMatchObject({ kind: 'task', task: { name: '改名', timeZone: 'Mars/Olympus' } });
    const revision = (await f.onDisk()).find(task => task.id === 'st_daily')!.revision;
    expect(await f.run(owner, { action: 'delete', chatId: G, taskId: 'st_daily', revision })).toEqual({ kind: 'deleted', taskId: 'st_daily' });
    expect((await f.onDisk()).map(task => [task.id, task.timeZone])).toEqual([['st_once', 'Mars/Olympus']]);
  });
  it('stores a given time zone normalized, and an explicit placement as given', async () => {
    const f = await setup();
    const reply = await f.run(owner, create({ spec: { kind: 'daily', time: '09:00' }, timeZone: 'asia/tokyo', placement: { kind: 'newTopic' } }));
    expect(reply).toMatchObject({ kind: 'task', task: { timeZone: 'Asia/Tokyo', placement: { kind: 'newTopic' }, describe: '每天 09:00（Asia/Tokyo）', nextRunAt: Date.parse('2026-11-03T00:00:00Z') } });
  });
  it('shows a running task as running and gives a paused one no next run', async () => {
    const inflight = { runId: 'r0', slot: T0, trigger: 'schedule', startedAt: T0, revision: 'rev-st_run' } as const;
    const f = await setup([stored('st_run', { inflight }), stored('st_off', { state: 'paused', pausedReason: 'manual', noticePending: true, noticeSince: T0 })]);
    const reply = await f.run(local, { action: 'list', chatId: G });
    expect(reply).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_run', running: true }, { id: 'st_off', running: false }] });
    const [running, paused] = (reply as Extract<ScheduleReply, { kind: 'tasks' }>).tasks;
    expect(running!.nextRunAt).toBeGreaterThan(T0);
    expect(paused).not.toHaveProperty('nextRunAt');
  });
  it('keeps at most 500 units of the creating message', async () => {
    const f = await setup();
    const reply = await f.run({ ...member, text: '长'.repeat(600) } as ScheduleActor, create());
    expect(reply.kind === 'task' && reply.task.createdBy.text).toBe('长'.repeat(500));
  });
  it('refuses a bad spec with the validateSpec text and writes nothing', async () => {
    const f = await setup();
    expect(await f.run(owner, create({ spec: { kind: 'once', at: NOW - MIN } }))).toEqual(refusal('bad-schedule', '一次性任务的时间已经过了'));
    expect(await f.run(owner, create({ timeZone: 'Mars/Olympus' }))).toEqual(refusal('bad-schedule', '不认识这个时区：Mars/Olympus'));
    expect(await f.run(owner, create({ spec: { kind: 'once', at: NOW + 400 * DAY } }))).toEqual(refusal('bad-schedule', '一次性任务最远只能排到一年后'));
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.scheduler.wake).not.toHaveBeenCalled();
  });
  it('answers a request the schema rejects with bad-schedule instead of throwing', async () => {
    const f = await setup([stored('st_a')]);
    expect(await f.run(owner, create({ name: '   ' }))).toMatchObject(refusal('bad-schedule'));
    expect(await f.run(owner, { action: 'nope', chatId: G } as unknown as ScheduleRequest)).toMatchObject(refusal('bad-schedule'));
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_a', patch: {} } as unknown as ScheduleRequest)).toMatchObject(refusal('bad-schedule'));
    expect(await f.run(owner, create({ spec: { kind: 'every', minutes: 0 } }))).toMatchObject(refusal('bad-schedule'));
    expect((await f.onDisk())[0]).toMatchObject({ revision: 'rev-st_a' });
  });
});

describe('edit, delete, pause and resume', () => {
  it('answers a stale revision with a conflict carrying the current task', async () => {
    const f = await setup([stored('st_a')]);
    const current = { id: 'st_a', revision: 'rev-st_a', name: '任务 st_a' };
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_a', revision: 'old', patch: { name: '改过' } })).toMatchObject({ kind: 'conflict', current });
    expect(await f.run(owner, { action: 'delete', chatId: G, taskId: 'st_a', revision: 'old' })).toMatchObject({ kind: 'conflict', current });
    expect(await f.onDisk()).toEqual([stored('st_a')]);
  });
  it('restarts the schedule from now when the spec changes', async () => {
    const f = await setup([stored('st_a', { counts: { runs: 9, missed: 0, skipped: 0, consecutiveFailures: 4 } })]);
    const reply = await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_a', revision: 'rev-st_a', patch: { spec: { kind: 'every', minutes: 60 } } });
    expect(reply).toMatchObject({ kind: 'task', task: { spec: { kind: 'every', minutes: 60, anchor: ceilToMinute(NOW) }, describe: '每 1 小时', nextRunAt: ceilToMinute(NOW) + HOUR } });
    const [saved] = await f.onDisk();
    expect(saved).toMatchObject({ cursor: NOW, counts: { runs: 9, consecutiveFailures: 0 } });
    expect(saved!.revision).not.toBe('rev-st_a');
    expect(f.scheduler.wake).toHaveBeenCalledTimes(1);
  });
  it('re-anchors on now when the minutes change, even if the edit carries the old anchor', async () => {
    const f = await setup([stored('st_a')]);
    const reply = await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_a', revision: 'rev-st_a', patch: { spec: { kind: 'every', minutes: 45, anchor: T0 } } });
    expect(reply).toMatchObject({ kind: 'task', task: { spec: { kind: 'every', minutes: 45, anchor: ceilToMinute(NOW) }, nextRunAt: ceilToMinute(NOW) + 45 * MIN } });
    expect((await f.onDisk())[0]).toMatchObject({ cursor: NOW });
  });
  it('brings a finished task back to active with a new time', async () => {
    const f = await setup([stored('st_once', { spec: { kind: 'once', at: T0 + HOUR }, state: 'finished', cursor: T0 + HOUR })]);
    const at = NOW + 2 * HOUR;
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_once', revision: 'rev-st_once', patch: { spec: { kind: 'once', at } } }))
      .toMatchObject({ kind: 'task', task: { state: 'active', nextRunAt: at } });
    expect((await f.onDisk())[0]).toMatchObject({ cursor: NOW });
  });
  it('leaves the slots alone when the edit re-sends the same schedule', async () => {
    const f = await setup([stored('st_a'), stored('st_b')]);
    await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_a', revision: 'rev-st_a', patch: { name: '改名', spec: { kind: 'every', minutes: 30 } } });
    // The view's spec sent back as it was, anchor and all.
    await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_b', revision: 'rev-st_b', patch: { name: '改名', spec: { kind: 'every', minutes: 30, anchor: T0 } } });
    expect(await f.onDisk()).toMatchObject([{ name: '改名', spec: { anchor: T0 }, cursor: T0 }, { name: '改名', spec: { anchor: T0 }, cursor: T0 }]);
  });
  it('validates an edited time zone and restarts from now when it changes', async () => {
    const f = await setup([stored('st_d', { spec: { kind: 'daily', time: '09:00' } })]);
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_d', revision: 'rev-st_d', patch: { timeZone: 'Nowhere/City' } })).toEqual(refusal('bad-schedule', '不认识这个时区：Nowhere/City'));
    expect(await f.run(owner, { action: 'edit', chatId: G, taskId: 'st_d', revision: 'rev-st_d', patch: { timeZone: 'europe/london' } })).toMatchObject({ kind: 'task', task: { timeZone: 'Europe/London' } });
    expect((await f.onDisk())[0]).toMatchObject({ timeZone: 'Europe/London', cursor: NOW });
  });
  it('lets a past once task be renamed with its zone sent again, and change only its zone', async () => {
    const past = { spec: { kind: 'once', at: NOW - HOUR }, state: 'finished', cursor: NOW - HOUR } as const;
    const f = await setup([stored('st_same', past), stored('st_zone', past), stored('st_bad', past)]);
    expect(await f.run(local, { action: 'edit', chatId: G, taskId: 'st_same', revision: 'rev-st_same', patch: { name: '改名', timeZone: 'asia/shanghai' } }))
      .toMatchObject({ kind: 'task', task: { name: '改名', timeZone: HOST, state: 'finished' } });
    expect(await f.run(local, { action: 'edit', chatId: G, taskId: 'st_zone', revision: 'rev-st_zone', patch: { timeZone: 'Asia/Tokyo' } }))
      .toMatchObject({ kind: 'task', task: { timeZone: 'Asia/Tokyo', state: 'finished' } });
    expect(await f.run(local, { action: 'edit', chatId: G, taskId: 'st_bad', revision: 'rev-st_bad', patch: { timeZone: 'Nowhere/City' } }))
      .toEqual(refusal('bad-schedule', '不认识这个时区：Nowhere/City'));
    expect(await f.onDisk()).toMatchObject([{ name: '改名', cursor: NOW - HOUR }, { timeZone: 'Asia/Tokyo', cursor: NOW }, { revision: 'rev-st_bad' }]);
  });
  it('resumes from now: slots of the pause are not caught up and the failure count is cleared', async () => {
    const f = await setup([stored('st_a', { state: 'paused', pausedReason: 'failures', counts: { runs: 10, missed: 0, skipped: 0, consecutiveFailures: 10 } })]);
    expect(await f.run(owner, { action: 'resume', chatId: G, taskId: 'st_a' })).toMatchObject({ kind: 'task', task: { state: 'active', counts: { consecutiveFailures: 0 } } });
    const [saved] = await f.onDisk();
    expect(saved).toMatchObject({ state: 'active', cursor: NOW });
    expect(saved).not.toHaveProperty('pausedReason');
  });
  it('finishes a paused once whose time passed and says it expired', async () => {
    const f = await setup([stored('st_once', { spec: { kind: 'once', at: NOW - HOUR }, state: 'paused', pausedReason: 'manual' })]);
    const reply = await f.run(owner, { action: 'resume', chatId: G, taskId: 'st_once' });
    expect(reply).toMatchObject({ kind: 'task', task: { state: 'finished' } });
    expect(reply.kind === 'task' && reply.task.describe).toMatch(/一次（已过期）$/);
    expect((await f.onDisk())[0]).toMatchObject({ state: 'finished', cursor: NOW });
  });
  it('treats pausing a paused task and resuming an active one as no change', async () => {
    const f = await setup([stored('st_on'), stored('st_off', { state: 'paused', pausedReason: 'manual' })]);
    expect(await f.run(owner, { action: 'resume', chatId: G, taskId: 'st_on' })).toMatchObject({ kind: 'task', task: { state: 'active', revision: 'rev-st_on' } });
    expect(await f.run(owner, { action: 'pause', chatId: G, taskId: 'st_off' })).toMatchObject({ kind: 'task', task: { state: 'paused', revision: 'rev-st_off' } });
    expect(f.scheduler.wake).not.toHaveBeenCalled();
  });
  it('deletes a running task with its records', async () => {
    const inflight = { runId: 'r0', slot: T0, trigger: 'schedule', startedAt: T0, revision: 'rev-st_run' } as const;
    const f = await setup([stored('st_run', { inflight })]);
    expect(await f.run(owner, { action: 'delete', chatId: G, taskId: 'st_run', revision: 'rev-st_run' })).toEqual({ kind: 'deleted', taskId: 'st_run' });
    expect(await f.onDisk()).toEqual([]);
  });
});

describe('run now', () => {
  it.each([
    [{ kind: 'not-started' }, refusal('bot-not-running', 'Bot 没在运行，任务暂时看不到；启动后再来。')],
    [{ kind: 'running' }, refusal('running', '这个任务正在运行，等它结束再试。')],
    [{ kind: 'not-found' }, refusal('not-found', '本群没有这个任务。')],
    [{ kind: 'started', runId: 'r1' }, { kind: 'started', taskId: 'st_a', runId: 'r1' }],
  ] satisfies [RunNowResult, object][])('maps the scheduler\'s %j', async (result, reply) => {
    const f = await setup([stored('st_a')], result);
    expect(await f.run(owner, { action: 'runNow', chatId: G, taskId: 'st_a' })).toEqual(reply);
    expect(f.scheduler.runNow).toHaveBeenCalledWith('st_a');
  });
});
