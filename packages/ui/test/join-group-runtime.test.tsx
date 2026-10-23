import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentSchema, type ToolState} from '@vonvon/protocol';
import {JoinGroupDialog} from '../src/JoinGroupDialog';

const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Array<{deps?: unknown[]}>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  draft: undefined as undefined | {save?: () => Promise<boolean>; discard: () => void},
  selection: {kind: 'default'} as {kind: string; backend?: string; model?: string; provider?: string},
  keySet: false,
  catalogState: 'ready' as 'ready' | 'unavailable',
  catalogModels: [{id: 'gpt-6-luna', hidden: false, isDefault: true, supportedEfforts: ['low']}] as Array<{id: string; hidden: boolean; isDefault: boolean; supportedEfforts: string[]}>,
  client: {collaboration: vi.fn(async (request: {action: string}) => request.action === 'providerModels' ? {kind: 'providerModels', state: harness.catalogState, models: harness.catalogModels} : {kind: 'applied', project: {chatId: 'oc_created'}}), run: vi.fn(async () => ({kind: 'applied'})), settings: vi.fn(async () => ({kind: 'view', view: {scope: {kind: 'agent'}, administrators: {}, sections: {judge: {stored: {selection: harness.selection}, effective: {selection: harness.selection}}}, judgeByBackend: {'codex-appserver': {model: 'gpt-6-luna', effort: 'low', source: 'default'}, 'claude-agent': {model: 'haiku', source: 'default'}}, decisionModels: [{provider: 'actual', displayName: 'Actual', models: [{id: 'jev-actual', displayName: 'Jev'}], keySet: harness.keySet}]}}))},
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const index = harness.stateIndex++; if (!(index in harness.state)) harness.state[index] = initial; return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;}];},
  useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= {current: initial},
  useEffect: (callback: () => void, deps?: unknown[]) => {const index = harness.effectIndex++; const old = harness.effects[index]; if (old?.deps && deps && deps.every((item, at) => Object.is(item, old.deps![at]))) return; harness.effects[index] = {deps}; callback();},
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
  return [node, ...nodes(node.props.children), ...nodes(node.props.trailing)];
}
const readyCodex: ToolState[] = [{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'}];
function render(bind = false, tools: ToolState[] = readyCodex, initialProvider?: 'codex' | 'claude', onOpenProviders = vi.fn(), onOpenDecisionModel = vi.fn(), open = true) {
  harness.stateIndex = harness.refIndex = harness.memoIndex = harness.effectIndex = 0;
  const all = nodes(JoinGroupDialog({agent, open, onClose, onChanged, tools, initialProvider, onOpenProviders, onOpenDecisionModel, ...(bind ? {initialGroup: {chatId: 'oc_existing', name: '已有群', addedAt: 0}} : {})}));
  return {
    all,
    name: all.find(node => node.type === 'input' && node.props['aria-label'])!,
    conversation: all.find(node => node.props.label === '会话方式' && node.props.onChange)!,
    provider: all.find(node => node.props.label === '执行工具' && node.props.onChange)!,
    decision: all.find(node => node.props.initial === true)!,
    submit: all.find(node => node.props.variant === 'primary' && node.props.loading !== undefined)!,
    dialog: all.find(node => 'onClose' in node.props && 'open' in node.props)!,
  };
}
function chooseSmart(bind = false) {
  const ui = render(bind); ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('smart'); return render(bind);
}
async function settled() {await Promise.resolve(); await Promise.resolve();}
beforeEach(() => {
  harness.state = []; harness.refs = []; harness.memos = []; harness.effects = [];
  harness.draft = undefined;
  harness.selection = {kind: 'default'}; harness.keySet = false; harness.catalogState = 'ready';
  harness.catalogModels = [{id: 'gpt-6-luna', hidden: false, isDefault: true, supportedEfforts: ['low']}];
  vi.clearAllMocks();
});
it('uses Claude for a Claude-only snapshot in create and bind requests', async () => {
  const tools: ToolState[] = [
    {tool: 'codex', installation: 'missing', authentication: 'signedOut', version: null},
    {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'},
  ];
  for (const bind of [false, true]) {
    harness.state = []; harness.refs = []; harness.memos = [];
    let ui = render(bind, tools);
    expect(ui.provider.props.value).toBe('claude');
    ui.name.props.onChange({target: {value: '新名称'}});
    ui.conversation.props.onChange('threads');
    ui = render(bind, tools);
    await ui.submit.props.onClick();
    const request = bind ? harness.client.run : harness.client.collaboration;
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({tool: 'claude'}));
  }
});
it('keeps a hand-picked Provider when the snapshot or setup suggestion changes', async () => {
  const tools: ToolState[] = [
    {tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'},
    {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'},
  ];
  let ui = render(false, tools);
  expect(ui.provider.props.value).toBe('codex');
  ui.provider.props.onChange('claude');
  ui.name.props.onChange({target: {value: '新名称'}});
  ui.conversation.props.onChange('threads');
  ui = render(false, tools.map(item => item.tool === 'codex' ? {...item, installation: 'missing'} : item), 'codex');
  expect(ui.provider.props.value).toBe('claude');
  await ui.submit.props.onClick();
  expect(harness.client.collaboration).toHaveBeenCalledWith(expect.objectContaining({tool: 'claude'}));
});
it('keeps an unavailable hand-picked Provider visible and blocks submission until the user changes it', async () => {
  const both: ToolState[] = [readyCodex[0]!, {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'}];
  let ui = render(false, both);
  ui.provider.props.onChange('claude'); ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('threads');
  const changed = both.map(item => item.tool === 'claude' ? {...item, authentication: 'signedOut' as const} : item);
  ui = render(false, changed);
  expect(ui.provider.props.value).toBe('claude');
  expect(ui.submit.props.disabled).toBe(true);
  await ui.submit.props.onClick();
  expect(harness.client.collaboration.mock.calls.some(([request]) => request.action === 'createProject')).toBe(false);
  ui.provider.props.onChange('codex'); ui = render(false, changed);
  expect(ui.provider.props.value).toBe('codex');
});
it('requires a provider choice and sends only provider selection for a new smart group', async () => {
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(true);
  ui.decision.props.onChange({kind: 'provider', provider: 'codex-appserver'});
  ui = render(); expect(ui.submit.props.disabled).toBe(false);
  await ui.submit.props.onClick();
  const create = harness.client.collaboration.mock.calls.find(([request]) => request.action === 'createProject')?.[0] as Record<string, unknown>;
  expect(create).toMatchObject({action: 'createProject', conversation: 'smart', tool: 'codex', judge: {kind: 'provider', provider: 'codex-appserver'}});
  expect(Object.keys(create.judge as object)).toEqual(['kind', 'provider']);
});
it('keeps judgment Provider independent from the execution Provider', async () => {
  const tools = [readyCodex[0]!, {tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'}] as ToolState[];
  let ui = render(false, tools); ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('smart');
  await settled(); ui = render(false, tools);
  ui.decision.props.onChange({kind: 'provider', provider: 'claude-agent'});
  ui = render(false, tools); await ui.submit.props.onClick();
  expect(harness.client.collaboration).toHaveBeenCalledWith(expect.objectContaining({action: 'createProject', tool: 'codex', judge: {kind: 'provider', provider: 'claude-agent'}}));
});
it('never copies an old Bot model snapshot into a new group', async () => {
  harness.selection = {kind: 'llm', backend: 'codex-appserver', model: 'old-model'};
  let ui = chooseSmart(); await settled(); ui = render();
  expect(ui.submit.props.disabled).toBe(true);
  ui.decision.props.onChange({kind: 'provider', provider: 'codex-appserver'});
  ui = render(); await ui.submit.props.onClick();
  const create = harness.client.collaboration.mock.calls.find(([request]) => request.action === 'createProject')?.[0] as Record<string, unknown>;
  expect(create.judge).toEqual({kind: 'provider', provider: 'codex-appserver'});
});
it('binds an existing group with an explicit provider selection', async () => {
  let ui = chooseSmart(true); await settled(); ui = render(true);
  ui.decision.props.onChange({kind: 'provider', provider: 'codex-appserver'});
  ui = render(true); await ui.submit.props.onClick();
  expect(harness.client.run).toHaveBeenCalledWith(expect.objectContaining({type: 'bindGroup', groupId: 'oc_existing', judge: {kind: 'provider', provider: 'codex-appserver'}}));
  expect(onChanged).toHaveBeenCalledWith({agentId: agent.id, chatId: 'oc_existing'});
});
it('blocks unavailable judgment Provider even when save is invoked directly', async () => {
  let ui = chooseSmart(); await settled(); ui = render();
  ui.decision.props.onChange({kind: 'provider', provider: 'claude-agent'});
  ui = render(); expect(ui.submit.props.disabled).toBe(true);
  await ui.submit.props.onClick();
  expect(harness.client.collaboration.mock.calls.some(([request]) => request.action === 'createProject')).toBe(false);
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
    let ui = render(false, tools);
    expect(ui.provider.props.value).toBe('');
    ui.provider.props.onChange('codex');
    ui.name.props.onChange({target: {value: '新名称'}});
    ui.conversation.props.onChange('threads');
    ui = render(false, tools);
    expect(ui.provider.props.value).toBe('');
    expect(ui.submit.props.disabled).toBe(true);
    await ui.submit.props.onClick();
    expect(harness.client.collaboration).not.toHaveBeenCalled();
  }
});
it('offers Provider settings with no usable Provider and restores create after refresh', async () => {
  const open = vi.fn();
  const missing: ToolState[] = [{tool: 'codex', installation: 'missing', authentication: 'signedOut', version: null}];
  let ui = render(false, missing, undefined, open);
  const settings = ui.all.find(node => node.props.children === '设置 Provider');
  expect(settings).toBeDefined();
  settings!.props.onClick(); expect(open).toHaveBeenCalledOnce();
  ui.name.props.onChange({target: {value: '新名称'}}); ui.conversation.props.onChange('threads');
  ui = render(false, readyCodex, undefined, open);
  expect(ui.provider.props.value).toBe('codex');
  await ui.submit.props.onClick();
  expect(harness.client.collaboration).toHaveBeenCalledWith(expect.objectContaining({tool: 'codex'}));
});
