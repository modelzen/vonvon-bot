import {expect, it, vi} from 'vitest';
import {agentIdSchema, jobIdSchema, type AgentId, type Command, type CommandResult, type DesktopSnapshot, type Job} from '@vonvon/protocol';
import type {RegisterModal} from '../src/setup/GrantStep';
import {canRetryRegistration, createRegistrationRetry} from '../src/setup/registration-retry';

const oldJobId = jobIdSchema.parse('job_registration_old');
const newJobId = jobIdSchema.parse('job_registration_new');
const existingId = agentIdSchema.parse('cli_retry_existing');
const registeredId = agentIdSchema.parse('cli_retry_new');
const otherId = agentIdSchema.parse('cli_retry_other');
const failed: Job = {id: oldJobId, type: 'registerAgent', phase: 'failed', message: '注册失败'};
const cancelled: Job = {...failed, phase: 'cancelled', message: '已取消'};
const succeeded: Job = {...failed, phase: 'succeeded', message: '已保存', agentId: registeredId};
const activating: Job = {...failed, phase: 'activating', message: '正在保存'};
const qr = (expiresAt: number): Job => ({id: oldJobId, type: 'registerAgent', phase: 'qr', image: 'data:image/png;base64,', url: 'https://example.test/register', expiresAt});
const snapshot = (jobs: Job[] = [cancelled], ids: AgentId[] = [existingId]): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: ids.map(id => ({id, name: id, enabled: true, running: true, connection: 'connected', activation: 'active'})),
  groups: [], memberships: [], tools: [], jobs,
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function fixture(options: {modal?: Partial<RegisterModal>; before?: DesktopSnapshot; after?: DesktopSnapshot; cancelResult?: CommandResult} = {}) {
  const modal: RegisterModal = {kind: 'register', jobId: oldJobId, initialAgentIds: [existingId], ...options.modal};
  let live = true;
  let latest = options.before ?? snapshot([failed]);
  const calls: Array<Command | 'snapshot'> = [];
  const read = vi.fn(async () => { calls.push('snapshot'); return options.after ?? snapshot(); });
  const run = vi.fn(async (command: Command): Promise<CommandResult> => {
    calls.push(command);
    return command.type === 'cancelJob' ? options.cancelResult ?? {kind: 'cancelled'} : {kind: 'started', jobId: newJobId};
  });
  const retry = createRegistrationRetry();
  return {modal, calls, read, run, close: () => { live = false; }, publish: (value: DesktopSnapshot) => { latest = value; },
    retry: () => retry({modal, current: () => live, latest: () => latest, read, run})};
}
const cancelCommand: Command = {type: 'cancelJob', jobId: oldJobId};
const startCommand: Command = {type: 'registerAgent'};

it('allows only missing, failed, cancelled or expired QR jobs to restart', () => {
  const now = 1000;
  expect([undefined, failed, cancelled, qr(now - 1), qr(now)].map(job => canRetryRegistration(job, now))).toEqual([true, true, true, true, true]);
  const running: Job = {...failed, phase: 'running'};
  const unresolved: Job = {...failed, phase: 'unresolved'};
  expect([qr(now + 1), activating, succeeded, running, unresolved].map(job => canRetryRegistration(job, now))).toEqual([false, false, false, false, false]);
});

it.each<CommandResult>([{kind: 'cancelled'}, {kind: 'refused', code: 'unknown_job', message: '任务已过期'}])('cancels first, rechecks, then starts once after $kind', async cancelResult => {
  const f = fixture({cancelResult});
  expect(await f.retry()).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId}});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]);
});

it('restarts after a vanished task only when cancellation and the fresh Bot baseline check allow it', async () => {
  const f = fixture({before: snapshot([]), after: snapshot([]), cancelResult: {kind: 'refused', code: 'unknown_job', message: '任务已过期'}});
  expect(await f.retry()).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId}});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]);
});

it('locks synchronously against a second click while cancellation is in flight', async () => {
  const f = fixture();
  const pending = deferred<CommandResult>();
  f.run.mockImplementationOnce(async command => { f.calls.push(command); return pending.promise; });
  const first = f.retry();
  expect(await f.retry()).toEqual({kind: 'ignored'});
  expect(f.calls).toEqual([cancelCommand]);
  pending.resolve({kind: 'cancelled'});
  expect(await first).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId}});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]);
});

