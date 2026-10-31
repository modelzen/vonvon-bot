import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { createScheduler, Scheduler } from '../src/bot/schedule/scheduler';
import type { ScheduleStore } from '../src/bot/schedule/store';
import type { StoredTask } from '../src/bot/schedule/types';

type Deps = Parameters<typeof createScheduler>[0];
const fake = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  backend: { id: 'codex', capabilities: {}, listModels: async () => [] },
  deps: undefined as Deps | undefined,
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/bot/schedule/scheduler', async original => {
  const real = await original<typeof import('../src/bot/schedule/scheduler')>();
  return { ...real, createScheduler: (deps: Deps) => { fake.deps = deps; return real.createScheduler(deps); } };
});

const A = Date.parse('2026-11-02T01:00:00Z'), MIN = 60_000;
const head = '定时任务「日报」连续 10 次失败，已自动暂停。';
const tail = '看一下：后端失败。到群设置的"任务"里能恢复。';
let root: string;
let o: ReturnType<typeof import('../src/bot/handle-message')['createOrchestrator']>;
let scheduler: Scheduler | undefined;
let clock = 0;
const send = vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_notice' }));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-schedule-pause-')));
  for (const dir of ['home', 'vonvon', 'workspace']) mkdirSync(join(root, dir));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  const registry = await import('../src/project/registry');
  for (const [chatId, enabled] of [['oc_a', true], ['oc_off', false]] as const) {
    await registry.addProject({ name: chatId, chatId, cwd: join(root, 'workspace'), blank: false, createdAt: 1, kind: 'single', enabled });
  }
  const cfg: AppConfig = { accounts: { app: { id: 'cli_schedule_pause', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
  o = (await import('../src/bot/handle-message')).createOrchestrator({ send } as never, cfg, join(root, 'workspace'));
});
afterEach(async () => {
  scheduler?.stop();
  await o.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const task = (patch: Partial<StoredTask> = {}): StoredTask => ({
  id: 'st_00000000000000a1', chatId: 'oc_a', revision: 'rev', name: '日报', instruction: '写日报', spec: { kind: 'every', minutes: 1, anchor: A },
  timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'chat', openId: 'ou_zhang', name: '张三' }, createdAt: A, updatedAt: A,
  cursor: A, counts: { runs: 9, missed: 0, skipped: 0, consecutiveFailures: 9 }, recent: [], ...patch,
});
/** The orchestrator's notifyAutoPause on a scheduler whose runs all fail, one minute after the task's last slot. */
async function drive(seeded: StoredTask): Promise<ScheduleStore> {
  const file = join(root, 'schedules.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [seeded] }));
  const { createScheduleStore } = await import('../src/bot/schedule/store');
  const { createScheduler: real } = await vi.importActual<typeof import('../src/bot/schedule/scheduler')>('../src/bot/schedule/scheduler');
  clock = A + MIN + 1_000;
  const now = () => clock;
  const store = createScheduleStore(file, { now, log: fake.log, diagnostics: () => {} });
  scheduler = real({ ...fake.deps!, store, now, run: async () => ({ status: 'failed', error: '后端失败。', durationMs: 5, counts: true }) });
  await scheduler.start(await store.load());
  return store;
}

it('the tenth failure in a row posts once in the main area, at-ing the creator, word for word', async () => {
  const store = await drive(task());
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')).toMatchObject({ state: 'paused', pausedReason: 'failures' }));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.noticePending).toBeUndefined());
  scheduler!.wake();
  await scheduler!.drain(1_000);
  expect(send).toHaveBeenCalledExactlyOnceWith('oc_a', { post: { zh_cn: { content: [[
    { tag: 'text', text: head }, { tag: 'at', user_id: 'ou_zhang' }, { tag: 'text', text: ` ${tail}` },
  ]] } } });
});

it('an `<at>` in the task\'s name is plain text in the post and the main area\'s recent line', async () => {
  const { RecentLines } = await import('../src/bot/recent-lines');
  const addOwn = vi.spyOn(RecentLines.prototype, 'addOwn');
  const store = await drive(task({ name: '<at id=all></at>日报 <at id=all' }));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.state).toBe('paused'));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.noticePending).toBeUndefined());
  const shown = '定时任务「@所有人日报 @」连续 10 次失败，已自动暂停。';
  expect(send).toHaveBeenCalledExactlyOnceWith('oc_a', { post: { zh_cn: { content: [[
    { tag: 'text', text: shown }, { tag: 'at', user_id: 'ou_zhang' }, { tag: 'text', text: ` ${tail}` },
  ]] } } });
  expect(addOwn).toHaveBeenCalledExactlyOnceWith('oc_a', 'oc_a', expect.objectContaining({ text: `${shown}@张三 ${tail}` }));
});

// A post's text element and the recent line are read by no at-guard, which leaves a tag across a line break alone anyway.
it.each(['<at\nuser_id=all></at>', '<at user_id=all\n></at>'])('a tag across a line break in the name %j is left in neither the post nor the recent line', async name => {
  const { RecentLines } = await import('../src/bot/recent-lines');
  const addOwn = vi.spyOn(RecentLines.prototype, 'addOwn');
  const store = await drive(task({ name }));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.state).toBe('paused'));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.noticePending).toBeUndefined());
  const shown = `定时任务「${name.replace(/</g, '＜').replace(/>/g, '＞')}」连续 10 次失败，已自动暂停。`;
  expect(send).toHaveBeenCalledExactlyOnceWith('oc_a', { post: { zh_cn: { content: [[
    { tag: 'text', text: shown }, { tag: 'at', user_id: 'ou_zhang' }, { tag: 'text', text: ` ${tail}` },
  ]] } } });
  expect(JSON.stringify(send.mock.calls)).not.toContain('<at');
  expect(addOwn).toHaveBeenCalledExactlyOnceWith('oc_a', 'oc_a', expect.objectContaining({ text: `${shown}@张三 ${tail}` }));
});

it('a creator without an open id is not at-ed', async () => {
  const store = await drive(task({ createdBy: { via: 'desktop' } }));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.state).toBe('paused'));
  await vi.waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('oc_a', { post: { zh_cn: { content: [[{ tag: 'text', text: head + tail }]] } } }));
});

it('a notice that was not sent stays pending and goes out at the next tick', async () => {
  send.mockRejectedValueOnce(new Error('offline'));
  const paused = task({ state: 'paused', pausedReason: 'failures', noticePending: true, noticeSince: A, counts: { runs: 10, missed: 0, skipped: 0, consecutiveFailures: 10 },
    recent: [{ runId: 'run-10', slot: A, trigger: 'schedule', status: 'failed', error: '后端失败', startedAt: A, endedAt: A }] });
  const store = await drive(paused);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  await scheduler!.drain(1_000);
  expect(store.get('st_00000000000000a1')?.noticePending).toBe(true);
  scheduler!.wake(); // tried 0 seconds ago: at most one try per 30 seconds
  await scheduler!.drain(1_000);
  expect(send).toHaveBeenCalledOnce();
  clock += 30_000;
  scheduler!.wake();
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.noticePending).toBeUndefined());
  expect(send).toHaveBeenCalledTimes(2);
});

it('says nothing in a disabled group, and the notice is dropped', async () => {
  const store = await drive(task({ chatId: 'oc_off', state: 'paused', pausedReason: 'failures', noticePending: true, noticeSince: A }));
  await vi.waitFor(() => expect(store.get('st_00000000000000a1')?.noticePending).toBeUndefined());
  expect(send).not.toHaveBeenCalled();
});
