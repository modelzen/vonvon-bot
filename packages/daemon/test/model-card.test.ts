import { describe, expect, it } from 'vitest';
import { buildModelCard, reasoningEffortLabel, type ModelCardState } from '../src/card/command-cards';
import type { ModelInfo } from '../src/agent/types';

// /model 卡按「当前模型能力」自适应（对齐 Codex 的诚实体验）：
//  - effort 下拉只在当前模型真有 supportedEfforts 时出现（修旧版「空 effort 回退假
//    low/medium/high」→ 没有 effort 档的模型显示点了没用的 effort 下拉）。
//  - 模型下拉只在有多个可见模型时出现。
//  - 都不可调（单模型 + 无 effort）→ 只显示当前模型。
//  - 总有「手填模型 ID」表单（3.11）；当前模型是手填的时，effort 给后端协议的全部档位。
// 这些都是按 ModelInfo 能力派生的通用分支，用 codex 形态的 fixture 覆盖（codex 是
// 现在唯一后端，但同一张卡仍按能力自适应）。

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'displayName'>): ModelInfo => ({
  description: '',
  supportedEfforts: [],
  defaultEffort: 'medium',
  isDefault: false,
  hidden: false,
  ...over,
});

const state = (models: ModelInfo[], cur: string): ModelCardState => ({
  chatId: 'c',
  threadId: 't',
  requesterOpenId: 'u',
  models,
  model: cur,
  effort: 'medium',
  createdAt: 0,
});

