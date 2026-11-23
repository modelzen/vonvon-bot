import {describe, expect, it} from 'vitest';
import {canonicalizeRichRecipeContent, decodeRichRecipeContent} from '@vonvon/protocol';
import {createFeedbackRecipe, feedbackHelpUrls} from '../src/feedback/recipe.js';
import {setupDestination} from '../src/feedback/config.js';
import {feedbackDetailFields, feedbackSummarySchema} from '../src/feedback/types.js';

describe('portable feedback recipe', () => {
  it('round trips through the actual rich-v2 codec with ordinary setup skill and explicit references', () => {
    const content = createFeedbackRecipe();
    expect(decodeRichRecipeContent(canonicalizeRichRecipeContent(content).canonical).content).toEqual(content);
    expect(content.setup).toEqual([]);
    expect(content.tasks).toEqual([]);
    expect(content.skills).toHaveLength(2);
    expect(content.files.map(file => file.name)).toContain('feedback/references/summary.md');
    expect(JSON.stringify(content)).not.toMatch(/OxVTbr|shrcndx|\/Users\/|Bearer |appSecret\s*[:=]|user_access_token\s*[:=]/);
  });

  it('ships each cited help entry as an offline reference in the installed feedback skill', () => {
    const content = decodeRichRecipeContent(canonicalizeRichRecipeContent(createFeedbackRecipe()).canonical).content;
    const ref = content.files.find(file => file.name === 'feedback/references/official-help.md');
    if (ref?.text.kind !== 'inline') throw Error('Missing offline help reference');
    const owner = content.skills.find(skill => skill.fileIds.includes(ref.itemId));
    const entry = content.files.find(file => file.itemId === owner?.entryFileId);
    if (entry?.text.kind !== 'inline') throw Error('Missing feedback skill entry');
    expect(entry.text.value).toContain('references/official-help.md');
    for (const url of Object.values(feedbackHelpUrls)) expect(ref.text.value).toContain(url);
    expect(ref.text.value).toMatch(/0\.10\.1[\s\S]*完成后输出/);
  });

  it('puts a host-parseable administrator command in Setup for a chosen public center', () => {
    const content = createFeedbackRecipe({
      boardUrl: 'https://my.feishu.cn/base/PublicTest?table=tblFeedback&view=vewReview',
      formUrl: 'https://my.feishu.cn/share/base/shrPublicForm',
    });
    const file = content.files.find(file => file.name === 'setup/SKILL.md');
    if (file?.text.kind !== 'inline') throw Error('Missing Setup skill');
    const commands = file.text.value.split('\n').filter(line => line.startsWith('/feedback setup '));
    expect(commands).toHaveLength(1);
    expect(setupDestination(commands[0]!)).toEqual({
      baseToken: 'PublicTest', tableId: 'tblFeedback', shareToken: 'shrPublicForm',
    });
    expect(content.setup).toEqual([]);
  });

  it('documents five optional handoff fields that the host accepts and retains', () => {
    const reference = createFeedbackRecipe().files.find(file => file.name === 'feedback/references/summary.md');
    if (reference?.text.kind !== 'inline') throw Error('Missing feedback summary reference');
    const basic = {kind: 'feature', title: '保留常用选择', description: '用户每次都要重新选择。'};
    expect(feedbackSummarySchema.safeParse(basic).success).toBe(true);
    const report = Object.fromEntries(feedbackDetailFields.map(([key, label]) => [key, label + '示例']));
    expect(feedbackSummarySchema.parse({...basic, ...report})).toMatchObject(report);
    for (const [key, label] of feedbackDetailFields) expect(reference.text.value).toContain(label + ' ' + key + '：');
  });
});
