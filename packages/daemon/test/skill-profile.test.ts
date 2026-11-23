import {expect, it} from 'vitest';
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

it('refreshes the tool catalog when a group enables, disables, or rebinds release code', () => {
  const enabled = {releaseCode: {binding: 'group', registration: 'bot', revision: 'first'}};
  const current = {sessionId: 'session', skillProfile: {sessionId: 'session', key: projectSkillKey(enabled)}};
  expect(sessionSkillsChanged({sessionId: 'old'}, enabled)).toBe(true);
  expect(sessionSkillsChanged(current, enabled)).toBe(false);
  expect(sessionSkillsChanged(current, {})).toBe(true);
  expect(sessionSkillsChanged(current, {releaseCode: {...enabled.releaseCode, revision: 'second'}})).toBe(true);
});
