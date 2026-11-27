import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {AgentSettingsView, GlobalTitlePolicy, ModelCatalog} from '@vonvon/protocol';
import {BotCommentSettings, BotTitleSettings, CommentRulesEditor, TitleFields} from '../src/settings/BotModelSettings';
import {Editor} from '../src/settings/SettingsPanel';
import {NativeModelPicker} from '../src/settings/NativeModelPicker';
import {WelcomeCardSettings} from '../src/settings/WelcomeCardSettings';
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
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.trailing), ...nodes(node.props.action)] : [];}
function at<T>(key: string, render: () => T): T {h.key = key; h.banks[key] ??= {state: [], refs: [], effects: []}; h.si = h.ri = h.ei = 0; const result = render(); for (const effect of h.pending.splice(0)) effect(); return result;}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const codex = 'codex-appserver'; const claude = 'claude-agent';
const policy = {enabled: true as const, backend: codex, model: 'title-model', effort: 'high' as const};
function fixture(text = 'Original rule', revision = 'rules-1'): AgentSettingsView {
  const titles = {policy};
  const comments = {backend: codex, selection: {kind: 'default' as const}};
  const section = <T,>(stored: T) => ({stored, effective: stored, revision: 'settings-1', access: {kind: 'writable'}, apply: []});
  return {scope: {kind: 'agent', botId: 'cli_test'}, sections: {titles: section(titles), comments: section(comments), completion: section({mode:'failures',longTaskMinutes:3})}, commentInstructions: {revision, maxEditLength: 30000, content: {kind: 'custom', text}}} as unknown as AgentSettingsView;
}
const catalog: ModelCatalog = {backend: codex, state: 'ready', source: 'backend-provided', observedAt: 1, titleEfforts: ['low', 'high'], models: [{id: 'default-model', displayName: 'Default model', description: '', isDefault: true, hidden: false, defaultEffort: 'low', supportedEfforts: ['low', 'high']}]};
beforeEach(() => {h.banks = {}; h.pending = []; h.drafts.clear(); vi.clearAllMocks();});

it('edits and saves the Bot onboarding welcome copy as one section', async () => {
  const section = {
    stored: {title: '', intro: ''},
    effective: {title: '🤖 本群使用说明', intro: '👋 **默认欢迎语**'},
    revision: 'welcome-1',
    access: {kind: 'writable' as const},
    apply: [],
  };
  const save = vi.fn().mockResolvedValue({kind: 'refused', message: 'fixture failure'});
  const host = at('welcome-host', () => nodes(WelcomeCardSettings({section, save}))).find(node => node.type === Editor)!;
  let ui = at('welcome-editor', () => nodes(Editor(host.props as any)));
  const input = ui.find(node => node.type === 'input')!;
  expect(input.props.placeholder).toBe('🤖 本群使用说明');
  input.props.onChange({target: {value: '项目群指南'}});
  ui = at('welcome-editor', () => nodes(Editor(host.props as any)));
  const textarea = ui.find(node => node.type === 'textarea')!;
  expect(textarea.props.placeholder).toBe('👋 **默认欢迎语**');
  textarea.props.onChange({target: {value: '欢迎加入。'}});
  expect(await h.drafts.get('welcome-editor').save()).toBe(false);
  expect(save).toHaveBeenCalledWith({title: '项目群指南'}, 'welcome-1');
});

it('saves one global title policy through one automatic Editor', async () => {
  const view = fixture(); const save = vi.fn().mockResolvedValue({kind: 'refused', message: 'fixture failure'});
  const editors = at('titles', () => nodes(BotTitleSettings({view, save}))).filter(node => node.type === Editor);
  expect(editors).toHaveLength(1); expect(editors[0]!.props.autoSave).toBe(true);
  const editor = () => at('global-title-editor', () => nodes(Editor(editors[0]!.props as any))).find(node => node.type === TitleFields)!;
  const next = {enabled: true, backend: claude, model: 'sonnet', effort: 'high'};
  editor().props.onChange(next); await flush();
  expect(save).toHaveBeenCalledExactlyOnceWith('titles', {policy: next}, 'settings-1');
  expect(save.mock.calls[0]![1]).not.toHaveProperty('byBackend');
});

