import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentSchema, desktopSnapshotSchema, type ToolState, type DirectoryReply} from '@vonvon/protocol';
import {JoinGroupDialog} from '../src/JoinGroupDialog';
import {DirectorySearchStep} from '../src/DirectorySearchStep';

const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Array<{deps?: unknown[]; cleanup?: () => void}>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  deferEffects: false, pendingEffects: [] as Array<() => void>,
  draft: undefined as undefined | {save?: () => Promise<boolean>; discard: () => void},
  selection: {kind: 'default'} as {kind: string; backend?: string; model?: string; provider?: string},
  keySet: true, keyUnreadable: false,
  defaultProvider: 'codex-appserver' as string | undefined,
  hostError: '', agentError: '', hostPending: undefined as Promise<unknown> | undefined, agentPending: undefined as Promise<unknown> | undefined,
  catalogState: 'ready' as 'ready' | 'unavailable',
  catalogModels: [{id: 'gpt-6-luna', hidden: false, isDefault: true, supportedEfforts: ['low']}] as Array<{id: string; hidden: boolean; isDefault: boolean; supportedEfforts: string[]}>,
  client: {
    collaboration: vi.fn(async (request: {action: string}) => request.action === 'providerModels' ? {kind: 'providerModels', state: harness.catalogState, models: harness.catalogModels} : {kind: 'applied', project: {chatId: 'oc_created'}}),
    run: vi.fn(async () => ({kind: 'applied'})),
    directory: vi.fn(),
    settings: vi.fn(async (request: {scope: {kind: string}}): Promise<any> => {
      if (request.scope.kind === 'host') {
        if (harness.hostError) throw new Error(harness.hostError);
        if (harness.hostPending) return harness.hostPending;
        return {kind: 'view', view: {scope: {kind: 'host'}, runtime: {}, sections: {judge: {effective: {
          ...(harness.defaultProvider ? {defaultProvider: harness.defaultProvider} : {}),
          byProvider: {'codex-appserver': {model: 'gpt-6-luna', effort: 'low'}, 'claude-agent': {model: 'haiku'}, typesafe: {model: 'jev-latest'}},
        }}}}};
      }
      if (harness.agentError) throw new Error(harness.agentError);
      if (harness.agentPending) return harness.agentPending;
      return {kind: 'view', view: {scope: {kind: 'agent'}, administrators: {}, sections: {judge: {stored: {selection: harness.selection}, effective: {selection: harness.selection}}},
        judgeByBackend: {'codex-appserver': {model: 'gpt-6-luna', effort: 'low', source: 'default'}, 'claude-agent': {model: 'haiku', source: 'default'}},
        decisionModels: [{provider: 'typesafe', displayName: 'TypeSafe', models: [{id: 'jev-latest', displayName: 'Jev'}], keySet: harness.keySet, keyUnreadable: harness.keyUnreadable}]}};
    }),
  },
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useId: () => 'join-directory-results',
  useState: (initial: unknown) => {const index = harness.stateIndex++; if (!(index in harness.state)) harness.state[index] = initial; return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;}];},
  useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= {current: initial},
  useEffect: (callback: () => void | (() => void), deps?: unknown[]) => {const index = harness.effectIndex++; const old = harness.effects[index]; if (old?.deps && deps && deps.every((item, at) => Object.is(item, old.deps![at]))) return; const run = () => {old?.cleanup?.(); const cleanup = callback(); harness.effects[index] = {deps, ...(typeof cleanup === 'function' ? {cleanup} : {})};}; if (harness.deferEffects) harness.pendingEffects.push(run); else run();},
  useMemo: (factory: () => unknown, deps?: unknown[]) => {const index = harness.memoIndex++; const old = harness.memos[index]; if (old?.deps && deps && deps.every((item, at) => Object.is(item, old.deps![at]))) return old.value; const value = factory(); harness.memos[index] = {value, deps}; return value;},
}));
vi.mock('../src/client-context', () => ({useClient: () => harness.client}));
vi.mock('../src/directory-picker', () => ({useDirectoryPicker: () => async () => null}));
vi.mock('../src/settings/GroupDesignSettings', () => ({useProviders: (tools: ToolState[]) => tools?.filter(item => item.installation === 'installed' && item.authentication === 'signedIn').map(item => ({id: item.tool === 'codex' ? 'codex-appserver' : 'claude-agent', displayName: item.tool})), DecisionFields: () => null}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()}), useDraft: (_dirty: boolean, draft: typeof harness.draft) => {harness.draft = draft;}}));

