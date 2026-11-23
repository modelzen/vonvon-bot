import {expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {projectSkillKey, sessionSkillsChanged} from '../src/bot/skill-profile';

it('treats disabled skill paths as a set and keeps legacy sessions without an override', () => {
  expect(projectSkillKey({skills: {disabledPaths: ['b', 'a', 'a']}})).toBe(projectSkillKey({skills: {disabledPaths: ['a', 'b']}}));
  expect(projectSkillKey()).toBe(projectSkillKey({skills: {disabledPaths: []}}));
  expect(sessionSkillsChanged({sessionId: 'old'})).toBe(false);
  expect(sessionSkillsChanged({sessionId: 'old'}, {skills: {disabledPaths: ['a']}})).toBe(true);
});
it('accepts only the matching native session and refreshes both disabling and re-enabling', () => {
  const project = {skills: {disabledPaths: ['a']}};
  const record = {sessionId: 'current', skillProfile: {sessionId: 'current', key: projectSkillKey(project)}};
  expect(sessionSkillsChanged(record, project)).toBe(false);
  expect(sessionSkillsChanged(record, {skills: {disabledPaths: []}})).toBe(true);
  expect(sessionSkillsChanged({...record, sessionId: 'manual-old-session'}, project)).toBe(true);
});

it('refreshes a legacy source-enabled native catalog once while keeping normal groups unchanged', () => {
  const enabled = {releaseCode: {binding:'group',registration:'bot',revision:'first'}};
  const oldKey=createHash('sha256').update(JSON.stringify([[],null,enabled.releaseCode.revision])).digest('hex');
  expect(sessionSkillsChanged({sessionId:'old'},enabled)).toBe(true);
  expect(sessionSkillsChanged({sessionId:'old',skillProfile:{sessionId:'old',key:oldKey}},enabled)).toBe(true);
  expect(projectSkillKey(enabled)).toBe(projectSkillKey({}));
  expect(sessionSkillsChanged({sessionId:'new',skillProfile:{sessionId:'new',key:projectSkillKey(enabled)}},enabled)).toBe(false);
});
