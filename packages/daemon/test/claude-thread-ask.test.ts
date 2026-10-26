import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claudeAccess, permissionOptions, type ClaudeAccess, type PathFs } from '../src/agent/claude-agent/permission';
import { AUTO_COMPACT_SETTINGS, ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import type { AskResolution } from '../src/agent/types';
import { log } from '../src/core/logger';

const threads: ClaudeAgentThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const question = { questions: [{ question: '选哪个？', header: '选择', multiSelect: false,
  options: [{ label: 'A', description: '甲' }, { label: 'B', description: '乙' }] }] };
function makeThread(permissionFs?: PathFs, native?: Readonly<Record<string, unknown>>, accessOverrides: Partial<ClaudeAccess> = {}) {
  let options: Options | undefined;
  let end: (() => void) | undefined;
  const access = Object.assign(claudeAccess('write', false, '/workspace', '/workspace', undefined, native), accessOverrides);
  const setPermissionMode = vi.fn(async (_mode: string) => {});
  const submitted: SDKUserMessage[] = [];
  const close = vi.fn(() => end?.());
  const thread = new ClaudeAgentThread({
    sessionId: 'test', resume: false, cwd: access.cwd, access,
    permission: permissionOptions(access), permissionFs,
    query: (params) => {
      options = params.options;
      void (async () => { for await (const message of params.prompt) submitted.push(message); })();
      return Object.assign((async function* (): AsyncGenerator<SDKMessage> {
        await new Promise<void>((resolve) => { end = resolve; });
      })(), { interrupt: async () => {}, close, getContextUsage: async () => null, setPermissionMode }) as unknown as Query;
    },
  });
  threads.push(thread);
  const canUseTool = options?.canUseTool;
  if (!canUseTool) throw new Error('missing canUseTool');
  return { thread, options, canUseTool, setPermissionMode, submitted, access, close, end: () => end?.() };
}
function callbackArgs(signal = new AbortController().signal) { return { signal, requestId: 'request', toolUseID: 'tool' }; }
function distinctPathFs(): PathFs {
  const inodes = new Map<string, number>();
  return { realpath: async p => p, lstat: async () => ({}), stat: async p => {
    // Unrelated paths must not look like hard links to guarded configuration files.
    if (!inodes.has(p)) inodes.set(p, inodes.size + 1);
    return { dev: 1, ino: inodes.get(p)! };
  } };
}

it('installs the write tier, file hook and callback', () => {
  const { options, setPermissionMode } = makeThread();
  expect(options?.permissionMode).toBe('acceptEdits');
  expect(options?.hooks?.PreToolUse?.[0]?.matcher).toContain('Write');
  expect(setPermissionMode).not.toHaveBeenCalled();
});

it.each([undefined, 'default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const)('keeps plan files inside cwd only for native %s', permissionMode => {
  const { options } = makeThread(undefined, permissionMode ? { permissionMode } : undefined);
  expect(options?.settings).toEqual(permissionMode === 'plan'
    ? { ...AUTO_COMPACT_SETTINGS, plansDirectory: '/workspace/.claude/plans' } : AUTO_COMPACT_SETTINGS);
  if (permissionMode === 'plan') expect(resolve(options?.cwd ?? '', '.claude/plans')).toBe('/workspace/.claude/plans');
});

it('uses canonical cwd for the plan directory fallback across filesystem aliases', () => {
  const { options } = makeThread(undefined, { permissionMode: 'plan' }, {
    cwd: '/var/task/work', realCwd: '/private/var/task/work', planState: undefined,
  });
  expect(options?.settings).toEqual({ ...AUTO_COMPACT_SETTINGS, plansDirectory: '/private/var/task/work/.claude/plans' });
});

it('resets plan before submitting every turn and confirms into session-only acceptEdits', async () => {
  const fsx = distinctPathFs();
  const { thread, canUseTool, setPermissionMode, submitted, access } = makeThread(fsx, { permissionMode: 'plan' });
  let release!: () => void;
  setPermissionMode.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const run = thread.runStreamed({ text: 'first' }), iterator = run.events[Symbol.asyncIterator]();
  await iterator.next();
  expect(submitted).toHaveLength(0);
  release();
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  await expect(canUseTool('Write', { file_path: '/workspace/a.txt' }, callbackArgs())).resolves.toMatchObject({ behavior: 'deny' });
  const result = canUseTool('ExitPlanMode', { plan: 'create a.txt' }, callbackArgs());
  const event = (await iterator.next()).value;
  if (event?.type !== 'ask') throw new Error('missing confirmation');
  let confirm!: () => void;
  setPermissionMode.mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  const accepted = run.respondToAsk?.(event.request.id, { kind: 'answered', answer: { kind: 'confirmation', decision: 'proceed' } });
  expect(access.planState?.pending).toBe(true);
  await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
  confirm();
  await accepted;
  expect(await result).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  expect(access.planState?.pending).toBe(false);
  await expect(canUseTool('Write', { file_path: '/workspace/a.txt' }, callbackArgs())).resolves.toMatchObject({ behavior: 'allow' });
  await iterator.return?.();
  const next = thread.runStreamed({ text: 'second' }).events[Symbol.asyncIterator]();
  await next.next();
  expect(access.planState?.pending).toBe(true);
  await expect(canUseTool('Write', { file_path: '/workspace/a.txt' }, callbackArgs())).resolves.toMatchObject({ behavior: 'deny' });
  await vi.waitFor(() => expect(submitted).toHaveLength(2));
  expect(setPermissionMode.mock.calls).toEqual([['plan'], ['acceptEdits'], ['plan']]);
  await next.return?.();
});

it('does not reset auto', async () => {
  const auto = makeThread(undefined, { permissionMode: 'auto' });
  auto.thread.runStreamed({ text: 'auto' });
  await vi.waitFor(() => expect(auto.submitted).toHaveLength(1));
  expect(auto.setPermissionMode).not.toHaveBeenCalled();
});

it.each(['stream', 'goal'].flatMap(kind => ['failure', 'timeout'].map(reason => ({ kind, reason }))))('closes $kind without submitting on plan reset $reason', async ({ kind, reason }) => {
  vi.useFakeTimers();
  const logged = vi.spyOn(log, 'fail').mockImplementation(() => undefined);
  const { thread, setPermissionMode, submitted, close } = makeThread(undefined, { permissionMode: 'plan' });
  let rejectLate: ((reason: Error) => void) | undefined;
  if (reason === 'failure') setPermissionMode.mockRejectedValueOnce(new Error('synthetic reset failure'));
  else setPermissionMode.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectLate = reject; }));
  const run = kind === 'goal' ? thread.runGoal('do this') : thread.runStreamed({ text: 'do this' });
  const collected = (async () => { const events = []; for await (const event of run.events) events.push(event); return events; })();
  await vi.advanceTimersByTimeAsync(reason === 'timeout' ? 9_999 : 0);
  if (reason === 'timeout') { expect(thread.isAlive()).toBe(true); expect(submitted).toHaveLength(0); await vi.advanceTimersByTimeAsync(1); }
  expect(submitted).toHaveLength(0);
  expect(thread.isAlive()).toBe(false);
  expect(close).toHaveBeenCalledOnce();
  const events = await collected;
  expect(events).toContainEqual({ type: 'error', message: '这一轮没能回到先出方案的状态，先停下，请再发一次', willRetry: false });
  expect(events.some(event => event.type === 'done')).toBe(false);
  if (kind === 'goal') expect(events).toContainEqual(expect.objectContaining({ type: 'goal_update', status: 'blocked' }));
  expect(logged).toHaveBeenCalledWith('agent', expect.any(Error), { phase: 'setPermissionMode' });
  rejectLate?.(new Error('late reset rejection'));
  await vi.advanceTimersByTimeAsync(0);
});

