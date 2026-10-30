import { afterEach, describe, expect, it } from 'vitest';
import { createScheduleTools, scheduleToolNames, scheduleToolSpecs } from '../src/agent/entry/schedule-tools';
import { parseLocal } from '../src/bot/schedule/time';
import { G, HOST, MIN, NOW, OWNER, removeScheduleFixtures, scheduleFixture, stored } from './helpers/schedule-entry';

// T3 4.1: one zod definition for both providers; `when` read by the daemon; one line of words above the reply's JSON.
afterEach(removeScheduleFixtures);
const daily = { name: '日报', instruction: '总结今天群里聊了什么', when: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' } };
const lines = (text: string) => { const [first, ...rest] = text.split('\n'); return { first, json: JSON.parse(rest.join('\n')) }; };

describe('the seven tools', () => {
  it('share one definition: seven names, JSON schemas of objects, no group parameter', () => {
    const specs = scheduleToolSpecs();
    expect(specs.map(spec => spec.name)).toEqual(['schedule_list', 'schedule_create', 'schedule_edit', 'schedule_pause', 'schedule_resume', 'schedule_delete', 'schedule_run_now']);
    expect([...scheduleToolNames]).toEqual(specs.map(spec => spec.name));
    for (const spec of specs) expect(spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(specs)).not.toMatch(/chatId|botId/);
    const tools = createScheduleTools({ commands: { execute: async () => ({ kind: 'deleted', taskId: 'x' }) } });
    expect(tools.map(tool => [tool.class, tool.description])).toEqual(specs.map(spec => ['schedule', spec.description]));
    expect(tools.find(tool => tool.name === 'schedule_create')?.description).toBe('给本群建一个定时任务，或给自己排一个稍后回来的一次性任务；时间用 when 写，不用算毫秒。');
  });

  it('tells an edit that a missing zone is the task\'s own, and a create that it is the daemon\'s', () => {
    const schema = (name: string) => scheduleToolSpecs().find(spec => spec.name === name)?.inputSchema as
      { properties: { timeZone: { description: string }; patch: { properties: { timeZone: { description: string } } } } };
    expect(schema('schedule_create').properties.timeZone.description).toBe('IANA 时区名，比如 Asia/Shanghai；不写就用 daemon 所在电脑的时区');
    expect(schema('schedule_edit').properties.patch.properties.timeZone.description).toBe('IANA 时区名；不写就按这个任务自己的时区（schedule_list 里的 timeZone）');
  });

  it.each([
    ['a group', { ...daily, chatId: 'oc_x' }],
    ['epoch milliseconds', { ...daily, when: { kind: 'once', at: NOW + MIN } }],
    ['both at and inMinutes', { ...daily, when: { kind: 'once', at: '2026-11-01 14:00', inMinutes: 5 } }],
    ['a zero interval', { ...daily, when: { kind: 'every', minutes: 0 } }],
    ['a 41-character name', { ...daily, name: '名'.repeat(41) }],
    ['an unknown place', { ...daily, where: 'otherGroup' }],
  ])('refuses %s as bad arguments before the command core', async (_case, args) => {
    const f = await scheduleFixture();
    f.open();
    expect(await f.call('schedule_create', args)).toMatchObject({ ok: false, code: 'bad-args' });
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe('when becomes a spec', () => {
  it.each([
    [{ kind: 'once', at: '2026-11-01 14:00' }, { kind: 'once', at: parseLocal(HOST, '2026-11-01 14:00') }],
    [{ kind: 'once', inMinutes: 20 }, { kind: 'once', at: NOW + 20 * MIN }],
    [{ kind: 'every', minutes: 30 }, { kind: 'every', minutes: 30 }],
    [{ kind: 'daily', time: '09:00' }, { kind: 'daily', time: '09:00' }],
    [{ kind: 'cron', expr: '0 9 * * 1-5' }, { kind: 'cron', expr: '0 9 * * 1-5' }],
  ])('%j', async (when, spec) => {
    const f = await scheduleFixture();
    f.open();
    expect(await f.call('schedule_create', { ...daily, when })).toMatchObject({ ok: true });
    expect(f.request()).toMatchObject({ action: 'create', chatId: G, spec });
  });
  it.each([
    ['15 seconds past', 15_003, 21],
    ['on', MIN, 21],
  ])('puts inMinutes on a whole minute: %s the minute', async (_case, offset, minutes) => {
    const f = await scheduleFixture({ now: NOW + offset });
    f.open();
    expect(await f.call('schedule_create', { ...daily, when: { kind: 'once', inMinutes: 20 } })).toMatchObject({ ok: true });
    expect(f.request()).toMatchObject({ spec: { kind: 'once', at: NOW + minutes * MIN } });
  });
  it('reads a once in the zone given, and an edit in the task\'s own zone', async () => {
    const f = await scheduleFixture({ tasks: [stored('st_tokyo', { timeZone: 'Asia/Tokyo' })] });
    f.open();
    await f.call('schedule_create', { ...daily, when: { kind: 'once', at: '2026-11-01 14:00' }, timeZone: 'Asia/Tokyo' });
    expect(f.request()).toMatchObject({ spec: { at: parseLocal('Asia/Tokyo', '2026-11-01 14:00') }, timeZone: 'Asia/Tokyo' });
    await f.call('schedule_edit', { taskId: 'st_tokyo', revision: 'rev-st_tokyo', patch: { when: { kind: 'once', at: '2026-11-02 08:00' } } });
    expect(f.request()).toMatchObject({ action: 'edit', patch: { spec: { kind: 'once', at: parseLocal('Asia/Tokyo', '2026-11-02 08:00') } } });
  });
  it.each([
    [{ kind: 'once', at: '2026-13-01 00:00' }, undefined, '一次性任务的时间要写成 YYYY-MM-DD HH:mm，比如 2026-11-01 14:00'],
    [{ kind: 'once', at: '2026-11-01 14:00' }, 'Mars/Base', '不认识这个时区：Mars/Base'],
    [{ kind: 'once', at: '2026-10-31 14:00' }, undefined, '一次性任务的时间已经过了'],
    [{ kind: 'every', minutes: 30 }, 'Mars/Base', '不认识这个时区：Mars/Base'],
  ])('answers %j in %s with bad-schedule, without throwing', async (when, timeZone, message) => {
    const f = await scheduleFixture();
    f.open();
    const { first, json } = lines(await f.text('schedule_create', { ...daily, when, ...(timeZone ? { timeZone } : {}) }));
    expect(first).toBe(message);
    expect(json).toMatchObject({ kind: 'refused', reason: 'bad-schedule' });
    expect(f.store.all()).toEqual([]);
  });
});

describe('replies: a line, then the JSON as it is', () => {
  it('create, list, edit, pause, resume, run now, delete', async () => {
    const recent = Array.from({ length: 5 }, (_, i) => ({ runId: `r${i}`, slot: NOW - (5 - i) * MIN, trigger: 'schedule' as const, status: 'done' as const }));
    const f = await scheduleFixture({ tasks: [stored('st_old', { recent })] });
    f.open();
    const created = lines(await f.text('schedule_create', daily));
    expect(created.first).toBe('已创建：日报 · 每个工作日 09:00 · 下次 11-02 09:00（Asia/Shanghai）');
    expect(created.json).toMatchObject({ kind: 'task', task: { name: '日报', placement: { kind: 'follow' }, createdBy: { via: 'chat', name: '主人', text: '每天 9 点发日报' } } });
    const listed = lines(await f.text('schedule_list'));
    expect(listed.first).toBe('现在 2026-11-01 10:00（Asia/Shanghai）· 本群 2 个任务');
    expect(listed.json).toMatchObject({ kind: 'tasks', now: NOW, timeZone: HOST });
    expect(listed.json.tasks[0].recent.map((r: { runId: string }) => r.runId)).toEqual(['r2', 'r3', 'r4']);
    expect(lines(await f.text('schedule_edit', { taskId: 'st_old', revision: 'rev-st_old', patch: { name: '早报' } })).first)
      .toBe('已修改：早报 · 每天 09:00 · 下次 11-02 09:00（Asia/Shanghai）');
    expect(lines(await f.text('schedule_edit', { taskId: 'st_old', revision: 'rev-st_old', patch: { name: '晚报' } })))
      .toMatchObject({ first: '这个任务刚被改过，revision 对不上；下面是现在的内容，看过再决定要不要改。', json: { kind: 'conflict', current: { name: '早报' } } });
    expect(lines(await f.text('schedule_pause', { taskId: 'st_old' })).first).toBe('已暂停：早报 · 每天 09:00');
    expect(lines(await f.text('schedule_resume', { taskId: 'st_old' })).first).toBe('已恢复：早报 · 每天 09:00 · 下次 11-02 09:00（Asia/Shanghai）');
    expect(lines(await f.text('schedule_run_now', { taskId: 'st_old' }))).toEqual({ first: '已开始运行，不影响下一次定时。', json: { kind: 'started', taskId: 'st_old', runId: 'run-1' } });
    const revision = f.store.get('st_old')?.revision;
    expect(lines(await f.text('schedule_delete', { taskId: 'st_old', revision }))).toEqual({ first: '已删除：st_old', json: { kind: 'deleted', taskId: 'st_old' } });
  });
  it('answers a refusal as a reply: the section 16 line and the reason', async () => {
    const f = await scheduleFixture();
    f.open();
    const reply = await f.call('schedule_pause', { taskId: 'st_missing' });
    expect(reply).toMatchObject({ ok: true });
    expect(lines(String(reply.ok && reply.result))).toEqual({ first: '本群没有这个任务。',
      json: { kind: 'refused', reason: 'not-found', message: '本群没有这个任务。' } });
  });
});

describe('what the agent reads of a task', () => {
  const long = (units: number) => '长'.repeat(units);
  const link = 'https://applink.feishu.cn/client/message/link/open?token=AmFkZQ';
  /** Every field at its limit, and every Feishu id a task can carry. */
  const full = (id: string) => stored(id, {
    name: long(40), instruction: long(4000), placement: { kind: 'topic', topicId: 'omt_topic' },
    createdBy: { via: 'chat', openId: 'ou_creator', name: long(40), role: 'member', messageId: 'om_created', text: long(500) },
    lastResult: { at: NOW - MIN, status: 'failed', excerpt: long(500), messageId: 'om_result', link },
    recent: Array.from({ length: 20 }, (_, i) => ({ runId: `run-${i}`, slot: NOW - (20 - i) * MIN, trigger: 'schedule' as const, status: 'failed' as const,
      startedAt: NOW - (20 - i) * MIN, endedAt: NOW - (20 - i) * MIN + 1000, durationMs: 1000, messageId: `om_run${i}`, topicId: `omt_run${i}`, link, error: long(200) })),
  });

  it('keeps a list of 20 tasks at every limit under the registry\'s cap, the free text cut with a mark', async () => {
    const f = await scheduleFixture({ tasks: Array.from({ length: 20 }, (_, i) => full(`st_${i}`)) });
    f.open();
    const reply = await f.call('schedule_list');
    expect(reply).toMatchObject({ ok: true });
    const text = String(reply.ok && reply.result);
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThan(256 * 1024);
    const { json } = lines(text);
    expect(json.tasks).toHaveLength(20);
    const [task] = json.tasks;
    expect(task.instruction).toBe(`${long(999)}…`);
    expect(task.createdBy).toEqual({ via: 'chat', name: long(40), text: `${long(199)}…` });
    expect(task.lastResult).toEqual({ status: 'failed', at: NOW - MIN, excerpt: `${long(199)}…`, link });
    expect(task.recent.map((run: { runId: string }) => run.runId)).toEqual(['run-17', 'run-18', 'run-19']);
    expect(task.recent[2]).toEqual({ runId: 'run-19', slot: NOW - MIN, trigger: 'schedule', status: 'failed', startedAt: NOW - MIN, endedAt: NOW - MIN + 1000,
      durationMs: 1000, link, error: long(200) });
    expect(Object.keys(task).sort()).toEqual(['createdBy', 'describe', 'id', 'instruction', 'lastResult', 'name', 'nextRunAt', 'placement', 'recent', 'revision', 'running', 'state', 'timeZone'].sort());
  });
  it('shows no group id and no raw Feishu ids in a list or a single task, and a single task keeps its instruction whole', async () => {
    const f = await scheduleFixture({ tasks: [full('st_full')] });
    f.open();
    const replies = [await f.text('schedule_list'), await f.text('schedule_create', daily), await f.text('schedule_pause', { taskId: 'st_full' }),
      await f.text('schedule_edit', { taskId: 'st_full', revision: 'stale', patch: { name: '早报' } })];
    for (const text of replies) expect(text).not.toMatch(/oc_|ou_|om_/);
    expect(lines(replies[2]!).json).toMatchObject({ kind: 'task', task: { state: 'paused', pausedReason: 'manual', instruction: long(4000) } });
    expect(lines(replies[3]!).json).toMatchObject({ kind: 'conflict', current: { instruction: long(4000), createdBy: { text: long(500) } } });
    // The store keeps them all; only the agent's view leaves them out.
    expect(f.store.get('st_full')).toMatchObject({ chatId: G, createdBy: { openId: 'ou_creator', messageId: 'om_created' }, lastResult: { messageId: 'om_result' } });
    expect(f.store.all().find(task => task.name === '日报')).toMatchObject({ chatId: G, createdBy: { openId: OWNER, messageId: 'om_trigger' } });
  });
});
