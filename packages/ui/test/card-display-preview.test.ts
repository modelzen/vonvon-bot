import {expect, it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {cardDisplayConfigSchema, compileCardDisplay} from '@vonvon/protocol';
import {composeCard, currentCardDisplaySnapshot, customBlock, customScriptCount, defaultCardDisplay, revisionOnOpen, safeComposeCard} from '../src/settings/card-display/card-display-model';
import {FeishuCardPreview, type CardNode} from '../src/settings/card-display/FeishuCardPreview';
import {CardDisplayPage} from '../src/settings/card-display/CardDisplayStudio';
import {toolPreviewFrames, toolPreviewFramesNonManual, toolPreviewLayoutInputs, toolPreviewLayoutInputsNonManual} from '../src/settings/card-display/card-preview-frames';

it('keeps native subagent rows and the manual reminder control in the editable preview', () => {
  const draft = defaultCardDisplay();
  const manual = JSON.stringify(composeCard(toolPreviewFrames.tool, draft, 'tool', false, undefined, toolPreviewLayoutInputs.tool));
  const automatic = JSON.stringify(composeCard(toolPreviewFramesNonManual.tool, draft, 'tool', false, undefined, toolPreviewLayoutInputsNonManual.tool));
  expect(manual).toContain('子 agent');
  expect(manual).toContain('功能侦察员');
  expect(manual).toContain('体验观察员');
  expect(manual).toContain('完成后提醒我');
  expect(automatic).toContain('子 agent');
  expect(automatic).not.toContain('完成后提醒我');
  for (const id of ['context','time','thinking','tools','status','model','stop']) expect(manual).toContain(`"preview_component":"${id}"`);
});

it('the sample custom block saves with only the field its script produces', () => {
  const draft = defaultCardDisplay();
  draft.blocks.push(customBlock(1));
  expect(cardDisplayConfigSchema.safeParse(draft).success).toBe(true);
  expect(draft.blocks.at(-1)?.template).toBe('分支 {{branch}}');
});

it('does not treat a built-in custom block sample as runtime data', () => {
  const draft = defaultCardDisplay();
  draft.blocks.push({...customBlock(1), source:'builtin', script:''});
  const preview = JSON.stringify(composeCard(toolPreviewFrames.tool, draft, 'tool', false, undefined, toolPreviewLayoutInputs.tool));
  expect(preview).toContain('分支 —');
  expect(preview).not.toContain('feature/card-style');
});

it('uses the production compiler for changed slots and keeps editor markers outside card content', () => {
  const draft = defaultCardDisplay();
  const context = draft.blocks.find(block => block.kind === 'context')!;
  context.slot = 'top-right';
  context.appearance = 'bar';
  draft.blocks.find(block => block.kind === 'time')!.slot = 'bottom-left';
  draft.blocks.find(block => block.kind === 'tools')!.mode = 'off';
  const layout = toolPreviewLayoutInputs.tool;
  const preview = composeCard(toolPreviewFrames.tool, draft, 'tool', false, undefined, layout);
  const native = compileCardDisplay(toolPreviewFrames.tool, draft, {phase:'running',...layout});
  const withoutEditorMarkers = JSON.parse(JSON.stringify(preview, (key, value) => key.startsWith('preview_') ? undefined : value));
  expect(withoutEditorMarkers).toEqual(native);
  expect(JSON.stringify(preview)).toContain('"preview_slot":"top-right"');
  expect(JSON.stringify(preview)).toContain('"preview_component":"context"');
  expect(JSON.stringify(preview)).not.toContain('"preview_component":"tools"');
});

it('renders the native context bar palette at each threshold and for explicit blue', () => {
  const findChart = (nodes: CardNode[]): CardNode | undefined => {
    for (const node of nodes) {
      if (node.tag === 'chart') return node;
      const nested = findChart([...(Array.isArray(node.columns) ? node.columns as CardNode[] : []), ...(Array.isArray(node.elements) ? node.elements as CardNode[] : [])]);
      if (nested) return nested;
    }
  };
  const draft = defaultCardDisplay();
  const context = draft.blocks.find(block => block.kind === 'context')!;
  context.appearance = 'bar';
  const cases: Array<[number, string, string]> = [
    [69,'grey','#8F959E'], [70,'yellow','#F2B50A'], [85,'orange','#F57C23'], [95,'red','#F54A45'],
  ];
  for (const [usage, name, hex] of cases) {
    const card = composeCard(toolPreviewFrames.tool, draft, 'tool', false, usage, toolPreviewLayoutInputs.tool);
    const chart = findChart(card.body.elements);
    expect((chart?.chart_spec as {color: string[]}).color).toEqual([hex]);
    const html = renderToStaticMarkup(createElement(FeishuCardPreview,{card,editing:true,editableComponents:['context']}));
    expect(html).toMatch(new RegExp(`class="vcr-progress"[^>]*data-color="${name}"`));
    expect(html).toContain('data-card-component="context"');
    expect(html).toContain(`aria-label="上下文 ${usage}%"`);
    expect(html).not.toContain('NaN');
  }
  context.color = 'blue';
  const card = composeCard(toolPreviewFrames.tool, draft, 'tool', false, 99, toolPreviewLayoutInputs.tool);
  const html = renderToStaticMarkup(createElement(FeishuCardPreview,{card}));
  expect((findChart(card.body.elements)?.chart_spec as {color: string[]}).color).toEqual(['#3370FF']);
  expect(html).toMatch(/class="vcr-progress"[^>]*data-color="blue"/);
});

it('retains the edit revision for a closed draft and counts hidden scripts toward the limit', () => {
  expect(revisionOnOpen(true, 'revision-A', 'revision-B')).toBe('revision-A');
  expect(revisionOnOpen(false, 'revision-A', 'revision-B')).toBe('revision-B');
  const draft = defaultCardDisplay();
  draft.blocks.push(...[1,2,3,4].map(index => ({...customBlock(index), mode:'off' as const})));
  expect(customScriptCount(draft)).toBe(4);
  draft.blocks.pop();
  expect(customScriptCount(draft)).toBe(3);
});

it('uses the conflict response as a fresh baseline until the settings view catches up', () => {
  const before = {saved:null, effective:defaultCardDisplay(), revision:'A'};
  const latest = {saved:defaultCardDisplay(), effective:defaultCardDisplay(), revision:'B', parentRevisionAtConflict:'A'};
  expect(currentCardDisplaySnapshot(before, latest)).toBe(latest);
  const later = {...latest,revision:'C'};
  expect(currentCardDisplaySnapshot(before, later)).toBe(later);
  const refreshed = {...before, revision:'C'};
  expect(currentCardDisplaySnapshot(refreshed, latest)).toBe(refreshed);
});

it('keeps the editor usable when a temporary sample makes the card too large', () => {
  const draft = defaultCardDisplay();
  const custom = customBlock(1);
  custom.sample = JSON.stringify({branch:'x'.repeat(110_000)});
  draft.blocks.push(custom);
  const fallback = toolPreviewFrames.tool;
  const result = safeComposeCard(fallback, draft, 'tool', undefined, toolPreviewLayoutInputs.tool, fallback);
  expect(result.error).toContain('100 KB');
  expect(result.card).toBe(fallback);
});

it('omits a script component with missing sample fields without shifting other hit targets', () => {
  const draft = defaultCardDisplay();
  const custom = customBlock(1);
  custom.sample = '{"other":"value"}';
  custom.slot = 'top';
  draft.blocks.push(custom);
  const preview = JSON.stringify(composeCard(toolPreviewFrames.tool,draft,'tool',false,undefined,toolPreviewLayoutInputs.tool));
  expect(preview).not.toContain('"preview_component":"custom-1"');
  expect(preview).toContain('"preview_component":"context"');
});

it('renders the outer editor as a settings page with a back action', () => {
  const html = renderToStaticMarkup(createElement(CardDisplayPage,{initial:defaultCardDisplay(),onSave:async () => true,onClose:() => {}}));
  expect(html).toContain('<main class="cds-page"');
  expect(html).toContain('返回设置');
  expect(html).not.toContain('aria-modal="true"');
  expect(html).not.toContain('cds-dialog-scrim');
});