it.each(['failure', 'timeout', 'close'] as const)('keeps plan pending on acceptEdits %s', async reason => {
  vi.useFakeTimers();
  vi.spyOn(log, 'fail').mockImplementation(() => undefined);
  const { thread, canUseTool, setPermissionMode, submitted, access } = makeThread(undefined, { permissionMode: 'plan' });
  const run = thread.runStreamed({ text: 'plan' }), iterator = run.events[Symbol.asyncIterator]();
  await iterator.next();
  await vi.advanceTimersByTimeAsync(0);
  expect(submitted).toHaveLength(1);
  const result = canUseTool('ExitPlanMode', { plan: 'do it' }, callbackArgs());
  const event = (await iterator.next()).value;
  if (event?.type !== 'ask') throw new Error('missing confirmation');
  if (reason === 'failure') setPermissionMode.mockRejectedValueOnce(new Error('synthetic mode rejection'));
  else setPermissionMode.mockImplementationOnce(() => new Promise<void>(() => {}));
  const accepted = run.respondToAsk?.(event.request.id, { kind: 'answered', answer: { kind: 'confirmation', decision: 'proceed' } });
  await vi.advanceTimersByTimeAsync(0);
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
  if (reason === 'close') await thread.close();
  await accepted;
  expect(await result).toMatchObject({ behavior: 'deny' });
  expect(access.planState?.pending).toBe(true);
  await iterator.return?.();
});

it('answers a question and synchronously claims it before a duplicate response', async () => {
  const { thread, canUseTool } = makeThread();
  const run = thread.runStreamed({ text: 'test' });
  const iterator = run.events[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.type).toBe('turn_started');
  const result = canUseTool('AskUserQuestion', question, callbackArgs());
  const event = (await iterator.next()).value;
  if (event?.type !== 'ask') throw new Error('missing ask');
  expect(event.request.kind).toBe('choices');
  expect(run.askPending?.(event.request.id)).toBe(true);
  const resolution: AskResolution = { kind: 'answered', answer: { kind: 'choices', answers: [{ questionId: 'q0', selected: ['o0'] }] } };
  const accepted = run.respondToAsk?.(event.request.id, resolution);
  expect(run.askPending?.(event.request.id)).toBe(false);
  const duplicate = run.respondToAsk?.(event.request.id, { kind: 'unanswered', reason: 'stopped' });
  await expect(accepted).resolves.toBeUndefined();
  await expect(duplicate).resolves.toBeUndefined();
  await expect(result).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { '选哪个？': 'A' } } });
  await iterator.return?.();
});

