import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSessionParams } from '../src/agent/codex-appserver/backend';
import { CodexRequestScope, dynamicToolCall } from '../src/agent/codex-appserver/server-requests';
import { scheduleToolNames } from '../src/agent/entry/schedule-tools';
import type { AgentEntry } from '../src/agent/types';
import { closeCodexToolFixtures, codexToolsFixture, OWNER, person, profile } from './helpers/codex-tools-fixture';

// 定时任务 T3b: the schedule tools reach Codex as app-server dynamicTools on thread/start and come back as item/tool/call.
vi.mock('../src/agent/codex-appserver/windows-sandbox', async original => ({ ...await original<object>(),
  cachedWindowsSandbox: () => ({ status: 'ready', implementation: 'mxc' }), windowsShellPath: () => undefined }));
afterEach(closeCodexToolFixtures);

describe('dynamicTools on thread/start', () => {
  it('starts a schedule session with the vonvon_bot namespace of T3\'s seven tools', async () => {
    const f = codexToolsFixture();
    await f.open();
    const [tools] = f.starts().map(start => start.dynamicTools as { name: string; tools: Record<string, unknown>[] }[]);
    expect(tools).toEqual([{ type: 'namespace', name: 'vonvon_bot', description: expect.any(String), tools: expect.any(Array) }]);
    expect(tools![0]!.tools.map(tool => tool.name)).toEqual([...scheduleToolNames]);
    for (const tool of tools![0]!.tools) expect(tool).toMatchObject({ type: 'function', description: expect.any(String), inputSchema: { type: 'object' } });
  });
  it('leaves the field out without tools.schedule, and on resume (Codex restores them from the rollout)', async () => {
    const f = codexToolsFixture();
    await f.open('start', false);
    await f.open('resume', true);
    expect(f.starts()).toHaveLength(1);
    expect(f.starts()[0]).not.toHaveProperty('dynamicTools');
    expect(f.resumes()).toHaveLength(1);
    expect(f.resumes()[0]).not.toHaveProperty('dynamicTools');
  });
  it('keeps memory, scheduling and Windows\' MXC switches in one features block', () => {
    const features = (opts: Parameters<typeof codexSessionParams>[0], bin: string | null = null) =>
      (codexSessionParams(opts, 'codex-cli 0.163.0', bin).config as { features: unknown }).features;
    expect(features({ cwd: '/work', mode: 'full', profile: profile(true) })).toEqual({ memories: false, in_app_local_automation: false });
    expect(features({ cwd: '/work', mode: 'qa' })).toEqual({ memories: false, in_app_local_automation: false });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(features({ cwd: '/work', mode: 'qa' }, process.execPath)).toEqual({ prefer_mxc: false, memories: false, in_app_local_automation: false });
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});

describe('item/tool/call', () => {
  it('answers through the entry as a tool result: a call, a tool it was not offered, bad arguments and another thread', async () => {
    const f = codexToolsFixture();
    const session = await f.open();
    await session.turn(person(OWNER), [{ tool: 'schedule_list' }, { tool: 'session_info' },
      { tool: 'schedule_create', args: {} }, { tool: 'schedule_list', threadId: 'someone-else' }]);
    const [list, unknown, bad, foreign] = f.answers();
    expect(list).toEqual({ success: true, text: expect.stringMatching(/^现在 .+（Asia\/Shanghai）· 本群 0 个任务\n\{/) });
    expect(unknown).toEqual({ success: false, text: '没有这个工具。' });
    expect(bad).toEqual({ success: false, text: expect.stringMatching(/^参数不对/) });
    expect(foreign).toEqual({ success: false, text: expect.stringContaining('不是本 bot 的线程') });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('answers a call still running when its run\'s scope closes, and a call with no run at once', async () => {
    const scope = new CodexRequestScope('th');
    const call = vi.fn(() => new Promise<never>(() => {}));
    const host = { entry: { call } as unknown as AgentEntry, turnAcked: async () => true };
    const params = { threadId: 'th', turnId: 'turn-1', callId: 'c1', namespace: 'vonvon_bot', tool: 'schedule_list', arguments: {} };
    const pending = dynamicToolCall(params, scope, id => id === 'th' ? host : undefined);
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('schedule_list', {}, { toolUseId: 'turn-1' }));
    scope.close();
    const over = { result: { contentItems: [{ type: 'inputText', text: '这一轮已经结束了。' }], success: false } };
    expect(await pending).toEqual(over);
    expect(await dynamicToolCall(params, scope, () => host)).toEqual(over);
    expect(await dynamicToolCall(params, undefined, () => host)).toEqual(over);
    expect(call).toHaveBeenCalledOnce();
  });
});