it.each<CommandResult>([
  {kind: 'refused', code: 'busy', message: '仍在保存'},
  {kind: 'outcomeUnknown', message: '取消结果不明'},
  {kind: 'applied', revision: 2},
])('does not read or restart when cancellation returns $kind', async cancelResult => {
  const f = fixture({cancelResult});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('旧注册')});
  expect(f.calls).toEqual([cancelCommand]);
  expect(f.read).not.toHaveBeenCalled();
});

it('does not restart if reading the cancellation result snapshot fails, and releases the click lock', async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error('后台状态读取失败'));
  expect(await f.retry()).toEqual({kind: 'blocked', message: '后台状态读取失败'});
  expect(f.run.mock.calls).toEqual([[cancelCommand]]);
  expect(await f.retry()).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId}});
  expect(f.run.mock.calls).toEqual([[cancelCommand], [cancelCommand], [startCommand]]);
});

it('does not restart from a fresh snapshot whose host is disconnected', async () => {
  const f = fixture({after: {...snapshot(), host: {kind: 'disconnected', message: '连接中断'}}});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('恢复连接')});
  expect(f.calls).toEqual([cancelCommand, 'snapshot']);
});

it('does not touch an activating job or an already registered modal', async () => {
  const active = fixture({before: snapshot([activating])});
  expect(await active.retry()).toEqual({kind: 'ignored'});
  expect(active.calls).toEqual([]);
  const registered = fixture({modal: {agentId: registeredId}});
  expect(await registered.retry()).toEqual({kind: 'ready', modal: registered.modal});
  expect(registered.calls).toEqual([]);
});

it('advances an already successful job without cancelling or registering again', async () => {
  const f = fixture({before: snapshot([succeeded], [existingId, registeredId])});
  expect(await f.retry()).toEqual({kind: 'ready', modal: {...f.modal, agentId: registeredId}});
  expect(f.calls).toEqual([]);
});

it('advances the old job if its successful save arrives while cancellation is pending', async () => {
  const f = fixture({after: snapshot([succeeded], [existingId, registeredId])});
  const pending = deferred<CommandResult>();
  f.run.mockImplementationOnce(async command => { f.calls.push(command); return pending.promise; });
  const result = f.retry();
  f.publish(snapshot([succeeded], [existingId, registeredId]));
  pending.resolve({kind: 'cancelled'});
  expect(await result).toEqual({kind: 'ready', modal: {...f.modal, agentId: registeredId}});
  expect(f.calls).toEqual([cancelCommand, 'snapshot']);
});

it('blocks when the old job is still activating after cancellation instead of creating a second job', async () => {
  const f = fixture({after: snapshot([activating])});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('仍在处理中')});
  expect(f.calls).toEqual([cancelCommand, 'snapshot']);
});

it.each([false, true])('compares new Bots with the initial dialog baseline, including changes visible before retry: %s', async visibleBeforeRetry => {
  const changed = snapshot([], [existingId, registeredId]);
  const f = fixture({before: visibleBeforeRetry ? changed : snapshot([failed]), after: changed});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('避免重复注册')});
  expect(f.calls).toEqual([cancelCommand, 'snapshot']);
});

it('blocks a first-registration retry when its original Bot baseline is unavailable', async () => {
  const f = fixture({modal: {initialAgentIds: undefined}});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('避免重复注册')});
  expect(f.calls).toEqual([cancelCommand, 'snapshot']);
});

it('refreshes the saved target even if another Bot appears or is ordered first in the latest list', async () => {
  const f = fixture({modal: {refresh: true, refreshAgentId: existingId}, after: snapshot([cancelled], [otherId, existingId])});
  expect(await f.retry()).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId}});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', {type: 'refreshAgentCredentials', agentId: existingId}]);
});

it('does not turn a credential refresh without its target into a new registration', async () => {
  const f = fixture({modal: {refresh: true}});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('要刷新的 Bot')});
  expect(f.calls).toEqual([]);
});

it('retains a new job success snapshot delivered before its started command reply', async () => {
  const f = fixture();
  const started = deferred<CommandResult>();
  f.run.mockImplementation(async command => {
    f.calls.push(command);
    if (command.type === 'cancelJob') return {kind: 'cancelled'};
    f.publish(snapshot([{...succeeded, id: newJobId}], [existingId, registeredId]));
    return started.promise;
  });
  const result = f.retry();
  await vi.waitFor(() => expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]));
  started.resolve({kind: 'started', jobId: newJobId});
  expect(await result).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId, agentId: registeredId}});
});