it('denies asks outside turns and during compact', async () => {
  const { thread, canUseTool, end } = makeThread();
  await expect(canUseTool('AskUserQuestion', question, callbackArgs())).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('没有在进行') });
  const compact = thread.compact();
  const outcome = expect(compact).rejects.toThrow('进程已退出');
  await expect(canUseTool('AskUserQuestion', question, callbackArgs())).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('没有在进行') });
  end();
  await outcome;
});

it('cancels an aborted callback and ignores a late answer', async () => {
  const { thread, canUseTool } = makeThread();
  const run = thread.runStreamed({ text: 'test' });
  const iterator = run.events[Symbol.asyncIterator]();
  await iterator.next();
  const controller = new AbortController();
  const result = canUseTool('AskUserQuestion', question, callbackArgs(controller.signal));
  const event = (await iterator.next()).value;
  if (event?.type !== 'ask') throw new Error('missing ask');
  controller.abort();
  await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  expect((await iterator.next()).value).toEqual({ type: 'ask_cancelled', requestId: event.request.id });
  await expect(run.respondToAsk?.(event.request.id, { kind: 'unanswered', reason: 'timeout' })).resolves.toBeUndefined();
  await iterator.return?.();
});

it('denies an out-of-workspace write while an independent question stays pending', async () => {
  const fsx = distinctPathFs();
  const { thread, canUseTool } = makeThread(fsx);
  const run = thread.runStreamed({ text: 'test' });
  const iterator = run.events[Symbol.asyncIterator]();
  await iterator.next();
  let settled = false;
  const result = canUseTool('AskUserQuestion', question, callbackArgs()).then((value) => { settled = true; return value; });
  const event = (await iterator.next()).value;
  if (event?.type !== 'ask') throw new Error('missing ask');
  await expect(canUseTool('Write', { file_path: '/elsewhere/x' }, callbackArgs())).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('工作区以外') });
  expect(settled).toBe(false);
  await run.respondToAsk?.(event.request.id, { kind: 'unanswered', reason: 'timeout' });
  await expect(result).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('15 分钟') });
  await iterator.return?.();
});

it.each(['exit', 'close', 'goal-clear', 'turn-end'] as const)('settles pending asks on %s', async (action) => {
  const { thread, canUseTool, end } = makeThread();
  const run = action === 'goal-clear' ? thread.runGoal('test') : thread.runStreamed({ text: 'test' });
  const iterator = run.events[Symbol.asyncIterator]();
  await iterator.next();
  if (action === 'goal-clear') await iterator.next();
  const result = canUseTool('AskUserQuestion', question, callbackArgs());
  const event = (await iterator.next()).value;
  if (event?.type !== 'ask') throw new Error('missing ask');
  expect(run.respondToAsk).toBeTypeOf('function');
  if (action === 'exit') end();
  if (action === 'close') await thread.close();
  if (action === 'goal-clear') await thread.clearGoal();
  if (action === 'turn-end') await iterator.return?.();
  await expect(result).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining(action === 'close' || action === 'goal-clear' ? '用户停止' : '没法交给用户') });
  if (action === 'exit') expect(thread.isAlive()).toBe(false);
  await iterator.return?.();
});

it('denies a stalled filesystem check after five seconds', async () => {
  vi.useFakeTimers();
  const fsx: PathFs = { realpath: () => new Promise(() => {}), stat: async () => ({ dev: 1, ino: 1 }), lstat: async () => ({}) };
  const { canUseTool } = makeThread(fsx);
  const result = canUseTool('Write', { file_path: '/elsewhere/x' }, callbackArgs());
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(result).resolves.toEqual({ behavior: 'deny', message: '权限检查超时，这一步先不做。' });
});

it('does not create a pending ask if close wins the async permission check', async () => {
  const { thread, canUseTool } = makeThread();
  thread.runStreamed({ text: 'test' });
  const result = canUseTool('AskUserQuestion', question, callbackArgs());
  await thread.close();
  await expect(result).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('没有在进行') });
});


it.each([undefined, 'child-id'])('passes SDK agentID through ordinary and goal asks: %s', async agentID => {
  for (const goal of [false, true]) {
    const { thread, canUseTool } = makeThread();
    const run = goal ? thread.runGoal('test') : thread.runStreamed({ text: 'test' });
    const iterator = run.events[Symbol.asyncIterator](); await iterator.next();
    if (goal) await iterator.next();
    const permission = canUseTool('AskUserQuestion', question, { ...callbackArgs(), agentID });
    const event = (await iterator.next()).value;
    if (event?.type !== 'ask') throw new Error('missing ask');
    expect(event.subagentId).toBe(agentID);
    await run.respondToAsk?.(event.request.id, { kind: 'unanswered', reason: 'stopped' });
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
    await iterator.return?.();
  }
});
