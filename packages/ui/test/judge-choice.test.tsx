import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DecisionModelsView, JudgeSelectionView, ModelCatalog} from '@vonvon/protocol';
import {JudgeModelChoice} from '../src/settings/JudgeModelChoice';
import {judgeChoiceOptions, judgeEffortChoices, judgeKeyNotice, judgeLabel} from '../src/settings/judgeChoice';
import {MEANWHILE} from '../src/management/secretsModel';

const catalog = (patch: Partial<ModelCatalog> = {}): ModelCatalog => ({
  backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: '2026-10-19T00:00:00Z', titleEfforts: ['low', 'high'],
  models: ['gpt-6-luna', 'gpt-6'].map((id, index) => ({id, displayName: id, description: '', supportedEfforts: ['low', 'high'], defaultEffort: 'low', isDefault: index === 0, hidden: index === 1})), ...patch,
});
const decisions = (patch: Partial<DecisionModelsView[number]> = {}): DecisionModelsView => [{provider: 'typesafe', displayName: 'TypeSafe', models: [{id: 'jev-latest', displayName: 'Jev'}], keyId: 'typesafe-api-key', keySet: false, ...patch}];
const jev = {kind: 'decision', provider: 'typesafe', model: 'jev-latest'} satisfies JudgeSelectionView;
const render = (value: JudgeSelectionView, patch: Partial<Parameters<typeof JudgeModelChoice>[0]> = {}) => renderToStaticMarkup(
  <JudgeModelChoice value={value} onChange={() => {}} backend="codex-appserver" catalog={catalog()} decisionModels={decisions()} disabled={false} followLabel="跟着 Bot 默认" allowCustom showInheritedKey={false} {...patch} />,
);
const choices = (value: JudgeSelectionView, patch: Partial<Parameters<typeof judgeChoiceOptions>[0]> = {}) => judgeChoiceOptions({value, catalog: catalog(), decisionModels: decisions(), followLabel: '跟着 Bot 默认', allowCustom: true, ...patch});

