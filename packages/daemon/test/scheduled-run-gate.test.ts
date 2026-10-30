import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import type { createScheduler } from '../src/bot/schedule/scheduler';
import type { StoredTask } from '../src/bot/schedule/types';

type Deps = Parameters<typeof createScheduler>[0];
const fake = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  // A provider without the 只读 tier: a 只读 group's tier is unavailable.
  backend: { id: 'codex', supportedModes: ['write', 'full'], capabilities: {}, listModels: async () => [],
    listThreads: vi.fn(async () => [{ sessionId: 'past', preview: '', createdAt: 1, updatedAt: 1 }]), readHistory: vi.fn() },
  deps: undefined as Deps | undefined,
  hold: undefined as Promise<void> | undefined,
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/bot/schedule/scheduler', async original => {
  const real = await original<typeof import('../src/bot/schedule/scheduler')>();
  return { ...real, createScheduler: (deps: Deps) => { fake.deps = deps; return real.createScheduler(deps); } };
});
// A desktop edit can be held at its write of projects.json, while the group is being changed. (A mocked module is
// evaluated once per file, so the registry itself stays real: it follows each test's HOME.)
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, rename: async (...args: Parameters<typeof real.rename>) => {
    if (String(args[1]).endsWith('projects.json')) await fake.hold;
    return real.rename(...args);
  } };
});