const agent = agentSchema.parse({id: 'cli_join', name: 'Bot', enabled: true, running: true, connection: 'connected', activation: 'active'});
const onClose = vi.fn();
const onChanged = vi.fn(async () => {});
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.trailing), ...nodes(node.props.footer), ...nodes(node.props.actions), ...nodes(node.props.title)];
}
const readyCodex: ToolState[] = [{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'}];
function render(bind = true, tools: ToolState[] = readyCodex, initialProvider?: 'codex' | 'claude', onOpenProviders = vi.fn(), onOpenDecisionModel = vi.fn(), open = true) {
  harness.stateIndex = harness.refIndex = harness.memoIndex = harness.effectIndex = 0;
  const all = nodes(JoinGroupDialog({agent, open, onClose, onChanged, tools, initialProvider, onOpenProviders, onOpenDecisionModel, ...(bind ? {initialGroup: {chatId: 'oc_existing', name: '已有群', addedAt: 0}} : {})}));
  return {
    all,
    name: all.find(node => node.type === 'input' && node.props['aria-label'])!,
    conversation: all.find(node => node.props.label === '沟通方式' && node.props.onChange)!,
    provider: all.find(node => node.props.label === '执行工具' && node.props.onChange)!,
    decision: all.find(node => node.props.initial === true)!,
    submit: all.find(node => node.props.variant === 'primary' && node.props.loading !== undefined)!,
    dialog: all.find(node => 'onClose' in node.props && 'open' in node.props)!,
  };
}
function chooseSmart(bind = true) {
  const ui = render(bind); ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('smart'); return render(bind);
}
async function settled() {for (let i = 0; i < 6; i++) await Promise.resolve();}
beforeEach(() => {
  harness.state = []; harness.refs = []; harness.memos = []; harness.effects = [];
  harness.draft = undefined; harness.deferEffects = false; harness.pendingEffects = [];
  harness.selection = {kind: 'default'}; harness.keySet = true; harness.keyUnreadable = false; harness.catalogState = 'ready';
  harness.defaultProvider = 'codex-appserver'; harness.hostError = ''; harness.agentError = ''; harness.hostPending = undefined; harness.agentPending = undefined;
  harness.catalogModels = [{id: 'gpt-6-luna', hidden: false, isDefault: true, supportedEfforts: ['low']}];
  vi.clearAllMocks();
});
it('starts with existing-group guidance, discovers joined groups, and binds the selected group', async () => {
  harness.client.run.mockImplementationOnce(async () => ({kind: 'groups', groups: [
    {id: 'oc_joined', name: '团队群', bound: false, hasOtherBots: false},
    {id: 'oc_bound', name: '已连接群', bound: true, hasOtherBots: false},
  ]}));
  const renderFlow = () => {
    harness.stateIndex = harness.refIndex = harness.memoIndex = harness.effectIndex = 0;
    return nodes(JoinGroupDialog({agent, open: true, onClose, onChanged, tools: readyCodex}));
  };
  let all = renderFlow();
  expect(all.some(node => node.props.children === '创建群聊' || node.props.children === '创建并连接')).toBe(false);
  expect(all.some(node => node.type === 'p' && String(node.props.children).includes('在飞书群的'))).toBe(true);
  all.find(node => node.props.children === '查找已经加入的群')!.props.onClick();
  await settled(); all = renderFlow();
  expect(harness.client.run).toHaveBeenCalledWith({type: 'listJoinedGroups', agentId: agent.id});
  const joined = all.find(node => node.type === 'button' && node.props.children?.[0]?.props?.children === '团队群')!;
  const bound = all.find(node => node.type === 'button' && node.props.children?.[0]?.props?.children === '已连接群')!;
  expect(bound.props.disabled).toBe(true);
  joined.props.onClick(); all = renderFlow();
  expect(all.some(node => node.props['aria-label'] === '本地绑定名称')).toBe(true);
  all.find(node => node.props.label === '沟通方式' && node.props.onChange)!.props.onChange('threads');
  all = renderFlow();
  await all.find(node => node.props.variant === 'primary' && node.props.loading !== undefined)!.props.onClick();
  expect(harness.client.run).toHaveBeenLastCalledWith(expect.objectContaining({type: 'bindGroup', groupId: 'oc_joined', projectName: '团队群'}));
  expect(onChanged).toHaveBeenCalledWith({agentId: agent.id, chatId: 'oc_joined'});
  expect(harness.client.collaboration).not.toHaveBeenCalled();
});
it('uses Claude for a Claude-only snapshot in a bind request', async () => {
  const tools: ToolState[] = [
    {tool: 'codex', installation: 'missing', authentication: 'signedOut', version: null},
    {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'},
  ];
  let ui = render(true, tools);
  expect(ui.provider.props.value).toBe('claude');
  ui.name.props.onChange({target: {value: '新名称'}});
  ui.conversation.props.onChange('threads');
  ui = render(true, tools);
  await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenLastCalledWith(expect.objectContaining({type: 'bindGroup', tool: 'claude'}));
  expect(harness.client.collaboration).not.toHaveBeenCalled();
});
it('keeps a hand-picked Provider when the snapshot or setup suggestion changes', async () => {
  const tools: ToolState[] = [
    {tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'},
    {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'},
  ];
  let ui = render(true, tools);
  expect(ui.provider.props.value).toBe('codex');
  ui.provider.props.onChange('claude');
  ui.name.props.onChange({target: {value: '新名称'}});
  ui.conversation.props.onChange('threads');
  ui = render(true, tools.map(item => item.tool === 'codex' ? {...item, installation: 'missing'} : item), 'codex');
  expect(ui.provider.props.value).toBe('claude');
  await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenCalledWith(expect.objectContaining({type: 'bindGroup', tool: 'claude'}));
});
it('keeps an unavailable hand-picked Provider visible and blocks submission until the user changes it', async () => {
  const both: ToolState[] = [readyCodex[0]!, {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'}];
  let ui = render(true, both);
  ui.provider.props.onChange('claude'); ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('threads');
  const changed = both.map(item => item.tool === 'claude' ? {...item, authentication: 'signedOut' as const} : item);
  ui = render(true, changed);
  expect(ui.provider.props.value).toBe('claude');
  expect(ui.submit.props.disabled).toBe(true);
  await ui.submit.props.onClick();
  expect(harness.client.collaboration.mock.calls.some(([request]) => request.action === 'createProject')).toBe(false);
  ui.provider.props.onChange('codex'); ui = render(true, changed);
  expect(ui.provider.props.value).toBe('codex');
});
it('uses the configured default for smart groups without an inline model chooser', async () => {
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.decision).toBeUndefined();
  expect(ui.all.some(node => node.props.label === '判断 Provider')).toBe(false);
  expect(ui.submit.props.disabled).toBe(false);
  await ui.submit.props.onClick();
  const request = harness.client.run.mock.calls.at(-1)?.[0];
  expect(request).toMatchObject({conversation: 'smart', tool: 'codex', judge: {kind: 'default'}});
  expect(request).not.toHaveProperty('project');
  expect(onChanged).toHaveBeenCalledWith({agentId: agent.id, chatId: 'oc_existing'});
  expect(harness.client.collaboration).not.toHaveBeenCalled();
});
it('keeps the default judgment Provider independent from the execution Provider', async () => {
  harness.defaultProvider = 'claude-agent';
  const tools = [readyCodex[0]!, {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'}] as ToolState[];
  let ui = render(true, tools); ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('smart');
  await settled(); ui = render(true, tools); await settled(); ui = render(true, tools);
  expect(ui.submit.props.disabled).toBe(false);
  await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenCalledWith(expect.objectContaining({type: 'bindGroup', tool: 'codex', judge: {kind: 'default'}}));
});
it('never copies an old Bot model snapshot into a bound group', async () => {
  harness.selection = {kind: 'llm', backend: 'codex-appserver', model: 'old-model'};
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(false);
  await ui.submit.props.onClick();
  const bind = harness.client.run.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(bind.judge).toEqual({kind: 'default'});
});
it.each([
  ['missing default', undefined, false, false],
  ['unavailable Provider', 'claude-agent', false, false],
  ['missing Jev key', 'typesafe', false, false],
  ['unreadable Jev key', 'typesafe', true, true],
] as const)('blocks smart setup with %s even when save is invoked directly', async (_name, provider, keySet, keyUnreadable) => {
  harness.defaultProvider = provider; harness.keySet = keySet; harness.keyUnreadable = keyUnreadable;
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(true);
  expect(ui.decision).toBeUndefined();
  expect(ui.all.some(node => node.props.children === '前往设置')).toBe(true);
  await ui.submit.props.onClick();
  expect(harness.client.collaboration.mock.calls.some(([request]) => request.action === 'createProject')).toBe(false);
});
it('allows Jev as the global default once its key is ready', async () => {
  harness.defaultProvider = 'typesafe'; harness.keySet = true;
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(false);
  await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenCalledWith(expect.objectContaining({type: 'bindGroup', judge: {kind: 'default'}}));
});
it.each(['host', 'agent'] as const)('preserves the draft but blocks save while %s configuration is being re-read after settings', async scope => {
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(false);
  render(true, readyCodex, undefined, vi.fn(), vi.fn(), false);
  if (scope === 'host') harness.hostPending = new Promise(() => {});
  else harness.agentPending = new Promise(() => {});
  ui = render();
  expect(ui.name.props.value).toBe('新名称');
  expect(ui.conversation.props.value).toBe('smart');
  expect(ui.submit.props.disabled).toBe(true);
  await ui.submit.props.onClick();
  await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(true);
  expect(harness.client.collaboration.mock.calls.some(([request]) => request.action === 'createProject')).toBe(false);
});
it.each(['host', 'agent'] as const)('keeps the draft and offers a retry when %s configuration fails', async scope => {
  if (scope === 'host') harness.hostError = '配置读取失败'; else harness.agentError = '密钥状态读取失败';
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(true);
  await ui.submit.props.onClick();
  expect(harness.client.collaboration.mock.calls.some(([request]) => request.action === 'createProject')).toBe(false);
  const retry = ui.all.find(node => /重试|重新读取/.test(node.props.label ?? ''));
  expect(retry).toBeDefined();
  harness.hostError = ''; harness.agentError = '';
  retry!.props.onClick(); await settled(); ui = render(); await settled(); ui = render();
  expect(ui.name.props.value).toBe('新名称');
  expect(ui.conversation.props.value).toBe('smart');
  expect(ui.submit.props.disabled).toBe(false);
});
it('blocks missing, signed-out, unknown, and too-old Providers even when handlers are invoked directly', async () => {
  for (const bad of [
    {installation: 'missing', authentication: 'signedOut'},
    {installation: 'installed', authentication: 'signedOut'},
    {installation: 'installed', authentication: 'unknown'},
    {installation: 'installed', authentication: 'signedIn', compatibility: {status: 'tooOld', minimumVersion: '2'}},
  ] as const) {
    harness.state = []; harness.refs = []; harness.memos = [];
    const tools = [{tool: 'codex', version: '1', ...bad}] as ToolState[];
    let ui = render(true, tools);
    expect(ui.provider.props.value).toBe('');
    ui.provider.props.onChange('codex');
    ui.name.props.onChange({target: {value: '新名称'}});
    ui.conversation.props.onChange('threads');
    ui = render(true, tools);
    expect(ui.provider.props.value).toBe('');
    expect(ui.submit.props.disabled).toBe(true);
    await ui.submit.props.onClick();
    expect(harness.client.collaboration).not.toHaveBeenCalled();
  }
});
it('offers Provider settings with no usable Provider and restores bind after refresh', async () => {
  const open = vi.fn();
  const missing: ToolState[] = [{tool: 'codex', installation: 'missing', authentication: 'signedOut', version: null}];
  let ui = render(true, missing, undefined, open);
  const settings = ui.all.find(node => node.props.children === '设置 Provider');
  expect(settings).toBeDefined();
  settings!.props.onClick(); expect(open).toHaveBeenCalledOnce();
  ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('threads');
  ui = render(true, readyCodex, undefined, open);
  expect(ui.provider.props.value).toBe('codex');
  await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenCalledWith(expect.objectContaining({type: 'bindGroup', tool: 'codex'}));
});

// Existing project records remain internal: connecting a group never exposes or sends project reuse.
const projectSnapshot = desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
  agents: [agent], groups: [{id: 'oc_existing', name: '已有群'}],
  projects: [{id: 'prj_00000001', name: '已有项目', revision: 1, directory: '/w/existing', bindings: [{agentId: agent.id, groupId: 'oc_existing'}]}],
  memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/t'},
});
it('does not show project reuse or send an explicit project even when the snapshot contains existing projects', async () => {
  harness.stateIndex = harness.refIndex = harness.memoIndex = harness.effectIndex = 0;
  const all = nodes(JoinGroupDialog({agent, open: true, onClose, onChanged, tools: readyCodex, snapshot: projectSnapshot, initialGroup: {chatId: 'oc_existing', name: '已有群', addedAt: 0}}));
  expect(all.some(node => node.props.label === '项目' || node.props['aria-label'] === '选择项目' || node.props.title === '项目主目录')).toBe(false);
  expect(all.some(node => node.props.title === '工作目录')).toBe(true);
  all.find(node => node.props.label === '沟通方式' && node.props.onChange)!.props.onChange('threads');
  const ui = render(true); await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenCalledWith(expect.objectContaining({type: 'bindGroup', groupId: 'oc_existing', folder: {kind: 'default'}}));
  expect(harness.client.run.mock.calls.at(-1)?.[0]).not.toHaveProperty('project');
});

it('locks directory navigation during async admission and restores focus after the chosen directory returns to the form', async () => {
  vi.useFakeTimers(); harness.deferEffects = true;
  const flushEffects = () => {for (const effect of harness.pendingEffects.splice(0)) effect();};
  // Use an independent hook range for the real nested DirectorySearchStep.
  const childOffset = 100;
  const renderDirectory = (step: Element) => {
    harness.stateIndex = harness.refIndex = harness.memoIndex = harness.effectIndex = childOffset;
    const child = nodes(DirectorySearchStep(step.props as Parameters<typeof DirectorySearchStep>[0]));
    flushEffects();
    return child;
  };
  let activeElement = 'body';
  const focus = vi.fn();
  const commitDirectoryTrigger = (all: Element[]) => {
    const trigger = all.find(node => node.type === 'button' && node.props['aria-label'] === '选择工作目录')!;
    // Browser focus() cannot focus a disabled button. Commit refs before passive effects.
    trigger.props.ref.current = {focus: () => {focus(); if (!trigger.props.disabled) activeElement = '选择工作目录';}};
    return trigger;
  };
  let finishChoose!: (reply: DirectoryReply) => void;
  const folder = {token: '00000000-0000-4000-8000-000000000001', displayPath: '/host/team'};
  harness.client.directory.mockImplementation(request => request.type === 'suggest'
    ? Promise.resolve({kind: 'suggestions', root: '/host', path: '/host', parent: null, truncated: false, entries: [{name: 'team', path: '/host/team', hidden: false}]})
    : new Promise<DirectoryReply>(resolve => {finishChoose = resolve;}));
  try {
    let ui = render(); flushEffects();
    ui.name.props.onChange({target: {value: '保留的群名称'}});
    ui.all.find(node => node.props.label === '目录来源')!.props.onChange('existing');
    ui = render(); flushEffects();
    const step = ui.all.find(node => node.type === DirectorySearchStep)!;
    renderDirectory(step);
    await vi.advanceTimersByTimeAsync(200); await settled();
    let directory = renderDirectory(step);
    directory.find(node => node.type === 'button' && node.props.className === 'join-directory-select')!.props.onClick();
    directory = renderDirectory(step); // choosing=true notifies the parent that admission is pending.
    ui = render(); flushEffects();
    expect(ui.all.find(node => node.props.children === '返回')!.props.disabled).toBe(true);
    expect(ui.all.find(node => node.props.label === '返回添加群聊')!.props.disabled).toBe(true);
    expect(ui.dialog.props.onClose).toBeUndefined();
    expect(harness.client.directory).toHaveBeenLastCalledWith({type: 'choose', path: '/host/team'});

    finishChoose({kind: 'folderChosen', folder}); await settled();
    ui = render();
    const disabledTrigger = commitDirectoryTrigger(ui.all); flushEffects();
    expect(ui.name.props.value).toBe('保留的群名称');
    expect(ui.all.some(node => node.props.title === folder.displayPath)).toBe(true);
    expect(disabledTrigger.props.disabled).toBe(true);
    expect(focus).not.toHaveBeenCalled(); // Must wait for the child's unmount to release busy.

    for (const effect of harness.effects.slice(childOffset)) effect?.cleanup?.();
    harness.effects.length = childOffset;
    ui = render(); const enabledTrigger = commitDirectoryTrigger(ui.all); flushEffects();
    expect(enabledTrigger.props.disabled).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    expect(activeElement).toBe('选择工作目录');
  } finally {
    for (const effect of harness.effects) effect?.cleanup?.();
    harness.pendingEffects = []; harness.deferEffects = false; vi.useRealTimers();
  }
});