it('groups visible language models and selectable decision models after the follow choice', () => {
  const html = render({kind: 'default'});
  expect(html).toContain('<option value="follow" selected="">跟着 Bot 默认</option>');
  expect(html).toContain('<optgroup label="语言模型">');
  expect(html).toContain('gpt-6-luna · gpt-6-luna');
  expect(html).not.toContain('gpt-6 · gpt-6');
  expect(html).toContain('<optgroup label="决策模型"><option value="dm:0">TypeSafe 的 Jev（还没填 key）</option>');
});
it('omits decision choices on older daemons', () => {
  expect(render({kind: 'default'}, {decisionModels: undefined})).not.toContain('label="决策模型"');
});
it('shows missing key instructions and the optional secrets button', () => {
  const html = render(jev, {onOpenSecrets: () => {}});
  expect(html).toContain('请在决策模型页添加密钥');
  expect(html).toContain(MEANWHILE);
  expect(html).toContain('去密钥页');
  expect(render(jev)).not.toContain('去密钥页');
  expect(judgeKeyNotice(jev, decisions({keySet: true}))).toBeUndefined();
  expect(render(jev, {decisionModels: decisions({keySet: true})})).not.toContain('还没填 key');
  expect(render(jev, {decisionModels: decisions({keyUnreadable: true})})).toContain('读不了密钥库');
});
it('shows inherited missing keys only when the saved and draft settings follow', () => {
  expect(render({kind: 'default'}, {effective: jev, showInheritedKey: true})).toContain('请在决策模型页添加密钥');
  expect(render({kind: 'default'}, {effective: jev, showInheritedKey: false})).not.toContain('请在决策模型页添加密钥');
});
it('describes the effective model while the draft previews its own missing key', () => {
  const html = render(jev, {effective: {kind: 'llm', model: 'gpt-6-luna'}});
  expect(html).toContain('现在判断用：gpt-6-luna');
  expect(html).not.toContain('现在判断用：TypeSafe');
  expect(html).toContain('请在决策模型页添加密钥');
  expect(render(jev)).not.toContain('现在判断用');
});
it('shows a custom model in its text field', () => {
  const html = render({kind: 'llm', model: 'gw:x', custom: true});
  expect(html).toContain('<option value="custom" selected="">手填模型 id…</option>');
  expect(html).toContain('aria-label="手填模型 id"');
  expect(html).toContain('value="gw:x"');
});
it('offers backend-specific default effort and selects the saved effort', () => {
  const value = {kind: 'llm', model: 'gpt-6-luna', effort: 'low'} satisfies JudgeSelectionView;
  expect(render(value)).toContain('aria-label="判断的推理强度"');
  expect(render(value)).toContain('<option value="">默认</option>');
  expect(render(value)).toContain('<option value="low" selected="">low</option>');
  expect(render(value, {backend: 'claude-agent'})).toContain('默认（关闭思考）');
});
it('identifies a saved model missing from an available populated catalog', () => {
  expect(render({kind: 'llm', model: 'gone'})).toContain('<option value="lm:1" selected="">gone（已保存，当前目录里没有）</option>');
});
it('does not claim a model is missing when no usable catalog arrived', () => {
  for (const current of [undefined, catalog({state: 'unavailable', error: '目录不可用', models: []}), catalog({models: []})]) {
    const html = render({kind: 'llm', model: 'gone'}, {catalog: current});
    expect(html).toContain('<option value="lm:0" selected="">gone</option>');
    expect(html).not.toContain('当前目录里没有');
  }
  expect(render(jev, {catalog: catalog({state: 'unavailable', error: '目录不可用'})})).toContain('目录不可用');
});
it('preserves unknown selections as disabled selected options', () => {
  expect(render({kind: 'future'})).toContain('<option value="unknown" disabled="" selected="">这个版本不认识的设置，判断时当没设</option>');
});
it('returns exact selections without parsing model ids', () => {
  const result = choices({kind: 'default'}, {catalog: catalog({models: [{...catalog().models[0]!, id: 'gw:model-1'}]})});
  expect(result.follow.selection).toEqual({kind: 'default'});
  expect(result.language[0]?.selection).toEqual({kind: 'llm', model: 'gw:model-1'});
  expect(result.decision[0]?.selection).toEqual(jev);
});
it('retains the whole current selection when selecting the same model', () => {
  const value = {kind: 'llm', model: 'gpt-6-luna', effort: 'high', backend: 'codex-appserver'} satisfies JudgeSelectionView;
  expect(choices(value).language[0]?.selection).toBe(value);
  expect(choices(jev).decision[0]?.selection).toBe(jev);
});
it('uses title efforts for custom ids and only the default without any efforts', () => {
  const value = {kind: 'llm', model: 'gw:x', custom: true} satisfies JudgeSelectionView;
  expect(judgeEffortChoices(value, catalog(), 'codex-appserver').map(option => option.value)).toEqual(['', 'low', 'high']);
  expect(judgeEffortChoices(value, undefined, 'codex-appserver')).toHaveLength(1);
  expect(judgeEffortChoices({kind: 'llm', model: 'gone'}, catalog({titleEfforts: []}), 'codex-appserver')).toHaveLength(1);
});
it('names known, inherited, and unknown models', () => {
  expect(judgeLabel(jev, decisions())).toBe('TypeSafe 的 Jev');
  expect(judgeLabel({kind: 'llm', model: 'gpt-6-luna', effort: 'low'})).toBe('gpt-6-luna（推理强度 low）');
  expect(judgeLabel({kind: 'default'})).toBe('各后端的默认小模型');
  expect(judgeLabel({kind: 'future'})).toBe('这个版本的网页不认识的设置');
});

it('keeps saved effort selected even without a matching catalog effort', () => {
  const value = {kind: 'llm', model: 'saved', effort: 'low'} satisfies JudgeSelectionView;
  for (const current of [undefined, catalog({models: []}), catalog({state: 'unavailable', models: [], error: '目录不可用'})]) {
    expect(judgeEffortChoices(value, current, 'codex-appserver').map(option => option.value)).toEqual(['', 'low']);
    expect(render(value, {catalog: current})).toContain('<option value="low" selected="">low</option>');
  }
  expect(judgeEffortChoices({...value, model: 'gpt-6-luna', effort: 'ultra'}, catalog(), 'codex-appserver').map(option => option.value)).toEqual(['', 'low', 'high', 'ultra']);
});
it('keeps a saved decision model selected without a decision registry', () => {
  const result = choices(jev, {decisionModels: undefined});
  expect(result.decision).toEqual([{value: 'dm:0', label: 'typesafe 的 jev-latest', selection: jev}]);
  expect(result.selected).toBe('dm:0');
  expect(render(jev, {decisionModels: undefined})).toContain('<option value="dm:0" selected="">typesafe 的 jev-latest</option>');
});
it('distinguishes hidden saved models from models absent from the catalog', () => {
  expect(render({kind: 'llm', model: 'gpt-6'})).toContain('gpt-6（已保存，目录里已隐藏）');
  expect(render({kind: 'llm', model: 'gpt-6'})).not.toContain('当前目录里没有');
});
