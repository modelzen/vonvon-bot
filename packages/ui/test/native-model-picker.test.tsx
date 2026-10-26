import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import type {ModelCatalog} from '@vonvon/protocol';
import {Button, SelectControl} from '../src/reference/components/ui';
import {NativeModelPicker, type NativeModelValue} from '../src/settings/NativeModelPicker';

// Invoke the same public event callbacks used by pointer and keyboard selection.
const hooks = vi.hoisted(() => ({state: [] as unknown[], index: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const index = hooks.index++; if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial; return [hooks.state[index], (next: unknown) => {hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next;}];},
  useRef: (initial: unknown) => {const index = hooks.index++; if (!(index in hooks.state)) hooks.state[index] = {current: initial}; return hooks.state[index];},
}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];}
function content(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(content).join(''); return isValidElement<Record<string, any>>(node) ? content(node.props.children) : '';}
const model = (id: string, defaultEffort: 'low' | 'high' = 'low', hidden = false): ModelCatalog['models'][number] => ({id, displayName: id, description: '', hidden, isDefault: false, defaultEffort, supportedEfforts: ['low', 'high']});
const catalog = (backend: string, models: ModelCatalog['models'], state: ModelCatalog['state'] = 'ready'): ModelCatalog => ({backend, state, source: 'backend-provided', observedAt: '2026-10-26T00:00:00Z', titleEfforts: ['low', 'medium', 'high'], models});
const catalogs = {
  'codex-appserver': catalog('codex-appserver', [model('gpt-6-luna'), model('gpt-6.1-sol', 'high'), model('hidden', 'low', true)]),
  'claude-agent': catalog('claude-agent', [model('haiku'), model('sonnet', 'high')]),
};
const changed = vi.fn(); const retry = vi.fn();
let props: Parameters<typeof NativeModelPicker>[0];
function render() {hooks.index = 0; return nodes(NativeModelPicker(props));}
const root = () => render().find(node => node.type === Combobox.Root)!;
const key = (backend: string, model?: string) => JSON.stringify([backend, model ?? null]);
const item = (backend: string, model?: string) => render().find(node => node.type === Combobox.Item && node.props.value === key(backend, model));
const field = (label: string) => render().find(node => node.type === SelectControl && node.props.label === label)!;
const button = (text: string) => render().find(node => node.type === Button && content(node) === text)!;
const trigger = () => render().find(node => node.type === Combobox.Trigger)!;
beforeEach(() => {
  hooks.state = []; hooks.index = 0; changed.mockReset(); retry.mockReset();
  props = {label: '标题模型', value: {backend: 'codex-appserver', selection: {kind: 'explicit', model: 'gpt-6-luna', effort: 'high'}}, catalogs, onChange: changed, onRetry: retry};
  changed.mockImplementation((value: NativeModelValue) => {props.value = value;});
});

