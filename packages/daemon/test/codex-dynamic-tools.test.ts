import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSessionParams } from '../src/agent/codex-appserver/backend';
import { offeredTool, startDynamicTools, vonvonNamespace } from '../src/agent/codex-appserver/dynamic-tools';
import { CodexRequestScope, dynamicToolCall } from '../src/agent/codex-appserver/server-requests';
import { FEISHU_API, FEISHU_DOC_EDIT, feishuDocToolNames, feishuToolNames } from '../src/agent/entry/feishu-tools';
import { scheduleToolNames } from '../src/agent/entry/schedule-tools';
import type { AgentEntry, AgentThread } from '../src/agent/types';
import { closeCodexToolFixtures, codexToolsFixture, OWNER, person, profile } from './helpers/codex-tools-fixture';

// 定时任务 T3b: the schedule tools reach Codex as app-server dynamicTools on thread/start and come back as item/tool/call.
vi.mock('../src/agent/codex-appserver/windows-sandbox', async original => ({ ...await original<object>(),
  cachedWindowsSandbox: () => ({ status: 'ready', implementation: 'mxc' }), windowsShellPath: () => undefined }));
afterEach(closeCodexToolFixtures);
afterEach(() => { vi.restoreAllMocks(); });

describe('dynamicTools on thread/start', () => {
  it('starts a schedule session with the vonvon_bot namespace of T3\'s seven tools', async () => {
    const f = codexToolsFixture();
    await f.open();
    const [tools] = f.starts().map(start => start.dynamicTools as { name: string; tools: Record<string, unknown>[] }[]);
    expect(tools).toEqual([{ type: 'namespace', name: 'vonvon_bot', description: expect.any(String), tools: expect.any(Array) }]);
    expect(tools![0]!.tools.map(tool => tool.name)).toEqual([...scheduleToolNames]);
    for (const tool of tools![0]!.tools) expect(tool).toMatchObject({ type: 'function', description: expect.any(String), inputSchema: { type: 'object' } });
  });
  it('adds the Feishu read tools by the profile, in the same namespace', () => {
    const names = (tools: { schedule: boolean; feishu?: boolean }) => vonvonNamespace(tools).tools.map(tool => tool.name);
    expect(names({ schedule: true })).toEqual([...scheduleToolNames]);
    expect(names({ schedule: false, feishu: true })).toEqual([...feishuToolNames]);
    expect(names({ schedule: true, feishu: true })).toEqual([...scheduleToolNames, ...feishuToolNames]);
    for (const tool of vonvonNamespace({ schedule: false, feishu: true }).tools) expect(tool).toMatchObject({ type: 'function', description: expect.any(String), inputSchema: { type: 'object' } });
    const entry = {} as AgentEntry, feishuOnly = { ...profile(false), tools: { schedule: false, feishu: true } };
    expect(startDynamicTools({ entry, profile: feishuOnly }).dynamicTools?.[0]?.tools.map(tool => tool.name)).toEqual([...feishuToolNames]);
  });
  it('adds the edit tool by the profile, and keeps a comment\'s session to the document column', () => {
    const names = (tools: Parameters<typeof vonvonNamespace>[0]) => vonvonNamespace(tools).tools.map(tool => tool.name);
    expect(names({ schedule: false, feishu: true, feishuEdit: true })).toEqual([...feishuToolNames, FEISHU_DOC_EDIT]);
    expect(names({ schedule: false, feishu: true, documentsOnly: true })).toEqual([...feishuDocToolNames]);
    expect(names({ schedule: false, feishu: true, feishuEdit: true, documentsOnly: true })).toEqual([...feishuDocToolNames, FEISHU_DOC_EDIT]);
  });
  it('adds feishu_api only by the profile, a private chat\'s', () => {
    const names = (tools: Parameters<typeof vonvonNamespace>[0]) => vonvonNamespace(tools).tools.map(tool => tool.name);
    expect(names({ schedule: true, feishu: true, feishuEdit: true })).not.toContain(FEISHU_API);
    expect(names({ schedule: false, feishu: true, documentsOnly: true })).not.toContain(FEISHU_API);
    expect(names({ schedule: true, feishu: true, feishuEdit: true, feishuApi: true })).toContain(FEISHU_API);
  });
  it('offers feedback preparation before setup, then answers through only the current SDK turn', async () => {
    let enabled = false;
    const details = {checks: '已复现', sourceEvidence: '0.10.1 packages/ui/src/app.ts:21 路由匹配', openQuestions: '待复测',
      useCase: '每次手工查找', acceptanceCriteria: '可直接打开'};
    const detailProperties = Object.fromEntries(Object.keys(details).map(name => [name, expect.objectContaining({type: 'string'})]));
    const f = codexToolsFixture(() => enabled);
    const session = await f.open();
    expect(f.starts()[0]?.dynamicTools).toEqual([expect.objectContaining({name: 'vonvon_bot', tools: expect.arrayContaining([
      expect.objectContaining({type: 'function', name: 'feedback_prepare', inputSchema: expect.objectContaining({type: 'object',
        properties: expect.objectContaining({summary: expect.objectContaining({properties: expect.objectContaining(detailProperties)})})})}),
    ])})]);
    expect(session.thread.startedWithFeedbackTool).toBe(true);
    const calls = [{tool: 'feedback_prepare', args: {summary: {kind: 'bug', title: '标题', description: '说明', ...details}}}];
    const user = 'ou_member';
    await session.turn(person(user), calls);
    expect(f.answers().at(-1)).toEqual({success: false, text: expect.stringContaining('/feedback setup')});
    enabled = true;
    const prepare = vi.fn(async () => ({operationId: 'operation', trackingCode: 'fixture'}));
    const feedback = {chatId: 'oc_group', openId: user, messageId: 'om_' + user, attachments: [], prepare};
    await session.turn(person(user, {feedback}), calls);
    expect(f.answers().at(-1)).toEqual({success: true, text: expect.stringContaining('fixture')});
    await session.turn(person(user, {feedback, triggerMessageId: 'old-message'}), calls);
    expect(f.answers().at(-1)?.success).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({summary: expect.objectContaining(details)}), expect.any(AbortSignal), expect.any(Function));
  });
  it.each([{kind: 'p2p', chatId: 'oc_private'}, {kind: 'doc', docId: 'doc'}] as const)('keeps preparation out of a $kind Codex session', async place => {
    const f = codexToolsFixture(() => true);
    const session = await f.open('start', true, place);
    expect(f.starts()[0]?.dynamicTools).not.toEqual([expect.objectContaining({tools: expect.arrayContaining([expect.objectContaining({name: 'feedback_prepare'})])})]);
    await session.turn(person(OWNER), [{tool: 'feedback_prepare', args: {summary: {kind: 'bug', title: '标题', description: '说明'}}}]);
    expect(f.answers().at(-1)?.success).toBe(false);
  });
  it('answers calls to the tools it offers, and no others', () => {
    for (const tool of [...scheduleToolNames, ...feishuToolNames, FEISHU_DOC_EDIT, FEISHU_API]) expect(offeredTool('vonvon_bot', tool)).toBe(true);
    expect(offeredTool('vonvon_bot', 'memory_add')).toBe(false);
    expect(offeredTool('other', 'feishu_doc')).toBe(false);
  });
  it('leaves the field out without an entry to answer the calls', () => {
    expect(startDynamicTools({ entry: {} as AgentEntry, profile: profile(true) })).toHaveProperty('dynamicTools');
    expect(startDynamicTools({ profile: profile(true) })).toEqual({});
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

describe('connector tools that schedule on ChatGPT\'s side', () => {
  const off = (...names: string[]) => ({ tools: Object.fromEntries(names.map(name => [name, { enabled: false }])) });
  const apps = {
    connector_openai_pages: off('list_page_automations', 'create_controller_automation', 'attach_automation_to_page',
      'get_page_auto_update', 'set_page_auto_update', 'run_page_auto_update'),
    connector_20205bf7d4e99a89d7154bb849718324: off('create_schedule', 'validate_suggested_schedule'),
  };
  it('closes exactly these tools on every tier, and no app wholesale', () => {
    for (const mode of ['qa', 'write', 'full'] as const) {
      const config = codexSessionParams({ cwd: '/work', mode, profile: profile(true) }, 'codex-cli 0.163.0', null).config as { apps: unknown; features: object };
      expect(config.apps).toEqual(apps);
      expect(config.features).not.toHaveProperty('apps');
    }
  });
  it('sends them on thread/start and thread/resume alike', async () => {
    const f = codexToolsFixture();
    await f.open('start');
    await f.open('resume');
    expect([...f.starts(), ...f.resumes()].map(params => (params.config as { apps?: unknown }).apps)).toEqual([apps, apps]);
  });
});

describe('item/tool/call', () => {
  it('offers feedback review and rejects removed source tools even from an old Codex rollout', async () => {
    const f = codexToolsFixture(() => true);
    const session = await f.open();
    expect(f.starts()[0]?.dynamicTools).toEqual([expect.objectContaining({name:'vonvon_bot',tools:expect.arrayContaining([expect.objectContaining({name:'feedback_prepare'})])})]);
    await session.turn(person('ou_member'), [{namespace:'vonvon-release-code',tool:'rg',args:{argv:['--files']}},{namespace:'vonvon-release-code',tool:'read',args:{path:'README.md'}}]);
    expect(f.answers()).toEqual([{success:false,text:'没有这个工具。'},{success:false,text:'没有这个工具。'}]);
  });
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
  // The answer is not delivered, the peer is gone; what matters is that nothing stays held.
  it.each([
    ['the thread closes', (thread: AgentThread) => thread.close()],
    ['the app-server process dies (SIGKILL, so EOF)', (_thread: AgentThread, pid: number) => { process.kill(pid, 'SIGKILL'); }],
  ])('releases a held call when %s, and the run settles', async (_when, end) => {
    const held = holds();
    const f = codexToolsFixture();
    f.execute.mockImplementation(() => new Promise(() => {}));
    const session = await f.open();
    const call = vi.spyOn(session.entry, 'call');
    const turn = session.turn(person(OWNER), [{ tool: 'schedule_list' }]);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    await end(session.thread, f.pid()!);
    await expect(turn).resolves.toBeUndefined();
    expect(held).toEqual([{ released: true }]);
    await expect(call.mock.results[0]!.value).resolves.toMatchObject({ ok: false, code: 'revoked' });
  });
});

/** Every call a run's scope holds, and whether the scope's close answered it. */
function holds(): { released: boolean }[] {
  const held: { released: boolean }[] = [];
  const hold = CodexRequestScope.prototype.hold;
  vi.spyOn(CodexRequestScope.prototype, 'hold').mockImplementation(function (this: CodexRequestScope, answer: () => void) {
    const call = { released: false };
    held.push(call);
    return hold.call(this, () => { call.released = true; answer(); });
  });
  return held;
}
