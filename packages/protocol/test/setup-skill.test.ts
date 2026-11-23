import {expect, it} from 'vitest';
import {isSetupSkillName, setupSkillsFirst} from '../src/setup-skill';

it('recognizes setup anywhere in a skill name without imposing a naming format', () => {
  for (const name of ['Setup', 'feedback-setup', 'setup-feedback', 'team:SETUP', 'MySetupWizard', 'assetup']) expect(isSetupSkillName(name)).toBe(true);
  for (const name of ['', 'feedback', '初始化']) expect(isSetupSkillName(name)).toBe(false);
});

it('puts every setup skill first while keeping relative order and leaving the original list intact', () => {
  const skills = [{name: 'feedback'}, {name: 'TeamSetup'}, {name: 'report'}, {name: 'setup-other'}, {name: 'help'}];
  const before = [...skills];
  const sorted = setupSkillsFirst(skills);
  expect(sorted.map(skill => skill.name)).toEqual(['TeamSetup', 'setup-other', 'feedback', 'report', 'help']);
  expect(skills).toEqual(before);
  expect(sorted[0]).toBe(skills[1]);
  expect(setupSkillsFirst([])).toEqual([]);
});
