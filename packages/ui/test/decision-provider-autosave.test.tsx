import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {type HostSettingsView, type SettingsReply, type SettingsRequest} from '@vonvon/protocol';
import {DecisionProviderFields, DecisionProviderSettings} from '../src/management/DecisionProviderSettings';
import {DecisionPicker} from '../src/settings/DecisionPicker';
import {Editor} from '../src/settings/SettingsPanel';

// Run the actual page, field adapter and Editor; no DOM or additional test dependency is required.
type Slot = {states: unknown[]; refs: Array<{current: unknown}>; effects: Array<{deps?: unknown[]; cleanup?: () => void}>; memos: Array<{deps?: unknown[]; value: unknown}>; state: number; ref: number; effect: number; memo: number};
const harness = vi.hoisted(() => ({slots: {} as Record<string, Slot>, active: '', pending: [] as Array<() => void>, client: {settings: vi.fn()}}));
vi.mock('react', async original => {
  const memo = (factory: () => unknown, deps?: unknown[]) => {
    const slot = harness.slots[harness.active]!; const index = slot.memo++; const old = slot.memos[index];
    if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return old.value;
    const value = factory(); slot.memos[index] = {deps, value}; return value;
  };
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const slot = harness.slots[harness.active]!; const index = slot.state++; if (!(index in slot.states)) slot.states[index] = typeof initial === 'function' ? initial() : initial; return [slot.states[index], (next: unknown) => {slot.states[index] = typeof next === 'function' ? next(slot.states[index]) : next;}];},
    useRef: (initial: unknown) => {const slot = harness.slots[harness.active]!; return slot.refs[slot.ref++] ??= {current: initial};},
    useContext: () => [],
    useId: () => 'decision-autosave',
    useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
      const slot = harness.slots[harness.active]!; const index = slot.effect++; const old = slot.effects[index];
      if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return;
      harness.pending.push(() => {old?.cleanup?.(); slot.effects[index] = {deps, cleanup: effect() || undefined};});
    },
  };
});
vi.mock('../src/client-context', () => ({useClient: () => harness.client}));
vi.mock('../src/settings/useDecisionCatalogs', () => ({useDecisionCatalogs: () => ({catalogs: {}, refresh: vi.fn()})}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: () => {}}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.actions), ...nodes(node.props.action), ...nodes(node.props.trailing)] : [];}
function content(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(content).join(''); return isValidElement<Record<string, any>>(node) ? content(node.props.children) : '';}
function renderAt(name: string, make: () => ReactNode) {
  const slot = harness.slots[name] ??= {states: [], refs: [], effects: [], memos: [], state: 0, ref: 0, effect: 0, memo: 0};
  slot.state = slot.ref = slot.effect = slot.memo = 0; harness.active = name;
  const result = make(); for (const effect of harness.pending.splice(0)) effect(); return result;
}
type Configuration = NonNullable<HostSettingsView['sections']['judge']>['stored'];
const initial: Configuration = {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'gpt-6-luna', effort: 'low' as const}, 'claude-agent': {model: 'haiku'}, typesafe: {model: 'jev-latest'}}};
const section = (stored: typeof initial, revision: string) => ({stored, effective: stored, revision, access: {kind: 'writable' as const}, apply: []});
let confirmed = section(structuredClone(initial), 'r1');
let revision = 1;
type SaveRequest = Extract<SettingsRequest, {type: 'save'}>;
let respond: (request: SaveRequest) => Promise<SettingsReply>;
function accept(request: SaveRequest): SettingsReply {
  confirmed = section({...confirmed.stored, ...request.edit.patch} as typeof initial, `r${++revision}`);
  return {kind: 'saved', result: {kind: 'saved', section: {scope: {kind: 'host'}, section: 'judge', value: confirmed}, effects: []}};
}
const saveCalls = () => harness.client.settings.mock.calls.map(([request]) => request as SettingsRequest).filter((request): request is SaveRequest => request.type === 'save');
function render() {
  const page = nodes(renderAt('page', () => DecisionProviderSettings({})));
  const editor = page.find(node => node.type === Editor);
  if (!editor) return {all: page, picker: undefined};
  const editing = nodes(renderAt('editor', () => Editor(editor.props as any)));
  const field = editing.find(node => node.type === DecisionProviderFields)!;
  const fields = nodes(DecisionProviderFields(field.props as Parameters<typeof DecisionProviderFields>[0]));
  return {all: [...page, ...editing, ...fields], picker: fields.find(node => node.type === DecisionPicker)!};
}
async function settle() {for (let pass = 0; pass < 6; pass++) {render(); for (let tick = 0; tick < 6; tick++) await Promise.resolve();} return render();}
function expectNoManualActions(all: Element[]) {
  expect(all.some(node => /^(保存|保存模型配置|放弃修改)$/.test(content(node.props.children)))).toBe(false);
  expect(all.some(node => node.props.className === 'decision-save-bar')).toBe(false);
}
beforeEach(() => {
  for (const slot of Object.values(harness.slots)) for (const effect of slot.effects) effect.cleanup?.();
  harness.slots = {}; harness.pending = []; vi.clearAllMocks();
  revision = 1; confirmed = section(structuredClone(initial), 'r1');
  respond = async request => accept(request);
  harness.client.settings.mockImplementation(async (request: SettingsRequest) => {
    if (request.type === 'read') return {kind: 'view', view: {scope: {kind: 'host'}, runtime: {}, sections: {judge: confirmed}}};
    if (request.type === 'save') return respond(request);
    throw new Error(`unexpected settings request ${request.type}`);
  });
});
it('saves model and effort choices immediately without Save/Discard buttons, using the accepted revision for the next choice', async () => {
  let ui = await settle();
  expect(ui.picker!.props.value).toEqual({provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'low'});
  expectNoManualActions(ui.all);
  let finish!: (reply: SettingsReply) => void;
  respond = () => new Promise(resolve => {finish = resolve;});
  ui.picker!.props.onChange({provider: 'claude-agent', model: 'haiku'});
  expect(saveCalls()).toHaveLength(1);
  const first = saveCalls()[0]!;
  expect(first.edit).toMatchObject({scope: {kind: 'host'}, section: 'judge', revision: 'r1', patch: {defaultProvider: 'claude-agent'}});
  ui = render();
  expect(ui.picker!.props.disabled).toBe(true);
  expect(ui.picker!.props.value).toEqual({provider: 'claude-agent', model: 'haiku'});
  expectNoManualActions(ui.all);
  finish(accept(first)); ui = await settle();
  expect(ui.picker!.props.disabled).toBe(false);
  expectNoManualActions(ui.all);

  ui.picker!.props.onChange({provider: 'claude-agent', model: 'haiku', effort: 'high'});
  expect(saveCalls()).toHaveLength(2);
  const second = saveCalls()[1]!;
  expect(second.edit).toMatchObject({scope: {kind: 'host'}, section: 'judge', revision: 'r2', patch: {byProvider: {'claude-agent': {model: 'haiku', effort: 'high'}}}});
  finish(accept(second)); ui = await settle();
  expect(ui.picker!.props.value).toEqual({provider: 'claude-agent', model: 'haiku', effort: 'high'});
  expectNoManualActions(ui.all);
});
it.each(['rejected', 'transport'] as const)('restores the confirmed model after an automatic %s failure and retries the same choice', async failure => {
  let ui = await settle();
  respond = async () => {
    if (failure === 'transport') throw new Error('连接暂不可用');
    return {kind: 'saved', result: {kind: 'rejected', fields: [{field: 'defaultProvider', message: '模型暂不可用'}]}};
  };
  ui.picker!.props.onChange({provider: 'claude-agent', model: 'haiku'});
  expect(saveCalls()).toHaveLength(1);
  ui = await settle();
  expect(ui.picker!.props.value).toEqual({provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'low'});
  expect(ui.picker!.props.disabled).toBe(false);
  expect(ui.all.some(node => node.props.title === '切换未完成')).toBe(true);
  const retry = ui.all.find(node => content(node.props.children) === '重试')!;
  expect(retry).toBeDefined();
  expectNoManualActions(ui.all);
  respond = async request => accept(request);
  retry.props.onClick();
  expect(saveCalls()).toHaveLength(2);
  expect(saveCalls()[1]).toEqual(saveCalls()[0]);
  ui = await settle();
  expect(ui.picker!.props.value).toEqual({provider: 'claude-agent', model: 'haiku'});
  expect(ui.all.some(node => node.props.title === '切换未完成')).toBe(false);
  expectNoManualActions(ui.all);
});
it('automatically saves a shared custom connection on blur and reloads its confirmed values', async () => {
  let ui = await settle();
  const endpoint = () => ui.all.find(node => node.props['aria-label'] === '自定义决策请求地址')!;
  const model = () => ui.all.find(node => node.props['aria-label'] === '自定义接口模型 ID')!;
  expect(endpoint().props.defaultValue).toBe('');
  endpoint().props.onBlur({currentTarget: {value: ' https://example.com/api/judge '}});
  expect(saveCalls()).toHaveLength(1);
  expect(saveCalls()[0]!.edit.patch).toMatchObject({byProvider: {custom: {model: 'jev-latest', endpoint: 'https://example.com/api/judge'}}});
  ui = await settle();
  expect(endpoint().props.defaultValue).toBe('https://example.com/api/judge');
  expect(ui.picker!.props.value.provider).toBe('codex-appserver');
  model().props.onBlur({currentTarget: {value: 'private-system-one'}});
  ui = await settle();
  expect(saveCalls()).toHaveLength(2);
  expect(saveCalls()[1]!.edit.revision).toBe('r2');
  expect(saveCalls()[1]!.edit.patch).toMatchObject({byProvider: {custom: {model: 'private-system-one', endpoint: 'https://example.com/api/judge'}}});
  expectNoManualActions(ui.all);

  confirmed = section({...confirmed.stored, byProvider: {...confirmed.stored.byProvider, custom: {model: 'externally-changed', endpoint: 'https://other.example.com/system-one'}}}, 'r4');
  ui.all.find(node => node.props.label === '重新读取配置与模型')!.props.onClick();
  ui = await settle();
  expect(endpoint().props.defaultValue).toBe('https://other.example.com/system-one');
  expect(model().props.defaultValue).toBe('externally-changed');
});
it('rejects an invalid custom connection without sending a settings write or exposing its URL', async () => {
  let ui = await settle();
  ui.all.find(node => node.props['aria-label'] === '自定义决策请求地址')!.props.onBlur({currentTarget: {value: 'https://user:secret@example.com/judge'}});
  ui = await settle();
  expect(saveCalls()).toHaveLength(0);
  expect(content(ui.all)).toContain('接口地址');
  expect(content(ui.all)).not.toContain('user:secret');
  expect(ui.picker!.props.value.provider).toBe('codex-appserver');
});
it('clears an inactive custom endpoint by removing the optional field rather than saving an invalid empty URL', async () => {
  let ui = await settle();
  const endpoint = () => ui.all.find(node => node.props['aria-label'] === '自定义决策请求地址')!;
  endpoint().props.onBlur({currentTarget: {value: 'https://example.com/judge'}});
  ui = await settle();
  expect(endpoint().props.defaultValue).toBe('https://example.com/judge');
  endpoint().props.onBlur({currentTarget: {value: ''}});
  ui = await settle();
  expect(saveCalls()).toHaveLength(2);
  expect(saveCalls()[1]!.edit.patch.byProvider?.custom).toEqual({model: 'jev-latest'});
  expect(endpoint().props.defaultValue).toBe('');
  expect(ui.picker!.props.value.provider).toBe('codex-appserver');
});
it('keeps the endpoint required while the custom service is the current default', async () => {
  confirmed = section({...initial, defaultProvider: 'custom', byProvider: {...initial.byProvider, custom: {model: 'jev-latest', endpoint: 'https://example.com/judge'}}}, 'r1');
  let ui = await settle();
  ui.all.find(node => node.props['aria-label'] === '自定义决策请求地址')!.props.onBlur({currentTarget: {value: ''}});
  ui = await settle();
  expect(saveCalls()).toHaveLength(0);
  expect(content(ui.all)).toContain('请填写自定义决策接口地址');
  expect(ui.all.find(node => node.props['aria-label'] === '自定义决策请求地址')!.props.defaultValue).toBe('https://example.com/judge');
});
it('keeps custom key management available when host configuration cannot be read', async () => {
  harness.client.settings.mockRejectedValue(new Error('配置读取失败'));
  const page = () => nodes(renderAt('page', () => DecisionProviderSettings({customKeyContent: <span>自定义密钥管理</span>})));
  page();
  for (let tick = 0; tick < 6; tick++) await Promise.resolve();
  const all = page();
  expect(content(all)).toContain('配置读取失败');
  expect(content(all)).toContain('自定义密钥管理');
});
