import { expect, it } from 'vitest';
import { recipeRichContentSchema, validateWritableRichRecipeContent } from '@vonvon/protocol';
import { nativeRichInventory, inventoryAlias } from '../src/recipe/authoring-rich-inventory';
import type { Project } from '../src/project/registry';
import { legacyWorkRules } from './helpers/work-rules-fixture';

const row: Project = {
  name: '测试', chatId: 'oc_fixture', cwd: '/unused', createdAt: 1, blank: false, bindingIncarnation: 'binding',
  workRules: '先核对再执行', smartRules: { respond: '有人求助时回应', newTopic: '不同主题开新话题' },
};
const inventory = (group: Project) => nativeRichInventory({ seed: 'fixture', row: group, botId: 'cli_fixture', botRoot: '/unused', skills: [], includeBotMemories: false });

it('exports ordinary work rules with stable native identity independently of legacy source', async () => {
  const native = await inventory(row);
  expect(native.content.rules.map(rule => rule.purpose)).toEqual(['work', 'smartRespond', 'smartNewTopic']);
  const rule = native.content.rules[0]!;
  expect(rule).toEqual({ itemId: inventoryAlias('fixture', 'item:work'), originId: inventoryAlias('fixture', 'origin:work'), purpose: 'work', text: { kind: 'inline', value: row.workRules } });
  expect(native.evidence.get(rule.itemId)).toEqual({ kind: 'native' });
  const withHistory = await inventory({ ...row, richRecipe: legacyWorkRules('旧规则') });
  expect(withHistory.content.rules).toEqual(native.content.rules);
  expect(withHistory.evidence.get(rule.itemId)).toEqual({ kind: 'native' });
  expect(recipeRichContentSchema.parse(withHistory.content)).toEqual(withHistory.content);
  expect((await inventory({ ...row, workRules: '' })).content.rules.map(rule => rule.purpose)).toEqual(['smartRespond', 'smartNewTopic']);
});

it('retains ordinary authoring safety and rich text limits rather than truncating work rules', async () => {
  expect((await inventory({ ...row, workRules: '/Users/private/secret.txt' })).content.rules.some(rule => rule.purpose === 'work')).toBe(false);
  const large = '汉'.repeat(12000);
  const result = await inventory({ ...row, workRules: large });
  expect(result.content.rules[0]!.text).toEqual({ kind: 'inline', value: large });
  expect(() => validateWritableRichRecipeContent(result.content)).toThrow();
});