it.each(['cancel', 'snapshot'] as const)('stops without a new registration when the dialog closes during %s', async stage => {
  const f = fixture();
  const cancellation = deferred<CommandResult>();
  const reading = deferred<DesktopSnapshot>();
  if (stage === 'cancel') f.run.mockImplementationOnce(async command => { f.calls.push(command); return cancellation.promise; });
  else f.read.mockImplementationOnce(async () => { f.calls.push('snapshot'); return reading.promise; });
  const result = f.retry();
  if (stage === 'snapshot') await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
  f.close();
  cancellation.resolve({kind: 'cancelled'});
  reading.resolve(snapshot());
  expect(await result).toEqual({kind: 'ignored'});
  expect(f.calls).toEqual(stage === 'cancel' ? [cancelCommand] : [cancelCommand, 'snapshot']);
});

it('cancels the new job if the dialog closes while the start command is pending', async () => {
  const f = fixture();
  const started = deferred<CommandResult>();
  f.run.mockImplementation(async command => {
    f.calls.push(command);
    return command.type === 'cancelJob' ? {kind: 'cancelled'} : started.promise;
  });
  const result = f.retry();
  await vi.waitFor(() => expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]));
  f.close();
  started.resolve({kind: 'started', jobId: newJobId});
  expect(await result).toEqual({kind: 'ignored'});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand, {type: 'cancelJob', jobId: newJobId}]);
});

it.each<CommandResult>([
  {kind: 'refused', code: 'not_ready', message: '暂时无法开始'},
  {kind: 'outcomeUnknown', message: '注册结果不明，请检查 Bot 列表'},
])('surfaces a refused or unknown start result without silently retrying: $kind', async startResult => {
  const f = fixture();
  f.run.mockImplementation(async command => { f.calls.push(command); return command.type === 'cancelJob' ? {kind: 'cancelled'} : startResult; });
  expect(await f.retry()).toEqual({kind: 'blocked', message: 'message' in startResult ? startResult.message : ''});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]);
});

const uncertainStarts: Array<{label: string; result: CommandResult | Error}> = [
  {label: 'outcomeUnknown', result: {kind: 'outcomeUnknown', message: '开始注册的结果不明'}},
  {label: 'ipc-failed', result: {kind: 'refused', code: 'ipc-failed', message: '开始注册的回复丢失'}},
  {label: 'thrown start error', result: new Error('开始注册时连接中断')},
];
it.each(uncertainStarts.flatMap(value => [false, true].map(publishNewJob => ({...value, publishNewJob}))))(
  'does not start a duplicate after $label, whether the new job is visible yet ($publishNewJob)', async ({result: uncertain, publishNewJob}) => {
  const f = fixture();
  const activeNewJob: Job = {...qr(Date.now() + 60_000), id: newJobId};
  const latest = snapshot(publishNewJob ? [cancelled, activeNewJob] : [cancelled]);
  f.run.mockImplementation(async command => {
    f.calls.push(command);
    if (command.type === 'cancelJob') return {kind: 'cancelled'};
    f.publish(latest);
    f.read.mockResolvedValue(latest);
    if (uncertain instanceof Error) throw uncertain;
    return uncertain;
  });
  expect(await f.retry()).toMatchObject({kind: 'blocked'});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('上次重新注册')});
  expect(f.run.mock.calls.filter(([command]) => command.type === 'registerAgent')).toHaveLength(1);
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]);
});

it.each<Job>([qr(Date.now() + 60_000), activating, {...failed, phase: 'running'}, {...failed, phase: 'unresolved'}])(
  'blocks a foreign active registration in phase $phase without cancelling it or starting another', async job => {
  const foreign = {...job, id: newJobId};
  const f = fixture({after: snapshot([cancelled, foreign])});
  expect(await f.retry()).toMatchObject({kind: 'blocked', message: expect.stringContaining('其他注册正在进行')});
  expect(f.calls).toEqual([cancelCommand, 'snapshot']);
});

// devices-ui-2 4.9: registration is the only job left; the Provider tasks this also checked are gone.
it('does not confuse a terminal registration with an active registration', async () => {
  const f = fixture({after: snapshot([cancelled, {...failed, id: newJobId}])});
  expect(await f.retry()).toEqual({kind: 'ready', modal: {...f.modal, jobId: newJobId}});
  expect(f.calls).toEqual([cancelCommand, 'snapshot', startCommand]);
});
