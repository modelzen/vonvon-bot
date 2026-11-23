import { expect, it } from 'vitest';
import { projectEditableSchemas, settingsRequestSchema, WORK_RULES_MAX_BYTES, workRulesSchema } from '../src/settings.js';

it('accepts old role snapshots and ordinary work rules without changing the supplement limit', () => {
  expect(projectEditableSchemas.role.parse({ supplement: '职责' })).toEqual({ supplement: '职责' });
  expect(settingsRequestSchema.parse({ type: 'save', edit: {
    scope: { kind: 'project', botId: 'cli_test', projectName: '测试' }, section: 'role', revision: 'read-revision', patch: { workRules: '' },
  } })).toMatchObject({ edit: { patch: { workRules: '' } } });
  expect(projectEditableSchemas.role.safeParse({ supplement: 'a'.repeat(30001) }).success).toBe(false);
});

it('limits work rules by UTF-8 bytes while preserving full Unicode aggregates', () => {
  const rules = '汉'.repeat(5461) + 'a';
  expect(new TextEncoder().encode(rules).length).toBe(WORK_RULES_MAX_BYTES);
  expect(workRulesSchema.parse(rules)).toBe(rules);
  expect(workRulesSchema.safeParse(rules + '😀').success).toBe(false);
  expect(workRulesSchema.safeParse('😀'.repeat(4097)).success).toBe(false);
});


it('accepts control characters, quotes and backslashes up to the same ordinary text limit', () => {
  for (const character of ['\u0000', '"', '\\']) {
    expect(workRulesSchema.parse(character.repeat(WORK_RULES_MAX_BYTES))).toHaveLength(WORK_RULES_MAX_BYTES);
    expect(workRulesSchema.safeParse(character.repeat(WORK_RULES_MAX_BYTES + 1)).success).toBe(false);
  }
});
