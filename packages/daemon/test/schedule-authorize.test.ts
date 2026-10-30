import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduleReply } from '@vonvon/protocol';
import { scheduleRefusalMessages } from '../src/admin/schedule-commands';
import { ADMIN, G, MEMBER, OTHER, OWNER, human, removeScheduleFixtures, scheduleFixture, stored } from './helpers/schedule-entry';

// T3 4.2 and 3.13"谁能做什么": the registry checks the role table first and a refusal never reaches the command core;
// the command core checks again on its own.
afterEach(removeScheduleFixtures);
const OTHER_MEMBER = 'ou_member_b';
const tasks = () => [stored('st_mine', { createdBy: { via: 'chat', openId: MEMBER, role: 'member' } }),
  stored('st_theirs', { createdBy: { via: 'chat', openId: OTHER_MEMBER, role: 'member' } }), stored('st_elsewhere', { chatId: OTHER })];
const create = { name: '日报', instruction: '发日报', when: { kind: 'daily', time: '09:00' } };
type Fixture = Awaited<ReturnType<typeof scheduleFixture>>;
/** Every write on one task, each with the reply kind it gets when allowed; revisions are read when the call is made. */
const writes = (f: Fixture, id: string) => [
  ['schedule_edit', () => ({ taskId: id, revision: f.store.get(id)?.revision, patch: { name: '改过' } }), 'task'],
  ['schedule_pause', () => ({ taskId: id }), 'task'], ['schedule_resume', () => ({ taskId: id }), 'task'],
  ['schedule_run_now', () => ({ taskId: id }), 'started'],
  ['schedule_delete', () => ({ taskId: id, revision: f.store.get(id)?.revision }), 'deleted'],
] as const;
/** The command core's answer inside an ok tool result. */
async function reply(f: Fixture, name: string, args: unknown = {}): Promise<ScheduleReply> {
  const result = await f.call(name, args);
  if (!result.ok) throw new Error(`refused by the registry: ${result.message}`);
  return JSON.parse(String(result.result).split('\n').slice(1).join('\n'));
}
const registryRefusal = (reason: string, message: string) => ({ ok: false, code: 'refused', reason, message });

describe('who may do what', () => {
  it.each([['owner', OWNER], ['admin', ADMIN]])('lets the %s do everything to anyone\'s task', async (_role, openId) => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open(human(openId));
    expect(await reply(f, 'schedule_create', create)).toMatchObject({ kind: 'task', task: { createdBy: { openId, role: _role } } });
    for (const [name, args, kind] of writes(f, 'st_theirs')) expect((await reply(f, name, args())).kind).toBe(kind);
  });
  it('lets a member do everything to their own task and nothing to another\'s', async () => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open(human(MEMBER));
    expect(await reply(f, 'schedule_create', create)).toMatchObject({ kind: 'task', task: { createdBy: { openId: MEMBER, role: 'member' } } });
    for (const [name, args] of writes(f, 'st_theirs')) {
      expect(await reply(f, name, args())).toEqual({ kind: 'refused', reason: 'not-task-owner', message: scheduleRefusalMessages['not-task-owner'] });
    }
    for (const [name, args, kind] of writes(f, 'st_mine')) expect((await reply(f, name, args())).kind).toBe(kind);
  });
  it('keeps a task\'s own run to that one task, and refuses the rest in the registry', async () => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open({ retry: false, initiative: false, wake: false, scheduled: { taskId: 'st_mine', runId: 'run-self' } });
    expect(await reply(f, 'schedule_list')).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_mine' }] });
    f.execute.mockClear();
    expect(await f.call('schedule_create', create)).toEqual(registryRefusal('no-human-create', scheduleRefusalMessages['no-human-create']));
    const others = [...writes(f, 'st_theirs'), ...writes(f, 'st_mine').filter(([name]) => name !== 'schedule_edit' && name !== 'schedule_delete')];
    for (const [name, args] of others) {
      expect(await f.call(name, args())).toEqual(registryRefusal('scheduled-run-scope', scheduleRefusalMessages['scheduled-run-scope']));
    }
    expect(f.execute).not.toHaveBeenCalled();
    expect(await reply(f, 'schedule_edit', { taskId: 'st_mine', revision: 'rev-st_mine', patch: { when: { kind: 'once', inMinutes: 20 } } })).toMatchObject({ kind: 'task' });
    expect(await reply(f, 'schedule_delete', { taskId: 'st_mine', revision: f.store.get('st_mine')?.revision })).toEqual({ kind: 'deleted', taskId: 'st_mine' });
  });
  it.each([
    ['a bot', { ...human(), requesterKind: 'bot' as const }],
    ['a wake', { ...human(), wake: true }],
    ['a retry', { ...human(), retry: true }],
    ['the smart mode on its own', { ...human(), initiative: true }],
  ])('lets a turn %s started only list', async (_case, facts) => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open(facts);
    expect(await reply(f, 'schedule_list')).toMatchObject({ kind: 'tasks', tasks: [{ id: 'st_mine' }, { id: 'st_theirs' }] });
    f.execute.mockClear();
    for (const [name, args] of [['schedule_create', () => create], ...writes(f, 'st_mine')] as const) {
      expect(await f.call(name, args())).toEqual(registryRefusal('not-human-turn', '这一轮不是由在场的人发起的，不能改任务。'));
    }
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('lets a turn someone else spoke into only list; the requester speaking again changes nothing', async () => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open(human(OWNER));
    f.entries.noteSteer(f.thread, { openId: OWNER, kind: 'user' });
    expect(await reply(f, 'schedule_pause', { taskId: 'st_mine' })).toMatchObject({ kind: 'task' });
    f.entries.noteSteer(f.thread, { openId: OTHER_MEMBER, kind: 'user' });
    f.execute.mockClear();
    expect(await f.call('schedule_create', create)).toMatchObject(registryRefusal('not-human-turn', scheduleRefusalMessages['not-human-turn']));
    expect(f.execute).not.toHaveBeenCalled();
    expect(await reply(f, 'schedule_list')).toMatchObject({ kind: 'tasks' });
  });
  it.each([['a private chat', { kind: 'p2p', chatId: 'oc_dm' }], ['a comment', { kind: 'doc', docId: 'doc' }]] as const)('has no task tools in %s', async (_case, place) => {
    const f = await scheduleFixture({ place });
    f.open(human());
    expect(f.entry.tools().filter(spec => spec.name.startsWith('schedule_'))).toEqual([]);
    for (const name of ['schedule_list', 'schedule_create']) {
      expect(await f.call(name, name === 'schedule_list' ? {} : create)).toEqual(registryRefusal('not-group', scheduleRefusalMessages['not-group']));
    }
    expect(f.execute).not.toHaveBeenCalled();
    const group = await scheduleFixture();
    expect(group.entry.tools().filter(spec => spec.name.startsWith('schedule_'))).toHaveLength(7);
  });
});