const APP = 'cli_schedule_gate';
let root: string;
let file: string;
let registry: typeof import('../src/project/registry');
let o: ReturnType<typeof import('../src/bot/handle-message')['createOrchestrator']>;
const send = vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_sent' }));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  fake.hold = undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-schedule-gate-')));
  for (const dir of ['home', 'vonvon', 'workspace']) mkdirSync(join(root, dir));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  registry = await import('../src/project/registry');
  file = (await import('../src/config/paths')).botPaths(APP).schedulesFile;
  mkdirSync(dirname(file), { recursive: true });
  const cfg: AppConfig = { accounts: { app: { id: APP, secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
  const { createOrchestrator } = await import('../src/bot/handle-message');
  o = createOrchestrator({ send } as never, cfg, join(root, 'workspace'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await o.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const bind = (chatId: string, extra: Partial<Project> = {}) =>
  registry.addProject({ name: chatId, chatId, cwd: join(root, 'workspace'), blank: false, createdAt: 1, kind: 'single', mode: 'full', ...extra });
const revision = async (chatId: string) => (await import('../src/admin/collaboration')).projectRevision((await registry.getProjectByChatId(chatId))!);
const task = (id: string, chatId: string, patch: Partial<StoredTask> = {}): StoredTask => ({
  id, chatId, revision: `rev-${id}`, name: '日报', instruction: '写日报', spec: { kind: 'every', minutes: 30, anchor: 0 },
  timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: 0, updatedAt: 0,
  cursor: 0, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], ...patch,
});
const stored = (): StoredTask[] => (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks;

describe('scheduleGate (T2 4.2)', () => {
  it('maps an unbound, disabled and unavailable-tier group, and lets a ready one run', async () => {
    await bind('oc_on');
    await bind('oc_off', { enabled: false });
    await bind('oc_qa', { mode: 'qa' });
    expect(['oc_on', 'oc_off', 'oc_qa', 'oc_none'].map(chatId => fake.deps!.gate(chatId))).toEqual(['ok', 'disabled', 'tier-unavailable', 'unbound']);
  });

  it('is updating while the desktop changes the group or publishes a resumed session', async () => {
    await bind('oc_on');
    await bind('oc_multi', { kind: 'multi' });
    let release!: () => void;
    fake.hold = new Promise(resolve => { release = resolve; });
    const editing = o.collaboration({ action: 'editProject', projectName: 'oc_on', chatId: 'oc_on', expectedRevision: await revision('oc_on'), enabled: true });
    await vi.waitFor(() => expect(fake.deps!.gate('oc_on')).toBe('updating'));
    release();
    await editing;
    expect(fake.deps!.gate('oc_on')).toBe('ok');
    let fail!: (error: Error) => void;
    fake.backend.readHistory.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const resuming = o.collaboration({ action: 'resume', projectName: 'oc_multi', chatId: 'oc_multi', sessionId: 'past', backend: 'codex' });
    await vi.waitFor(() => expect(fake.deps!.gate('oc_multi')).toBe('updating'));
    fail(new Error('history unavailable'));
    await expect(resuming).rejects.toThrow('history unavailable');
    expect(fake.deps!.gate('oc_multi')).toBe('ok');
  });

  it('says in the main area, at most once an hour per task, that the tier is unavailable', async () => {
    await bind('oc_qa', { mode: 'qa' });
    const daily = task('st_00000000000000a1', 'oc_qa');
    fake.deps!.notifyGateFailure(daily);
    fake.deps!.notifyGateFailure(daily);
    fake.deps!.notifyGateFailure({ ...daily, id: 'st_00000000000000a2', name: '周报' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, 'oc_qa', { text: '⏰ 定时任务「日报」这次没跑：本群的权限档现在用不了（这个 provider 没有这一档）。连续 10 次会自动暂停。' });
    const later = Date.now() + 60 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    fake.deps!.notifyGateFailure(daily);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  });

  it('shows an `<at>` in the task\'s name as plain text, not a mention', async () => {
    await bind('oc_qa', { mode: 'qa' });
    fake.deps!.notifyGateFailure(task('st_00000000000000a1', 'oc_qa', { name: '<at user_id="all"></at>' }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith('oc_qa', { text: '⏰ 定时任务「@所有人」这次没跑：本群的权限档现在用不了（这个 provider 没有这一档）。连续 10 次会自动暂停。' });
  });

  it.each([['<at user_id=all', '@'], ['日报 <at user_id=all', '日报 @']])('an unclosed `<at>` in the name %s takes only the name, not the rest of the line', async (name, shown) => {
    await bind('oc_qa', { mode: 'qa' });
    fake.deps!.notifyGateFailure(task('st_00000000000000a1', 'oc_qa', { name }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const { text } = send.mock.calls[0]![1] as { text: string };
    expect(text).toBe(`⏰ 定时任务「${shown}」这次没跑：本群的权限档现在用不了（这个 provider 没有这一档）。连续 10 次会自动暂停。`);
    expect(text).toContain('这次没跑');
    expect(text).toContain('连续 10 次会自动暂停');
    expect(text).not.toContain('<at');
  });
});

describe('unbinding pauses the group\'s tasks as unavailable (T2 4.6)', () => {
  const unbinds: [string, () => Promise<unknown>][] = [
    ['the bot removed from the group', () => o.onBotRemovedFromChat('oc_a')],
    ['the desktop unbinding it', async () => o.collaboration({ action: 'removeProject', projectName: 'oc_a', chatId: 'oc_a', expectedRevision: await revision('oc_a') })],
    ['the DM console deleting the project', async () => {
      const { DM } = await import('../src/card/dm-cards');
      await o.dispatcher.handle({ messageId: 'om_console', chatId: 'oc_dm', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: DM.rmDo, n: 'oc_a' } } } as unknown as CardActionEvent);
    }],
  ];
  it.each(unbinds)('%s', async (_name, unbind) => {
    await bind('oc_a');
    await bind('oc_b');
    const manual = task('st_00000000000000a2', 'oc_a', { state: 'paused', pausedReason: 'manual' });
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [task('st_00000000000000a1', 'oc_a'), manual, task('st_00000000000000b1', 'oc_b')] }));
    await o.initialize?.();
    await unbind().catch(() => undefined); // leaving the group fails here; the unbind is done before it
    await vi.waitFor(() => expect(stored()[0]).toMatchObject({ state: 'paused', pausedReason: 'unavailable' }));
    expect(await registry.getProjectByChatId('oc_a')).toBeUndefined();
    const [paused, kept, other] = stored();
    expect(paused!.revision).not.toBe('rev-st_00000000000000a1');
    expect(kept).toEqual(manual);
    expect(other).toEqual(task('st_00000000000000b1', 'oc_b'));
  });
});
