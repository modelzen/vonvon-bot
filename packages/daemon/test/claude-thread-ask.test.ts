import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { claudeAccess, permissionOptions, type PathFs } from '../src/agent/claude-agent/permission';
import { ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import type { AskResolution } from '../src/agent/types';

const threads: ClaudeAgentThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
  vi.useRealTimers();
});
const question = { questions: [{ question: '选哪个？', header: '选择', multiSelect: false,
  options: [{ label: 'A', description: '甲' }, { label: 'B', description: '乙' }] }] };
function makeThread(permissionFs?: PathFs) {
  let options: Options | undefined;
  let end: (() => void) | undefined;
  const access = claudeAccess('write', false, '/workspace', '/workspace');
  const thread = new ClaudeAgentThread({
    sessionId: 'test', resume: false, cwd: '/workspace', access,
    permission: permissionOptions(access), permissionFs,
    query: (params) => {
      options = params.options;
      return Object.assign((async function* (): AsyncGenerator<SDKMessage> {
        await new Promise<void>((resolve) => { end = resolve; });
      })(), { interrupt: async () => {}, close: () => end?.(), getContextUsage: async () => null }) as unknown as Query;
    },
  });
  threads.push(thread);
  const canUseTool = options?.canUseTool;
  if (!canUseTool) throw new Error('missing canUseTool');
  return { thread, options, canUseTool, end: () => end?.() };
}
function callbackArgs(signal = new AbortController().signal) { return { signal, requestId: 'request', toolUseID: 'tool' }; }

it('installs the write tier, file hook and callback', () => {
  const { options } = makeThread();
  expect(options?.permissionMode).toBe('acceptEdits');
  expect(options?.hooks?.PreToolUse?.[0]?.matcher).toContain('Write');
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
  const fsx: PathFs = { realpath: async (p) => p, stat: async (p) => ({ dev: 1, ino: p === '/workspace' ? 1 : 2 }), lstat: async () => ({}) };
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