it('hides the title picker when disabled and remembers the last global model on reenable', () => {
  const changed = vi.fn(); let current: GlobalTitlePolicy = policy;
  const render = () => at('title-fields', () => nodes(TitleFields({policy: current, catalogs: {[codex]: catalog}, disabled: false, onChange: changed, onRetry: vi.fn()})));
  changed.mockImplementation(next => {current = next;});
  expect(render().find(node => node.type === NativeModelPicker)).toBeDefined();
  render().find(node => node.type === Toggle)!.props.onChange({target: {checked: false}});
  expect(changed).toHaveBeenLastCalledWith({enabled: false});
  expect(render().find(node => node.type === NativeModelPicker)).toBeUndefined();
  render().find(node => node.type === Toggle)!.props.onChange({target: {checked: true}});
  expect(changed).toHaveBeenLastCalledWith(policy);
});

it('switches title Provider and model atomically and strips custom metadata', () => {
  const changed = vi.fn();
  const ui = at('global-provider', () => nodes(TitleFields({policy, catalogs: {[codex]: catalog}, disabled: false, onChange: changed, onRetry: vi.fn()})));
  const picker = ui.find(node => node.type === NativeModelPicker)!;
  expect(picker.props.providerIds).toBeUndefined();
  picker.props.onChange({backend: claude, selection: {kind: 'explicit', model: 'gateway/claude', effort: 'xhigh', custom: true}});
  expect(changed).toHaveBeenCalledExactlyOnceWith({enabled: true, backend: claude, model: 'gateway/claude', effort: 'xhigh'});
  picker.props.onChange({backend: claude, selection: {kind: 'default'}});
  expect(changed).toHaveBeenCalledTimes(1);
});

it('enables a complete Codex default first and uses Claude if only that catalog is available', () => {
  const changed = vi.fn(); const claudeCatalog = {...catalog, backend: claude};
  for (const [key, catalogs, expectedBackend] of [['both', {[codex]: catalog, [claude]: claudeCatalog}, codex], ['claude', {[claude]: claudeCatalog}, claude]] as const) {
    const ui = at(key, () => nodes(TitleFields({policy: {enabled: false}, catalogs, disabled: false, onChange: changed, onRetry: vi.fn()})));
    expect(ui.find(node => node.type === NativeModelPicker)).toBeUndefined();
    ui.find(node => node.type === Toggle)!.props.onChange({target: {checked: true}});
    expect(changed).toHaveBeenLastCalledWith({enabled: true, backend: expectedBackend, model: 'default-model', effort: 'low'});
  }
});

it('keeps title model callbacks readonly', () => {
  const changed = vi.fn();
  const ui = at('readonly-title', () => nodes(TitleFields({policy, catalogs: {[codex]: catalog}, disabled: true, onChange: changed, onRetry: vi.fn()})));
  expect(ui.find(node => node.type === Toggle)!.props.disabled).toBe(true);
  expect(ui.find(node => node.type === NativeModelPicker)!.props.disabled).toBe(true);
  ui.find(node => node.type === Toggle)!.props.onChange({target: {checked: false}});
  ui.find(node => node.type === NativeModelPicker)!.props.onChange({backend: claude, selection: {kind: 'explicit', model: 'x', effort: 'low'}});
  expect(changed).not.toHaveBeenCalled();
});

it('opens an unsaved title choice when discovery fails and saves only a complete custom choice', () => {
  const changed = vi.fn(); let current: GlobalTitlePolicy = {enabled: false};
  const render = () => at('unavailable-title', () => nodes(TitleFields({policy: current, catalogs: {}, disabled: false, onChange: changed, onRetry: vi.fn()})));
  changed.mockImplementation(next => {current = next;});
  render().find(node => node.type === Toggle)!.props.onChange({target: {checked: true}});
  expect(changed).not.toHaveBeenCalled();
  let ui = render(); expect(ui.find(node => node.type === Toggle)!.props.checked).toBe(true);
  expect(ui.find(node => node.type === NativeModelPicker)!.props.allowCustom).toBe(true);
  ui.find(node => node.type === Toggle)!.props.onChange({target: {checked: false}});
  expect(render().find(node => node.type === NativeModelPicker)).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
  render().find(node => node.type === Toggle)!.props.onChange({target: {checked: true}}); ui = render();
  ui.find(node => node.type === NativeModelPicker)!.props.onChange({backend: claude, selection: {kind: 'explicit', model: 'gateway/claude', effort: 'xhigh', custom: true}});
  expect(changed).toHaveBeenCalledExactlyOnceWith({enabled: true, backend: claude, model: 'gateway/claude', effort: 'xhigh'});
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
  const readonly = fixture(); readonly.sections.completion.access = {kind: 'readonly', message: 'Read only'};
  ui.update(readonly); expect(ui.render().find(node => node.type === 'textarea')!.props.disabled).toBe(true);
  ui.button('恢复默认').props.onClick(); await flush(); expect(h.client.settings).not.toHaveBeenCalled();
});