it('selects provider and model together using that model’s default effort', () => {
  root().props.onValueChange(key('claude-agent', 'sonnet'));
  expect(changed).toHaveBeenLastCalledWith({backend: 'claude-agent', selection: {kind: 'explicit', model: 'sonnet', effort: 'high'}});
  root().props.onValueChange(key('codex-appserver', 'gpt-6-luna'));
  expect(changed).toHaveBeenLastCalledWith({backend: 'codex-appserver', selection: {kind: 'explicit', model: 'gpt-6-luna', effort: 'low'}});
  expect(trigger().props['aria-label']).toBe('选择标题模型');
  expect(render().find(node => node.type === Combobox.Input)?.props['aria-label']).toBe('搜索标题模型');
  expect(render().find(node => node.type === Combobox.Popup)?.props['aria-label']).toBe('标题模型列表');
  expect(render().filter(node => node.type === 'label').map(content)).toContain('模型');
});
it('preserves a saved effort on reselect and accepts only supported effort changes', () => {
  root().props.onValueChange(key('codex-appserver', 'gpt-6-luna'));
  expect(changed).not.toHaveBeenCalled();
  field('标题模型思考强度').props.onChange('ultra');
  field('标题模型思考强度').props.onChange('');
  expect(changed).not.toHaveBeenCalled();
  field('标题模型思考强度').props.onChange('low');
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'codex-appserver', selection: {kind: 'explicit', model: 'gpt-6-luna', effort: 'low'}});
});
it('offers a default per provider and clearly describes its inheritance without persisting the effective value', () => {
  props.label = '评论模型'; props.allowDefault = true;
  props.inherited = {backend: 'claude-agent', selection: {kind: 'explicit', model: 'haiku', effort: 'low'}};
  root().props.onValueChange(key('claude-agent'));
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'claude-agent', selection: {kind: 'default'}});
  expect(content(trigger())).toContain('使用 Bot 默认模型');
  expect(content(render())).toContain('当前使用 Claude · haiku · low，随 Bot 默认模型设置更新');
  expect(render().some(node => node.type === SelectControl && node.props.label === '评论模型思考强度')).toBe(false);
  expect(item('codex-appserver')).toBeDefined();
  expect(item('claude-agent')).toBeDefined();
  expect(render().some(node => node.type === Button && content(node) === '自定义模型 ID')).toBe(false);
});
it('keeps the title empty until a model is selected, without exposing a default option', () => {
  props.value = {backend: 'codex-appserver', selection: {kind: 'default'}};
  expect(root().props.value).toBeNull(); expect(content(trigger())).toContain('选择模型');
  expect(item('codex-appserver')).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
});
it('filters provider and model names and reports empty search results without changing settings', () => {
  root().props.onInputValueChange('Claude');
  expect(root().props.filteredItems).toEqual([key('claude-agent', 'haiku'), key('claude-agent', 'sonnet')]);
  root().props.onInputValueChange('no model');
  expect(root().props.filteredItems).toEqual([]);
  expect(content(render())).toContain('没有匹配的模型'); expect(changed).not.toHaveBeenCalled();
});
it.each(['retired', 'hidden'])('retains the saved %s model without allowing it to be selected or rewritten', id => {
  props.value = {backend: 'codex-appserver', selection: {kind: 'explicit', model: id, effort: 'ultra'}};
  expect(content(trigger())).toContain(id);
  expect(content(item('codex-appserver', id))).toContain('已保存，当前目录未列出');
  expect(item('codex-appserver', id)?.props.disabled).toBe(true);
  expect(field('标题模型思考强度').props).toMatchObject({value: 'ultra', disabled: true});
  root().props.onValueChange(key('codex-appserver', id));
  field('标题模型思考强度').props.onChange('low'); expect(changed).not.toHaveBeenCalled();
});
it('keeps default available while a catalog loads or fails, but blocks stale model and effort callbacks', () => {
  props.allowDefault = true; props.catalogs = {...catalogs, 'codex-appserver': {...catalogs['codex-appserver'], state: 'unavailable', error: '读取失败'}};
  expect(item('codex-appserver', 'gpt-6.1-sol')?.props.disabled).toBe(true);
  root().props.onValueChange(key('codex-appserver', 'gpt-6.1-sol'));
  field('标题模型思考强度').props.onChange('low');
  expect(content(render())).toContain('读取失败'); expect(changed).not.toHaveBeenCalled();
  button('重新读取模型').props.onClick(); expect(retry).toHaveBeenCalledOnce();
  props.catalogs = {};
  expect(content(render())).toContain('正在读取模型');
  root().props.onValueChange(key('claude-agent'));
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'claude-agent', selection: {kind: 'default'}});
});
it('permits fallback catalogs and ignores catalogs returned for a different backend', () => {
  props.catalogs = {...catalogs, 'claude-agent': {...catalogs['claude-agent'], state: 'fallback'}};
  root().props.onValueChange(key('claude-agent', 'haiku'));
  expect(changed).toHaveBeenCalledOnce(); changed.mockClear();
  props.catalogs = {'claude-agent': catalogs['codex-appserver']};
  expect(item('claude-agent', 'gpt-6-luna')).toBeUndefined();
  root().props.onValueChange(key('claude-agent', 'gpt-6-luna')); expect(changed).not.toHaveBeenCalled();
});
it('limits the picker and custom provider to the requested backend', () => {
  props.providerIds = ['claude-agent']; props.allowCustom = true;
  expect(item('codex-appserver', 'gpt-6.1-sol')).toBeUndefined();
  root().props.onValueChange(key('codex-appserver', 'gpt-6.1-sol'));
  expect(changed).not.toHaveBeenCalled();
  button('自定义模型 ID').props.onClick();
  expect(render().some(node => node.type === SelectControl && node.props.label === '自定义标题模型 Provider')).toBe(false);
  expect(field('自定义标题模型思考强度').props.value).toBe('medium');
});
it('edits a custom draft, cancels without change, and rejects an empty ID', () => {
  props.allowCustom = true; props.value = {backend: 'codex-appserver', selection: {kind: 'default'}};
  button('自定义模型 ID').props.onClick();
  expect(button('使用').props.disabled).toBe(true);
  button('使用').props.onClick(); expect(changed).not.toHaveBeenCalled();
  render().find(node => node.type === 'input')!.props.onChange({target: {value: 'gateway/custom'}});
  button('取消').props.onClick(); expect(changed).not.toHaveBeenCalled();
  expect(render().some(node => node.type === 'input')).toBe(false);
  button('自定义模型 ID').props.onClick();
  render().find(node => node.type === 'input')!.props.onChange({target: {value: '  gateway/custom  '}});
  field('自定义标题模型 Provider').props.onChange('claude-agent');
  field('自定义标题模型思考强度').props.onChange('high');
  button('使用').props.onClick();
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'claude-agent', selection: {kind: 'explicit', model: 'gateway/custom', effort: 'high', custom: true}});
});
it('offers the full protocol effort range for custom IDs when discovery is unavailable', () => {
  props.allowCustom = true; props.catalogs = {};
  button('自定义模型 ID').props.onClick();
  expect(field('自定义标题模型思考强度').props.options.map((option: {value: string}) => option.value)).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  field('自定义标题模型 Provider').props.onChange('claude-agent');
  expect(field('自定义标题模型思考强度').props.options.map((option: {value: string}) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  field('自定义标题模型思考强度').props.onChange('none');
  expect(field('自定义标题模型思考强度').props.value).toBe('medium');
  props.value = {backend: 'claude-agent', selection: {kind: 'explicit', model: 'custom', custom: true, effort: 'max'}};
  field('标题模型思考强度').props.onChange('xhigh');
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'claude-agent', selection: {kind: 'explicit', model: 'custom', custom: true, effort: 'xhigh'}});
});
it('readonly blocks model, effort, retry, and custom apply callbacks', () => {
  props.allowCustom = true; button('自定义模型 ID').props.onClick(); props.disabled = true;
  expect(trigger().props.disabled).toBe(true);
  root().props.onValueChange(key('claude-agent', 'haiku'));
  field('标题模型思考强度').props.onChange('low');
  field('自定义标题模型 Provider').props.onChange('claude-agent');
  field('自定义标题模型思考强度').props.onChange('high');
  button('使用').props.onClick(); button('重新读取模型').props.onClick();
  expect(changed).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
});
it('labels a custom saved ID truthfully and manages focus throughout the custom flow', () => {
  props.allowCustom = true;
  props.value = {backend: 'codex-appserver', selection: {kind: 'explicit', model: 'gateway/custom', effort: 'high', custom: true}};
  expect(content(trigger())).toContain('自定义模型');
  expect(content(trigger())).not.toContain('当前目录未列出');
  const focus = vi.fn();
  trigger().props.ref.current = {focus};
  button('自定义模型 ID').props.onClick();
  const input = render().find(node => node.type === 'input')!;
  expect(input.props.autoFocus).toBe(true);
  const inputTarget = {focus: vi.fn()};
  input.props.ref.current = inputTarget;
  expect(render().find(node => node.type === Combobox.Popup)!.props.finalFocus()).toBe(inputTarget);
  button('取消').props.onClick();
  expect(focus).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
  input.props.ref.current = null;
  expect(render().find(node => node.type === Combobox.Popup)!.props.finalFocus()).toEqual({focus});
  button('自定义模型 ID').props.onClick();
  button('使用').props.onClick();
  expect(focus).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledOnce();
});
