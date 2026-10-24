import {permissionValue} from './permission-fixture';
import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, groupIdSchema, membershipIdSchema, type DesktopSnapshot, type Membership, type ProjectRecord, type ProjectSettingsView, type SettingsReply, type SettingsRequest} from '@vonvon/protocol';
import {GroupWorkspace} from '../src/GroupWorkspace';
import {GroupDesignSettings, GroupSettingsContent} from '../src/settings/GroupDesignSettings';
import {Editor} from '../src/settings/SettingsPanel';
import {GroupAttentionStatus} from '../src/management/GroupAttentionStatus';
import {OperationActivity} from '../src/management/OperationActivity';
import {ConversationSlider} from '../src/settings/ConversationSlider';
import {DecisionFields} from '../src/settings/DecisionFields';
import {SettingChoices} from '../src/settings/SettingChoices';

type Slot = {states: unknown[]; refs: Array<{current: unknown}>; effects: Array<{deps?: unknown[]; cleanup?: () => void}>; memos: Array<{deps?: unknown[]; value: unknown}>; state: number; ref: number; effect: number; memo: number};
const harness = vi.hoisted(() => ({slots: {} as Record<string, Slot>, active: '', pending: [] as Array<() => void>, client: {collaboration: vi.fn(), settings: vi.fn(), environment: vi.fn(), snapshot: vi.fn()}}));
vi.mock('react', async original => {
  const memo = (factory: () => unknown, deps?: unknown[]) => {const slot = harness.slots[harness.active]!; const index = slot.memo++; const old = slot.memos[index]; if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return old.value; const value = factory(); slot.memos[index] = {deps, value}; return value;};
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const slot = harness.slots[harness.active]!; const index = slot.state++; if (!(index in slot.states)) slot.states[index] = typeof initial === 'function' ? initial() : initial; return [slot.states[index], (next: unknown) => {slot.states[index] = typeof next === 'function' ? next(slot.states[index]) : next;}];},
    useRef: (initial: unknown) => {const slot = harness.slots[harness.active]!; return slot.refs[slot.ref++] ??= {current: initial};},
    useContext: () => [],
    useId: () => 'conversation-description',
    useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const slot = harness.slots[harness.active]!; const index = slot.effect++; const old = slot.effects[index]; if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return; harness.pending.push(() => {old?.cleanup?.(); slot.effects[index] = {deps, cleanup: effect() || undefined};});},
  };
});
vi.mock('../src/client-context', () => ({useClient: () => harness.client, useShellCapabilities: () => undefined}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()}), useDraft: () => {}}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...nodes(node.props.children), ...nodes(node.props.responseHeader)];}
function renderAt(name: string, make: () => ReactNode) {
  const slot = harness.slots[name] ??= {states: [], refs: [], effects: [], memos: [], state: 0, ref: 0, effect: 0, memo: 0};
  slot.state = slot.ref = slot.effect = slot.memo = 0; harness.active = name;
  const result = make(); for (const effect of harness.pending.splice(0)) effect(); return result;
}
const botId = agentIdSchema.parse('cli_smart');
const groupId = groupIdSchema.parse('oc_smart');
const agent = {id: botId, name: '测试 Bot', enabled: true, running: true, connection: 'connected' as const, activation: 'active' as const};
const group = {id: groupId, name: '产品群'};
const member = {id: membershipIdSchema.parse('smart-group'), agentId: botId, groupId, name: '产品群', directory: '/project', backend: 'codex-appserver', conversation: 'shared' as const, response: 'mention' as const, permission: {administrator: 'full' as const, member: 'qa' as const, network: false}, stale: false};
const readyTools: DesktopSnapshot['tools'] = [{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'}];
const snapshot: DesktopSnapshot = {revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'}, agents: [agent], groups: [group], memberships: [member], tools: readyTools, jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'}};
const section = <T,>(stored: T, revision = 'settings-r1') => ({stored, effective: stored, revision, access: {kind: 'writable' as const}, apply: []});
const fixture = (): ProjectSettingsView => ({scope: {kind: 'project', botId, projectName: member.name}, identity: {chatId: groupId, backend: 'codex-appserver', cwd: '/project', kind: 'single'}, sections: {permission: section(permissionValue()), response: section({noMention: false}), model: section({selection: {kind: 'default'}}), judge: section({selection: {kind: 'default'}})}, members: {openIds: [], revision: 'members-r1'}});
const selection = {kind: 'provider' as const, provider: 'codex-appserver' as const};
let view = fixture();
let project: ProjectRecord;
let events: string[];
const changed = vi.fn(async () => {});
let save: (request: Extract<SettingsRequest, {type: 'save'}>) => Promise<SettingsReply>;
function saved(request: Extract<SettingsRequest, {type: 'save'}>): SettingsReply {
  view = {...view, sections: {...view.sections, judge: section({...view.sections.judge!.stored, ...request.edit.patch}, 'settings-r2')}};
  return {kind: 'saved', result: {kind: 'saved', section: {scope: view.scope, section: 'judge', value: view.sections.judge!}, effects: []}};
}
function render() {
  const workspace = nodes(renderAt('workspace', () => GroupWorkspace({member, agent, group, snapshot, initialTab: 'response', onBot: () => {}, onBotProfile: () => {}, onOpenTools: () => {}, onOpenSecrets: () => {}, onChanged: changed})));
  const dialog = workspace.find(node => node.props.title === '设置智能模式')!;
  let editor: Element[] = [];
  if (dialog.props.open) {
    const settings = nodes(dialog).find(node => node.type === GroupDesignSettings)!;
    if (!settings) return {workspace, content: [], header: []};
    const loader = GroupDesignSettings(settings.props as any) as Element;
    const content = nodes(renderAt('loader', () => (loader.type as (props: any) => ReactNode)(loader.props))).find(node => node.type === GroupSettingsContent);
    if (content) {
      const edit = renderAt('content', () => GroupSettingsContent(content.props as any)) as Element;
      editor = nodes(renderAt('editor', () => Editor(edit.props as any)));
    }
  }
  return {workspace, dialog, editor,
    mode: workspace.find(node => node.props.label === '聊天方式' && node.props.onChange)!,
    decision: editor.find(node => node.props.onChange && 'effective' in node.props),
    submit: editor.find(node => node.props.children === '保存并使用智能模式' && node.props.onClick),
  };
}
async function flush() {for (let i = 0; i < 16; i++) await Promise.resolve();}
async function settle() {await flush(); render(); await flush(); return render();}
async function openSmart() {render(); let ui = await settle(); ui.mode.props.onChange('smart'); render(); return settle();}
function messages(ui: ReturnType<typeof render>) {return [...ui.workspace, ...ui.editor].flatMap(node => [node.props.title, typeof node.props.children === 'string' ? node.props.children : '']).join('\n');}
beforeEach(() => {
  for (const slot of Object.values(harness.slots)) for (const effect of slot.effects) effect.cleanup?.();
  harness.slots = {}; harness.pending = []; vi.clearAllMocks(); view = fixture(); events = [];
  snapshot.tools = readyTools.map(tool => ({...tool}));
  project = {name: member.name, chatId: groupId, cwd: '/project', kind: 'single', backend: 'codex-appserver', enabled: true, revision: 'project-r1'};
  save = async request => saved(request);
  harness.client.environment.mockResolvedValue({kind: 'backends', entries: [{id: 'codex-appserver', displayName: 'Codex'}]});
  harness.client.snapshot.mockResolvedValue({...snapshot});
  harness.client.settings.mockImplementation(async (request: SettingsRequest) => {if (request.type === 'read') {events.push('read-settings'); return {kind: 'view', view};} if (request.type === 'save') {events.push('save-decision'); return save(request);} throw new Error(`unexpected settings ${request.type}`);});
  harness.client.collaboration.mockImplementation(async request => {if (request.action === 'project') {events.push('read-project'); return {kind: 'project', project};} if (request.action === 'editProject') {events.push('edit-project'); project = {...project, kind: 'smart', revision: 'project-r2'}; return {kind: 'applied', project};} throw new Error(`unexpected collaboration ${request.action}`);});
});

it('previews a drag across the middle mode and submits only its released destination', () => {
  const onChange = vi.fn();
  const inspect = () => nodes(renderAt('slider', () => ConversationSlider({label: '聊天方式', value: 'threads', onChange}))).find(node => node.type === 'input')!;
  let input = inspect();
  input.props.onPointerDown({button: 0, pointerId: 1, currentTarget: {setPointerCapture: vi.fn()}});
  input.props.onChange({currentTarget: {value: '1'}}); input = inspect();
  expect(input.props['aria-valuetext']).toBe('连续交谈'); expect(onChange).not.toHaveBeenCalled();
  input.props.onChange({currentTarget: {value: '2'}}); input = inspect();
  expect(input.props['aria-valuetext']).toBe('智能'); expect(onChange).not.toHaveBeenCalled();
  input.props.onPointerUp(); input.props.onLostPointerCapture();
  expect(onChange).toHaveBeenCalledExactlyOnceWith('smart');
  // Opening or cancelling the smart setup does not make the preview the saved mode.
  expect(inspect().props['aria-valuetext']).toBe('独立话题');
});

it.each(['onPointerCancel', 'onLostPointerCapture'])('cancels a drag on %s without saving a mode', event => {
  const onChange = vi.fn();
  const inspect = () => nodes(renderAt('slider', () => ConversationSlider({label: '聊天方式', value: 'shared', onChange}))).find(node => node.type === 'input')!;
  let input = inspect();
  input.props.onPointerDown({button: 0, pointerId: 1, currentTarget: {setPointerCapture: vi.fn()}});
  input.props.onChange({currentTarget: {value: '2'}}); input = inspect();
  input.props[event](); input.props.onPointerUp();
  expect(onChange).not.toHaveBeenCalled(); expect(inspect().props['aria-valuetext']).toBe('连续交谈');
});

it('commits a keyboard gesture once and cancels a pending gesture if the control is disabled', () => {
  const onChange = vi.fn(); let disabled = false;
  const inspect = () => nodes(renderAt('slider', () => ConversationSlider({label: '聊天方式', value: 'threads', disabled, onChange}))).find(node => node.type === 'input')!;
  let input = inspect(); input.props.onKeyDown({key: 'End'});
  input.props.onChange({currentTarget: {value: '2'}}); input = inspect();
  expect(onChange).not.toHaveBeenCalled(); input.props.onKeyUp({key: 'End'}); input.props.onBlur();
  expect(onChange).toHaveBeenCalledExactlyOnceWith('smart'); onChange.mockClear();
  input = inspect(); input.props.onKeyDown({key: 'ArrowRight'}); input.props.onChange({currentTarget: {value: '1'}});
  disabled = true; input = inspect(); input.props.onKeyUp({key: 'ArrowRight'});
  expect(onChange).not.toHaveBeenCalled(); expect(input.props['aria-valuetext']).toBe('独立话题');
});

it('shows attention beside the smart conversation control on 沟通方式 and hides it while either mode source changes', async () => {
  let liveMember: Membership = {...member, conversation: 'smart', enabled: true};
  project = {...project, kind: 'smart'};
  view = {...view, identity: {...view.identity, kind: 'smart'}};
  harness.client.collaboration.mockImplementation(async request => {
    if (request.action === 'project') return {kind: 'project', project};
    if (request.action === 'editProject') {
      project = {...project, kind: request.conversation === 'shared' ? 'single' : 'smart', revision: 'project-r2'};
      return {kind: 'applied', project};
    }
    throw new Error(`unexpected collaboration ${request.action}`);
  });
  function inspect() {
    const workspace = nodes(renderAt('attention-workspace', () => GroupWorkspace({member: liveMember, agent, group,
      snapshot: {...snapshot, memberships: [liveMember]}, initialTab: 'response', onBot: () => {}, onBotProfile: () => {},
      onOpenTools: () => {}, onOpenSecrets: () => {}, onChanged: changed})));
    const settings = workspace.find(node => node.type === GroupDesignSettings && !node.props.decisionSetupOnly)!;
    if (!settings) return {workspace, content: [], header: []};
    const loader = GroupDesignSettings(settings.props as any) as Element;
    const loaded = nodes(renderAt('attention-loader', () => (loader.type as (props: any) => ReactNode)(loader.props)))
      .find(node => node.type === GroupSettingsContent);
    const content = loaded ? nodes(renderAt('attention-content', () => GroupSettingsContent(loaded.props as any))) : [];
    return {workspace, content, header: nodes(settings.props.responseHeader)};
  }
  async function settled() {inspect(); await flush(); inspect(); await flush(); return inspect();}
  let ui = await settled();
  const headerAttention = ui.header.find(node => node.type === GroupAttentionStatus)!;
  expect(headerAttention).toBeDefined();
  expect(headerAttention.props).toMatchObject({agent, membership: liveMember, connected: true});
  expect(ui.header.some(node => node.props.label === '聊天方式')).toBe(true);
  expect(ui.content.some(node => node.type === GroupAttentionStatus)).toBe(true);

  ui.workspace.find(node => node.type === 'button' && node.props.children === '记忆')!.props.onClick();
  ui = await settled();
  expect(ui.content.some(node => node.type === GroupAttentionStatus)).toBe(false);
  ui.workspace.find(node => node.type === 'button' && node.props.children === '沟通方式')!.props.onClick();
  ui = await settled();
  expect(ui.content.some(node => node.type === GroupAttentionStatus)).toBe(true);

  // A snapshot can change before the accepted ProjectRecord, or vice versa.
  liveMember = {...liveMember, conversation: 'shared'};
  ui = await settled();
  expect(ui.content.some(node => node.type === GroupAttentionStatus)).toBe(false);
  liveMember = {...liveMember, conversation: 'smart'};
  ui = await settled();
  expect(ui.content.some(node => node.type === GroupAttentionStatus)).toBe(true);
  ui.header.find(node => node.props.label === '聊天方式' && node.props.onChange)!.props.onChange('shared');
  ui = await settled();
  expect(project.kind).toBe('single');
  expect(liveMember.conversation).toBe('smart');
  expect(ui.content.some(node => node.type === GroupAttentionStatus)).toBe(false);
});

it('validates a selection, waits for decision persistence, then changes the mode with the observed project revision', async () => {
  let ui = await openSmart();
  expect(ui.dialog.props.open).toBe(true); expect(ui.mode.props.value).toBe('shared');
  ui.submit!.props.onClick(); ui = await settle();
  expect(messages(ui)).toContain('请选择判断 Provider');
  expect(harness.client.settings.mock.calls.some(([request]) => request.type === 'save')).toBe(false);
  ui.decision!.props.onChange(selection); ui = render();
  let resolve!: (reply: SettingsReply) => void;
  let request!: Extract<SettingsRequest, {type: 'save'}>;
  save = incoming => {request = incoming; return new Promise(done => {resolve = done;});};
  events = []; ui.submit!.props.onClick(); ui = await settle();
  expect(events).toEqual(['save-decision']); expect(ui.submit!.props.disabled).toBe(true); expect(ui.dialog.props.open).toBe(true);
  resolve(saved(request)); ui = await settle();
  expect(events).toEqual(['save-decision', 'read-settings', 'read-project', 'edit-project']);
  expect(request.edit).toMatchObject({scope: view.scope, section: 'judge', revision: 'settings-r1', patch: {selection}});
  expect(harness.client.collaboration).toHaveBeenLastCalledWith({action: 'editProject', agentId: botId, groupId, projectName: member.name, expectedRevision: 'project-r1', conversation: 'smart'});
  expect(ui.dialog.props.open).toBe(false); expect(ui.mode.props.value).toBe('smart'); expect(changed).toHaveBeenCalledOnce();
});
it('keeps the decision draft and dialog open when the decision save fails, without editing the group', async () => {
  let ui = await openSmart(); ui.decision!.props.onChange(selection); ui = render();
  save = async () => ({kind: 'saved', result: {kind: 'rejected', fields: [{field: 'selection', message: '模型不可用'}]}});
  events = []; ui.submit!.props.onClick(); ui = await settle();
  expect(events).toEqual(['save-decision']); expect(ui.dialog.props.open).toBe(true); expect(ui.mode.props.value).toBe('shared');
  expect(ui.decision!.props.value).toEqual(selection); expect(messages(ui)).toContain('模型不可用');
  expect(messages(ui)).not.toContain('本次修改已保存'); expect(changed).not.toHaveBeenCalled();
});
it('keeps the smart dialog open when mode change fails after saving the decision, and reports no success', async () => {
  let ui = await openSmart(); ui.decision!.props.onChange(selection); ui = render();
  harness.client.collaboration.mockImplementation(async request => request.action === 'project' ? {kind: 'project', project} : {kind: 'refused', message: '群连接暂不可用'});
  ui.submit!.props.onClick(); ui = await settle();
  expect(ui.dialog.props.open).toBe(true); expect(ui.mode.props.value).toBe('shared');
  expect(ui.decision!.props.value).toEqual(selection); expect(messages(ui)).toContain('决策模型已保存，未能切换聊天方式');
  expect(ui.submit!.props.disabled).toBe(false);
  expect(messages(ui)).not.toContain('设置已在别处更改');
  expect(messages(ui)).not.toContain('本次修改已保存'); expect(changed).not.toHaveBeenCalled();
  harness.client.collaboration.mockImplementation(async request => request.action === 'project' ? {kind: 'project', project} : {kind: 'applied', project: {...project, kind: 'smart', revision: 'project-r2'}});
  ui.submit!.props.onClick(); ui = await settle();
  const saves = harness.client.settings.mock.calls.filter(([request]) => request.type === 'save');
  expect(saves).toHaveLength(2);
  expect(saves[1]![0].edit).toMatchObject({revision: 'settings-r2', patch: {selection}});
  expect(ui.dialog.props.open).toBe(false); expect(ui.mode.props.value).toBe('smart'); expect(changed).toHaveBeenCalledOnce();
});
it('can confirm an already configured decision without making a spurious field edit', async () => {
  view.sections.judge = section({selection}); let ui = await openSmart();
  expect(ui.submit!.props.disabled).toBe(false); ui.submit!.props.onClick(); ui = await settle();
  expect(harness.client.settings).toHaveBeenCalledWith({type: 'save', edit: {scope: view.scope, section: 'judge', revision: 'settings-r1', patch: {selection}}});
  expect(ui.dialog.props.open).toBe(false); expect(ui.mode.props.value).toBe('smart');
});

it.each(['signedOut', 'unknown'] as const)('blocks a stale decision choice when the live Provider state becomes %s', async authentication => {
  let ui = await openSmart();
  ui.decision!.props.onChange(selection); ui = await settle();
  expect(ui.decision!.props.providers.map((provider: {id: string}) => provider.id)).toContain('codex-appserver');
  // The separate RPC mock deliberately remains signed in: the current page snapshot wins.
  snapshot.tools = [{...readyTools[0]!, authentication}];
  ui = await settle();
  expect(ui.decision!.props.providers).toEqual([]);
  events = []; ui.submit!.props.onClick(); ui = await settle();
  expect(events).toEqual([]);
  expect(messages(ui)).toContain('此判断 Provider 当前不可用');
  expect(ui.dialog.props.open).toBe(true);
  expect(ui.mode.props.value).toBe('shared');
});

it('does not rewrite a legacy group decision when switching to smart until a provider is chosen', async () => {
  const legacy = {kind: 'llm' as const, backend: 'codex-appserver', model: 'old-model', effort: 'high' as const};
  view.sections.judge = section({selection: legacy});
  let ui = await openSmart();
  expect(ui.decision!.props.value).toEqual(legacy);
  ui.submit!.props.onClick(); ui = await settle();
  expect(messages(ui)).toContain('请选择判断 Provider');
  expect(harness.client.settings.mock.calls.some(([request]) => request.type === 'save')).toBe(false);
  ui.decision!.props.onChange(selection); ui = render(); ui.submit!.props.onClick(); ui = await settle();
  const request = harness.client.settings.mock.calls.find(([request]) => request.type === 'save')?.[0] as Extract<SettingsRequest, {type: 'save'}>;
  expect(request.edit.patch).toEqual({selection});
});

it.each([
  {enabled: false, reply: 'applied', label: '本群停用中'},
  {enabled: true, reply: 'refused', label: '本群启用中'},
] as const)('shows group lifecycle activity only while the $label request is pending', async ({enabled, reply, label}) => {
  project = {...project, enabled: !enabled};
  let resolve!: (value: unknown) => void;
  harness.client.collaboration.mockImplementation(async request => {
    if (request.action === 'project') return {kind: 'project', project};
    if (request.action === 'editProject') return new Promise(done => {resolve = done;});
    throw new Error(`unexpected collaboration ${request.action}`);
  });
  const inspect = () => nodes(renderAt('lifecycle-workspace', () => GroupWorkspace({member, agent, group, snapshot,
    initialTab: 'response', onBot: () => {}, onBotProfile: () => {}, onOpenTools: () => {}, onOpenSecrets: () => {}, onChanged: changed})));
  inspect(); await flush(); let ui = inspect();
  expect(ui.some(node => node.type === OperationActivity)).toBe(false);
  const toggle = ui.find(node => node.props['aria-label'] === `在本群使用 ${agent.name}`)!;
  toggle.props.onChange({target: {checked: enabled}});
  await flush(); ui = inspect();
  expect(harness.client.collaboration).toHaveBeenCalledWith(expect.objectContaining({action: 'editProject', enabled}));
  expect(ui.find(node => node.type === OperationActivity)?.props.label).toBe(label);
  expect(ui.find(node => node.props['aria-label'] === `在本群使用 ${agent.name}`)?.props.disabled).toBe(true);
  resolve(reply === 'applied' ? {kind: 'applied', project: {...project, enabled, revision: 'project-r2'}} : {kind: 'refused', message: '保存失败'});
  await flush(); ui = inspect();
  expect(ui.some(node => node.type === OperationActivity)).toBe(false);
  if (reply === 'refused') expect(ui.some(node => node.props.title === '操作未完成')).toBe(true);
});

function renderInstantDecision() {
  const content = nodes(renderAt('instant-content', () => GroupSettingsContent({view, refresh: async () => {}, tab: 'response', tools: readyTools, onOpenSecrets: () => {}})));
  const editor = content.find(node => node.type === Editor && node.props.title === '决策模型')!;
  const rendered = nodes(renderAt('instant-editor', () => Editor(editor.props as any)));
  return {rendered, decision: rendered.find(node => node.type === DecisionFields)!};
}
async function settleInstantDecision() {renderInstantDecision(); await flush(); renderInstantDecision(); await flush(); return renderInstantDecision();}
function prepareInstantDecision() {
  view = {...view, identity: {...view.identity, kind: 'smart'}, sections: {...view.sections, judge: section({selection: {kind: 'provider', provider: 'typesafe'}})},
    decisionModels: [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', keySet: true, models: [{id: 'jev-latest', displayName: 'Jev'}]}]};
}
function saveCalls() {return harness.client.settings.mock.calls.filter(([request]) => request.type === 'save');}

it('saves an existing smart group’s Provider on selection without Save, and serializes repeated clicks', async () => {
  prepareInstantDecision(); let ui = await settleInstantDecision();
  let resolve!: (reply: SettingsReply) => void;
  let request!: Extract<SettingsRequest, {type: 'save'}>;
  save = incoming => {request = incoming; return new Promise(done => {resolve = done;});};
  const select = ui.decision.props.onChange;
  select(selection); select(selection);
  ui = renderInstantDecision();
  expect(saveCalls()).toHaveLength(1);
  expect(request.edit).toMatchObject({section: 'judge', revision: 'settings-r1', patch: {selection}});
  expect(ui.decision.props.value).toEqual(selection); expect(ui.decision.props.disabled).toBe(true);
  expect(ui.rendered.some(node => node.props.children === '保存' || node.props.children === '放弃修改')).toBe(false);
  resolve(saved(request)); ui = await settleInstantDecision();
  expect(ui.decision.props.value).toEqual(selection); expect(ui.decision.props.disabled).toBe(false);
  expect(ui.rendered.some(node => node.props.title === '本次修改已保存')).toBe(false);
});

it.each(['rejected', 'transport'])('restores the confirmed Provider after an automatic %s failure and permits another selection', async kind => {
  prepareInstantDecision(); let ui = await settleInstantDecision();
  save = async () => {if (kind === 'transport') throw new Error('连接暂不可用'); return {kind: 'saved', result: {kind: 'rejected', fields: [{field: 'selection', message: '模型暂不可用'}]}};};
  ui.decision.props.onChange(selection); ui = await settleInstantDecision();
  expect(ui.decision.props.value).toEqual({kind: 'provider', provider: 'typesafe'});
  expect(nodes(DecisionFields(ui.decision.props as any)).find(node => node.type === SettingChoices)!.props.value).toBe('typesafe');
  expect(ui.decision.props.disabled).toBe(false);
  expect(ui.rendered.some(node => node.props.title === '切换未完成')).toBe(true);
  expect(ui.rendered.some(node => node.props.children === '保存')).toBe(false);
  save = async request => saved(request);
  ui.decision.props.onChange(selection); ui = await settleInstantDecision();
  expect(ui.decision.props.value).toEqual(selection); expect(saveCalls()).toHaveLength(2);
});

it('does not automatically save a readonly decision choice', async () => {
  prepareInstantDecision(); view.sections.judge!.access = {kind: 'readonly', reason: 'bot-stopped', message: '只读'} as any;
  const ui = await settleInstantDecision();
  expect(ui.decision.props.disabled).toBe(true);
  ui.decision.props.onChange(selection);
  expect(saveCalls()).toHaveLength(0);
});
