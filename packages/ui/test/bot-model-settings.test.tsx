import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {AgentSettingsView, ModelCatalog} from '@vonvon/protocol';
import {BotCommentSettings, BotTitleSettings, CommentRulesEditor, TitleProviderFields} from '../src/settings/BotModelSettings';
import {Editor} from '../src/settings/SettingsPanel';
import {NativeModelPicker} from '../src/settings/NativeModelPicker';
import {Toggle} from '../src/reference/components/ui';

type Effect = {deps?: unknown[]; cleanup?: () => void};
type Bank = {state: unknown[]; refs: Array<{current: unknown}>; effects: Effect[]};
const h = vi.hoisted(() => ({banks: {} as Record<string, Bank>, key: '', si: 0, ri: 0, ei: 0, pending: [] as Array<() => void>, client: {settings: vi.fn()}, drafts: new Map<string, any>()}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const bank = h.banks[h.key]!; const i = h.si++; if (!(i in bank.state)) bank.state[i] = typeof initial === 'function' ? initial() : initial; return [bank.state[i], (next: unknown) => {bank.state[i] = typeof next === 'function' ? next(bank.state[i]) : next;}];},
  useRef: (initial: unknown) => h.banks[h.key]!.refs[h.ri++] ??= {current: initial},
  useContext: () => [],
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const bank = h.banks[h.key]!; const i = h.ei++; const old = bank.effects[i]; if (old?.deps && deps && old.deps.length === deps.length && deps.every((value, index) => Object.is(value, old.deps![index]))) return; h.pending.push(() => {old?.cleanup?.(); bank.effects[i] = {deps, cleanup: effect() || undefined};});},
}));
vi.mock('../src/client-context', () => ({useClient: () => h.client}));
vi.mock('../src/settings/useBotModelCatalogs', () => ({useBotModelCatalogs: () => ({catalogs: {}, refresh: vi.fn()})}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: (active: boolean, draft: any) => {if (active) h.drafts.set(h.key, draft); else h.drafts.delete(h.key);}}));

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.trailing)] : [];}
function at<T>(key: string, render: () => T): T {h.key = key; h.banks[key] ??= {state: [], refs: [], effects: []}; h.si = h.ri = h.ei = 0; const result = render(); for (const effect of h.pending.splice(0)) effect(); return result;}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const codex = 'codex-appserver'; const claude = 'claude-agent';
const policy = {enabled: true as const, model: 'title-model', effort: 'high' as const};
function fixture(text = 'Original rule', revision = 'rules-1'): AgentSettingsView {
  const titles = {byBackend: {[codex]: policy, [claude]: {enabled: false as const}}};
  const comments = {backend: codex, selection: {kind: 'default' as const}};
  const section = <T,>(stored: T) => ({stored, effective: stored, revision: 'settings-1', access: {kind: 'writable'}, apply: []});
  return {scope: {kind: 'agent', botId: 'cli_test'}, sections: {titles: section(titles), comments: section(comments), cards: section({})}, commentInstructions: {revision, maxEditLength: 30000, content: {kind: 'custom', text}}} as unknown as AgentSettingsView;
}
const catalog: ModelCatalog = {backend: codex, state: 'ready', source: 'backend-provided', observedAt: 1, titleEfforts: ['low', 'high'], models: [{id: 'default-model', displayName: 'Default model', description: '', isDefault: true, hidden: false, defaultEffort: 'low', supportedEfforts: ['low', 'high']}]};
beforeEach(() => {h.banks = {}; h.pending = []; h.drafts.clear(); vi.clearAllMocks();});

it('saves exactly one independent title Provider per Editor', async () => {
  const view = fixture(); const save = vi.fn();
  const editors = at('titles', () => nodes(BotTitleSettings({view, save}))).filter(node => node.type === Editor);
  expect(editors.map(editor => editor.props.title)).toEqual(['Codex 会话标题', 'Claude 会话标题']);
  expect(editors.every(editor => editor.props.autoSave)).toBe(true);
  await editors[0]!.props.save({byBackend: {[codex]: {enabled: false}, [claude]: policy}}, 'revision-codex');
  await editors[1]!.props.save({byBackend: {[codex]: {enabled: false}, [claude]: policy}}, 'revision-claude');
  expect(save.mock.calls).toEqual([['titles', {byBackend: {[codex]: {enabled: false}}}, 'revision-codex'], ['titles', {byBackend: {[claude]: policy}}, 'revision-claude']]);
});

