import {expect, it, vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ModelCatalog} from '@vonvon/protocol';
import {SpeedChoice, SpeedEditor} from '../src/settings/SettingsPanel';

const section = (stored: 'inherit' | 'standard' | 'fast' | 'ultrafast', effective = stored) => ({
  stored: {tier: stored}, effective: {tier: effective}, revision: 'r1', access: {kind: 'writable' as const}, apply: [],
});
const catalog: ModelCatalog = {backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: '2026-10-29T00:00:00Z', titleEfforts: [], models: [
  {id: 'standard-model', displayName: 'Standard model', description: '', supportedEfforts: [], defaultEffort: 'none', isDefault: true, hidden: false, serviceTiers: [{id: 'standard', name: 'Standard', description: ''}, {id: 'fast', name: 'Fast', description: ''}]},
  {id: 'full-model', displayName: 'Full model', description: '', supportedEfforts: [], defaultEffort: 'none', isDefault: false, hidden: false, serviceTiers: [{id: 'standard', name: 'Standard', description: ''}, {id: 'fast', name: 'Fast', description: ''}, {id: 'ultrafast', name: 'Ultrafast', description: ''}]},
]};
const show = (value = section('inherit'), source: ModelCatalog | undefined = catalog, model = 'standard-model', scope: 'project' | 'session' = 'project') =>
  renderToStaticMarkup(createElement(SpeedChoice, {section: value, catalog: source, selection: {kind: 'explicit', model, effort: 'none'}, scope, disabled: false, onChange: () => {}}));

it('uses the live model catalog and keeps unsupported saved tiers visible', () => {
  const normal = show();
  expect(normal).toContain('aria-label="群默认响应速度"');
  expect(normal).toContain('<option value="fast">Fast 快速</option>');
  expect(normal).toContain('<option value="ultrafast" disabled="">Ultrafast 极速</option>');
  expect(show(section('ultrafast'))).toContain('Ultrafast 极速（当前模型不支持，已保存）');
  expect(show(section('inherit'), catalog, 'full-model')).toContain('<option value="ultrafast">Ultrafast 极速</option>');
  const missing = show(section('fast'), {...catalog, state: 'unavailable', models: []});
  expect(missing).toContain('<select aria-label="群默认响应速度">');
  expect(missing).toContain('<option value="standard">Standard 普通</option>');
  expect(missing).toContain('<option value="inherit">使用 Codex 默认速度</option>');
  expect(missing).toContain('可切换普通或继承；读取目录后可选加速');
  expect(missing).toContain('Fast 快速（当前模型不支持，已保存）');
});

it('shows inherited effective speed and keeps the choice independent of model and effort', () => {
  const html = show(section('inherit', 'fast'), catalog, 'standard-model', 'session');
  expect(html).toContain('aria-label="话题响应速度"');
  expect(html).toContain('跟随群设置（Fast 快速）');
  expect(html).toContain('加速档位消耗更多额度；下一次发起任务生效，当前任务不变');
  expect(html).not.toContain('推理强度');
  const override = show(section('ultrafast', 'ultrafast'), catalog, 'full-model', 'session');
  expect(override).toContain('<option value="inherit">跟随群设置</option>');
  expect(override).not.toContain('跟随群设置（Ultrafast 极速）');
});

it.each(['project', 'session'] as const)('submits a sparse speed patch for %s', scope => {
  const save = vi.fn(async () => ({kind: 'refused' as const, message: 'test'}));
  const editor = SpeedEditor({section: section('inherit'), catalog, selection: {kind: 'default'}, scope, save});
  const commit = vi.fn();
  const choice = editor.props.render({tier: 'inherit'}, vi.fn(), false, commit);
  choice.props.onChange('fast');
  expect(commit).toHaveBeenCalledWith({tier: 'fast'});
  editor.props.save({tier: 'fast'}, 'r1');
  expect(save).toHaveBeenCalledWith({tier: 'fast'}, 'r1');
});