// 多模型 + 真 effort（codex 的常态）。
const codex = [
  model({
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    isDefault: true,
  }),
  model({ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', supportedEfforts: ['low', 'medium', 'high'] }),
];
// 多模型但当前模型无 effort 档 → 有模型下拉、无 effort 下拉。
const multiNoEffort = [
  model({ id: 'm1', displayName: '模型一', isDefault: true }),
  model({ id: 'm2', displayName: '模型二' }),
];
// 单模型 + 无 effort → 既不能切模型也不能调 effort。
const singleNoEffort = [model({ id: 'only', displayName: '唯一模型', isDefault: true })];

const json = (s: ModelCardState): string => JSON.stringify(buildModelCard(s));

describe('buildModelCard · 按当前模型能力自适应', () => {
  it('Codex 速度默认收起为小闪电，点击后只提供目录支持的档位', () => {
    const models = [model({ id: 'sol', displayName: 'Sol', serviceTiers: [
      { id: 'fast', name: 'Fast', description: '' }, { id: 'ultrafast', name: 'Ultrafast', description: '' },
    ] })];
    const base = { ...state(models, 'sol'), backend: 'codex-appserver' };
    const collapsed = json(base);
    expect(collapsed).toContain('model.speed.open');
    expect(collapsed).toContain('"token":"speed_filled"');
    expect(collapsed).not.toContain('跟随群设置');
    expect(collapsed).not.toContain('"tier":"fast"');
    const expanded = json({ ...base, speedExpanded: true });
    expect(expanded).toContain('"tier":"standard"');
    expect(expanded).toContain('"tier":"fast"');
    expect(expanded).toContain('"tier":"ultrafast"');
    expect(expanded).toContain('消耗更多额度');
  });

  it('闪电与模型和 effort 控件共用一行，展开时才增加选择行', () => {
    const models = [
      model({ id: 'sol', displayName: 'Sol', supportedEfforts: ['low', 'high'], serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] }),
      model({ id: 'other', displayName: 'Other', supportedEfforts: ['low', 'high'] }),
    ];
    const base = { ...state(models, 'sol'), backend: 'codex-appserver' };
    const rows = (card: ReturnType<typeof buildModelCard>) =>
      ((card.body as { elements: Record<string, unknown>[] }).elements).filter(element => element.tag === 'column_set');
    const collapsed = rows(buildModelCard(base));
    expect(collapsed).toHaveLength(1);
    expect(JSON.stringify(collapsed[0])).toContain('model.set');
    expect(JSON.stringify(collapsed[0])).toContain('model.effort');
    expect(JSON.stringify(collapsed[0])).toContain('model.speed.open');
    const expanded = rows(buildModelCard({ ...base, speedExpanded: true }));
    expect(expanded).toHaveLength(2);
    expect(JSON.stringify(expanded[0])).toContain('model.speed.open');
    expect(JSON.stringify(expanded[1])).toContain('"tier":"fast"');
  });

  it.each([['standard', 'grey-400'], ['fast', 'yellow'], ['ultrafast', 'orange']] as const)('速度 %s 使用居中的纯图标，普通变暗、加速点亮且不截断文字', (serviceTier, color) => {
    const models = [
      model({ id: 'sol', displayName: 'A very long model label', supportedEfforts: ['high'], serviceTiers: [
        { id: 'fast', name: 'Fast', description: '' }, { id: 'ultrafast', name: 'Ultrafast', description: '' },
      ] }),
      model({ id: 'other', displayName: 'Other' }),
    ];
    const result = buildModelCard({ ...state(models, 'sol'), backend: 'codex-appserver', serviceTier });
    const row = (result.body as { elements: Record<string, unknown>[] }).elements.find(e => e.tag === 'column_set')!;
    expect(row.flex_mode).toBe('none');
    const cols = row.columns as { width: string; vertical_align: string; elements: Record<string, unknown>[] }[];
    expect(cols).toHaveLength(3);
    expect(cols.every(c => c.vertical_align === 'center')).toBe(true);
    expect(cols.slice(0, 2).every(c => c.width === 'weighted' && c.elements[0]!.width === 'fill')).toBe(true);
    expect(cols[2]!.width).toBe('32px');
    const control = cols[2]!.elements[0]!;
    expect(control).not.toHaveProperty('text');
    expect(control).toMatchObject({
      tag: 'button', size: 'medium', width: 'fill',
      icon: { tag: 'standard_icon', token: 'speed_filled', color },
      behaviors: [{ type: 'callback', value: { a: 'model.speed.open' } }],
    });
    expect(control.hover_tips).toMatchObject({ tag: 'plain_text', content: expect.stringContaining(serviceTier === 'standard' ? 'Standard' : serviceTier === 'fast' ? 'Fast' : 'Ultrafast') });
  });

  it('目录未提供加速档时不显示速度控件', () => {
    const base = { ...state(singleNoEffort, 'only'), backend: 'codex-appserver' };
    const plain = json(base);
    expect(plain).not.toContain('model.speed');
    expect(json({ ...base, serviceTier: 'ultrafast' })).not.toContain('model.speed');
    expect(json({ ...base, backend: 'claude-agent' })).not.toContain('model.speed');
  });

  it('已保存的极速失去支持后不作为当前速度显示', () => {
    const models = [model({ id: 'sol', displayName: 'Sol', serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] })];
    const card = json({ ...state(models, 'sol'), backend: 'codex-appserver', serviceTier: 'ultrafast' });
    expect(card).toContain('model.speed.open');
    expect(card).toContain('"color":"grey-400"');
    expect(card).not.toContain('响应速度：Ultrafast');
  });

  it('手填 ID 即使与目录模型同名也不显示速度入口', () => {
    const models = [model({ id: 'sol', displayName: 'Sol', serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] })];
    expect(json({ ...state(models, 'sol'), backend: 'codex-appserver', modelCustom: true })).not.toContain('model.speed');
    expect(json({ ...state(models, 'sol'), backend: 'codex-appserver', modelCustom: false })).toContain('model.speed.open');
  });

  it('多模型 + 真 effort（codex）→ 模型下拉 + effort 下拉都在', () => {
    const j = json(state(codex, 'gpt-5.6-sol'));
    expect(j).toContain('model.set'); // 模型下拉
    expect(j).toContain('model.effort'); // effort 下拉
    expect(j).toContain('effort：中');
    expect(j).toContain('effort：最高');
    expect(j).toContain('effort：超强');
    expect(j).not.toContain('undefined');
  });

  it('未知的新 effort 档回退显示原始值，不显示 undefined', () => {
    expect(reasoningEffortLabel('future-tier')).toBe('future-tier');
  });

  it('多模型，当前模型无 effort 档 → 有模型下拉，无 effort 下拉，有说明', () => {
    const j = json(state(multiNoEffort, 'm1'));
    expect(j).toContain('model.set'); // 仍可切模型
    expect(j).not.toContain('model.effort'); // 不再有假 effort 下拉
    expect(j).not.toContain('effort：'); // 不出现 effort 选项
    expect(j).toContain('不调节推理强度'); // 给出说明
  });

  it('单模型，无 effort → 无下拉，当前模型以文字呈现，仍可手填', () => {
    const j = json(state(singleNoEffort, 'only'));
    expect(j).not.toContain('model.set');
    expect(j).not.toContain('model.effort');
    expect(j).toContain('唯一模型'); // 当前模型以文字呈现
    expect(j).toContain('model.custom'); // 手填表单
  });

  it('每种形态都有手填表单，输入框限 200 字', () => {
    for (const [models, cur] of [[codex, 'gpt-5.6-sol'], [multiNoEffort, 'm1'], [singleNoEffort, 'only']] as const) {
      const card = buildModelCard(state([...models], cur));
      const form = JSON.stringify(card).match(/"name":"model_custom".*?"max_length":(\d+)/);
      expect(form?.[1]).toBe('200');
    }
  });

  it('当前模型是手填的 → 写明（手填）、输入框预填、effort 给协议档位', () => {
    const s = { ...state(codex, 'deepseek-chat'), backend: 'claude-agent' };
    const j = json(s);
    expect(j).toContain('`deepseek-chat`（手填）');
    expect(j).toContain('"default_value":"deepseek-chat"');
    expect(j).toContain('model.effort');
    expect(j).toContain('effort：最高'); // claude 协议有 max
    expect(j).not.toContain('effort：超强'); // 没有 ultra
  });

  it('hidden 模型不计入「是否多模型」', () => {
    const oneVisible = [
      model({ id: 'a', displayName: 'A', isDefault: true }),
      model({ id: 'b', displayName: 'B', hidden: true }),
    ];
    const j = json(state(oneVisible, 'a'));
    expect(j).not.toContain('model.set'); // 只有 1 个可见 → 不给模型下拉
  });
});