it('title switches emit valid policies, remember a choice, and strip custom metadata', () => {
  const changed = vi.fn(); let current: any = policy;
  const render = () => at('title-fields', () => nodes(TitleProviderFields({provider: {id: codex, name: 'Codex'}, policy: current, catalog, disabled: false, onChange: changed, onRetry: vi.fn()})));
  changed.mockImplementation(next => {current = next;});
  render().find(node => node.type === Toggle)!.props.onChange({target: {checked: false}});
  expect(changed).toHaveBeenLastCalledWith({enabled: false});
  render().find(node => node.type === Toggle)!.props.onChange({target: {checked: true}});
  expect(changed).toHaveBeenLastCalledWith(policy);
  render().find(node => node.type === NativeModelPicker)!.props.onChange({backend: codex, selection: {kind: 'explicit', model: 'gateway/title', effort: 'high', custom: true}});
  expect(changed).toHaveBeenLastCalledWith({enabled: true, model: 'gateway/title', effort: 'high'});
  render().find(node => node.type === NativeModelPicker)!.props.onChange({backend: claude, selection: {kind: 'explicit', model: 'wrong-provider', effort: 'low'}});
  expect(changed).toHaveBeenCalledTimes(3);
});

it('enables titles with a complete catalog default and blocks readonly callbacks', () => {
  const changed = vi.fn(); const props = {provider: {id: codex, name: 'Codex'}, policy: {enabled: false as const}, catalog, disabled: false, onChange: changed, onRetry: vi.fn()};
  let ui = at('initial-title', () => nodes(TitleProviderFields(props)));
  ui.find(node => node.type === Toggle)!.props.onChange({target: {checked: true}});
  expect(changed).toHaveBeenLastCalledWith({enabled: true, model: 'default-model', effort: 'low'});
  changed.mockClear(); ui = at('readonly-title', () => nodes(TitleProviderFields({...props, disabled: true})));
  expect(ui.find(node => node.type === Toggle)!.props.disabled).toBe(true);
  expect(ui.find(node => node.type === NativeModelPicker)!.props.disabled).toBe(true);
  ui.find(node => node.type === Toggle)!.props.onChange({target: {checked: true}});
  ui.find(node => node.type === NativeModelPicker)!.props.onChange({backend: codex, selection: {kind: 'explicit', model: 'x', effort: 'low'}});
  expect(changed).not.toHaveBeenCalled();
});

it('leaves an unconfigured title disabled when discovery fails but allows a complete custom choice', () => {
  const changed = vi.fn();
  const ui = at('unavailable-title', () => nodes(TitleProviderFields({provider: {id: claude, name: 'Claude'}, policy: {enabled: false}, disabled: false,
    catalog: {...catalog, backend: claude, state: 'unavailable', models: []}, onChange: changed, onRetry: vi.fn()})));
  expect(ui.find(node => node.type === Toggle)!.props.disabled).toBe(true);
  expect(ui.find(node => node.type === NativeModelPicker)!.props.disabled).toBe(false);
  ui.find(node => node.type === NativeModelPicker)!.props.onChange({backend: claude, selection: {kind: 'explicit', model: 'gateway/claude', effort: 'xhigh', custom: true}});
  expect(changed).toHaveBeenCalledExactlyOnceWith({enabled: true, model: 'gateway/claude', effort: 'xhigh'});
});

it('keeps inherited comment backend when changing a model and atomically saves a cross-Provider selection', async () => {
  const view = fixture(); const save = vi.fn().mockResolvedValue({kind: 'refused', message: 'fixture failure'});
  const render = () => {
    const editor = at('comments', () => nodes(BotCommentSettings({view, save, refresh: vi.fn()}))).find(node => node.type === Editor)!;
    const ui = at('comment-editor', () => nodes(Editor(editor.props as any)));
    return ui.find(node => node.type === NativeModelPicker)!;
  };
  render().props.onChange({backend: codex, selection: {kind: 'explicit', model: 'codex-model', effort: 'low'}}); await flush();
  expect(save).toHaveBeenLastCalledWith('comments', {selection: {kind: 'explicit', model: 'codex-model', effort: 'low'}}, 'settings-1');
  render().props.onChange({backend: claude, selection: {kind: 'explicit', model: 'sonnet', effort: 'high'}}); await flush();
  expect(save).toHaveBeenLastCalledWith('comments', {backend: claude, selection: {kind: 'explicit', model: 'sonnet', effort: 'high'}}, 'settings-1');
});

function ruleHarness(initial = fixture()) {
  let view = initial; const refresh = vi.fn(async () => {});
  const render = () => at('rules', () => nodes(CommentRulesEditor({view, refresh})));
  return {refresh, render, update: (next: AgentSettingsView) => {view = next;}, edit: (text: string) => render().find(node => node.type === 'textarea')!.props.onChange({target: {value: text}}),
    button: (label: string) => render().find(node => node.props.children === label && node.props.onClick)!, text: () => render().find(node => node.type === 'textarea')!.props.value};
}
function savedRules(text: string, kind = 'custom', revision = 'rules-2') {const view = fixture(text, revision); (view.commentInstructions.content as any).kind = kind; return {kind: 'acted', result: {kind: 'saved', view, effects: [], warnings: []}};}