describe('the commit point and the second layer', () => {
  it('writes nothing once the turn has ended, also when it ends while the tool is still reading', async () => {
    const f = await scheduleFixture({ tasks: tasks() });
    const turn = f.open(human());
    let release!: () => void;
    const lookup = new Promise<void>(resolve => { release = resolve; });
    f.execute.mockImplementationOnce(async (...args) => { await lookup; return f.core(...args); });
    const editing = f.call('schedule_edit', { taskId: 'st_mine', revision: 'rev-st_mine', patch: { when: { kind: 'daily', time: '10:00' } } });
    turn.close();
    release();
    expect(await editing).toMatchObject({ ok: false, code: 'refused', reason: 'turn-ended' });
    expect(f.execute.mock.calls.map(call => call[1].action)).toEqual(['list']);
    expect(await f.call('schedule_create', create)).toMatchObject({ ok: false, reason: 'turn-ended' });
    expect(f.store.get('st_mine')?.spec).toEqual({ kind: 'daily', time: '09:00' });
  });
  it('lets a list in flight finish when someone else speaks in, and stops a write in flight at its commit point', async () => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open(human(OWNER));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.execute.mockImplementation(async (...args) => { await held; return f.core(...args); });
    const listing = f.call('schedule_list');
    const editing = f.call('schedule_edit', { taskId: 'st_mine', revision: 'rev-st_mine', patch: { where: 'newTopic' } });
    f.entries.noteSteer(f.thread, { openId: OTHER_MEMBER, kind: 'user' });
    release();
    expect(await listing).toMatchObject({ ok: true });
    expect(await editing).toMatchObject(registryRefusal('not-human-turn', scheduleRefusalMessages['not-human-turn']));
    expect(f.execute.mock.calls.map(call => call[1].action)).toEqual(['list', 'list']);
  });
  it('finds no task of another group through the tools, and the command core refuses every actor on its own', async () => {
    const f = await scheduleFixture({ tasks: tasks() });
    f.open(human(OWNER));
    expect(await reply(f, 'schedule_delete', { taskId: 'st_elsewhere', revision: 'rev-st_elsewhere' })).toMatchObject({ kind: 'refused', reason: 'not-found' });
    expect(f.request()).toMatchObject({ chatId: G });
    const self = { kind: 'scheduled', taskId: 'st_mine', runId: 'run-self', chatId: G } as const;
    const owner = { kind: 'chat', openId: OWNER, role: 'owner', chatId: G } as const;
    const request = { action: 'create', chatId: G, name: '日报', instruction: '发日报', spec: { kind: 'daily', time: '09:00' } } as const;
    expect(await f.commands.execute(self, request)).toMatchObject({ reason: 'no-human-create' });
    expect(await f.commands.execute(self, { action: 'pause', chatId: G, taskId: 'st_theirs' })).toMatchObject({ reason: 'scheduled-run-scope' });
    expect(await f.commands.execute({ ...owner, role: 'member', openId: MEMBER }, { action: 'pause', chatId: G, taskId: 'st_theirs' })).toMatchObject({ reason: 'not-task-owner' });
    expect(await f.commands.execute(owner, { action: 'list', chatId: OTHER })).toMatchObject({ reason: 'not-group' });
    expect(await f.commands.execute(owner, { action: 'pause', chatId: G, taskId: 'st_elsewhere' })).toMatchObject({ reason: 'not-found' });
    expect(f.store.get('st_theirs')?.state).toBe('active');
  });
});