it('rejects empty and over-limit rules through both button and navigation save', async () => {
  const ui = ruleHarness();
  for (const text of ['   ', 'a'.repeat(30001)]) {
    ui.edit(text); expect(ui.button('保存规则').props.disabled).toBe(true);
    expect(await h.drafts.get('rules').save()).toBe(false);
  }
  expect(h.client.settings).not.toHaveBeenCalled();
  ui.edit('a'.repeat(30000)); expect(ui.button('保存规则').props.disabled).toBe(false);
});

it('guards duplicate pending saves and retains a failed rule draft for retry', async () => {
  const pending = deferred<unknown>(); h.client.settings.mockReturnValueOnce(pending.promise);
  const ui = ruleHarness(); ui.edit('Edited rule'); const button = ui.button('保存规则'); button.props.onClick(); button.props.onClick();
  expect(h.client.settings).toHaveBeenCalledTimes(1);
  expect(ui.button('保存规则').props.disabled).toBe(true);
  expect(ui.render().find(node => node.type === 'textarea')!.props.disabled).toBe(true);
  pending.reject(new Error('network unavailable')); await flush();
  expect(ui.text()).toBe('Edited rule'); expect(ui.button('保存规则').props.disabled).toBe(false);
  expect(ui.render().find(node => node.props.title === '规则保存未完成')?.props.children).toBe('network unavailable');
});

it.each([
  [{kind: 'refused', message: 'Bot unavailable'}, 'Bot unavailable'],
  [{kind: 'acted', result: {kind: 'rejected', fields: [{field: 'content', message: 'Rule rejected'}]}}, 'content：Rule rejected'],
  [{kind: 'acted', result: {kind: 'conflict'}}, '规则已在别处更改，当前草稿已保留。请重新读取后确认。'],
])('keeps a rule draft after a server refusal %#', async (reply, message) => {
  h.client.settings.mockResolvedValue(reply);
  const ui = ruleHarness(); ui.edit('Keep this rule'); ui.button('保存规则').props.onClick(); await flush();
  expect(ui.text()).toBe('Keep this rule');
  expect(ui.render().find(node => node.props.title === '规则保存未完成')?.props.children).toBe(message);
  expect(ui.refresh).not.toHaveBeenCalled();
});

it('keeps canonical saved rules while refresh still shows the previous revision', async () => {
  h.client.settings.mockResolvedValue(savedRules('Canonical rule'));
  const ui = ruleHarness(); ui.edit('Edited rule'); ui.button('保存规则').props.onClick(); await flush();
  expect(ui.text()).toBe('Canonical rule');
  expect(ui.text()).toBe('Canonical rule');
  expect(ui.refresh).toHaveBeenCalledOnce();
});

it('restores the canonical default returned by the server', async () => {
  const response = savedRules('Default instructions', 'default'); h.client.settings.mockResolvedValue(response);
  const ui = ruleHarness(); ui.refresh.mockImplementation(async () => {ui.update(response.result.view);});
  ui.button('恢复默认').props.onClick(); await flush();
  expect(h.client.settings).toHaveBeenCalledWith({type: 'act', action: {kind: 'commentInstructions', botId: 'cli_test', revision: 'rules-1', content: {kind: 'default'}}});
  expect(ui.text()).toBe('Default instructions'); expect(ui.button('恢复默认').props.disabled).toBe(true);
});

it('keeps a confirmed canonical rule even if refreshing the rest of settings fails', async () => {
  h.client.settings.mockResolvedValue(savedRules('Already persisted'));
  const ui = ruleHarness(); ui.refresh.mockRejectedValue(new Error('refresh failed'));
  ui.edit('Submitted rule'); ui.button('保存规则').props.onClick(); await flush();
  expect(ui.text()).toBe('Already persisted'); expect(ui.text()).toBe('Already persisted');
  expect(h.client.settings).toHaveBeenCalledTimes(1);
});

it('retains drafts across external revisions and explicitly reloads the latest rule', async () => {
  const ui = ruleHarness(); ui.edit('Local draft'); ui.update(fixture('Remote edit', 'rules-2'));
  expect(ui.text()).toBe('Local draft'); expect(ui.button('保存规则').props.disabled).toBe(true);
  expect(ui.render().find(node => node.props.title === '规则已在别处更改')).toBeDefined();
  expect(await h.drafts.get('rules').save()).toBe(false); expect(h.client.settings).not.toHaveBeenCalled();
  ui.button('重新读取并放弃草稿').props.onClick(); expect(ui.text()).toBe('Remote edit');
});

it('updates a clean rule from an external revision and prevents readonly saves', async () => {
  const ui = ruleHarness(); ui.render(); ui.update(fixture('Remote edit', 'rules-2')); ui.render(); expect(ui.text()).toBe('Remote edit');
  const readonly = fixture(); readonly.sections.cards.access = {kind: 'readonly', message: 'Read only'};
  ui.update(readonly); expect(ui.render().find(node => node.type === 'textarea')!.props.disabled).toBe(true);
  ui.button('恢复默认').props.onClick(); await flush(); expect(h.client.settings).not.toHaveBeenCalled();
});
