import type { BuiltinSkill } from './package';
import { configSkill } from './config';
import { dmFeishuSkill, feishuSkill } from './feishu';
import { dmScheduleSkill, scheduleSkill } from './schedule';
import {recipeSkill} from './recipe';

/**
 * product.md 3.6: vonvon's own skills, every name starting `vonvon` (s1b). A bound group's sessions get the task skill
 * and the Feishu skill; a private chat gets the same two names in its own words, plus configuration and recipe creation. vonvon
 * ships no other Feishu-operations skill (Feishu's own lark-cli skills are the user's). A comment's session gets none
 * (its reply is a document comment).
 */
export function builtinSkillsOfSet(set: 'group' | 'dm'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduleSkill, feishuSkill];
    case 'dm': return [dmScheduleSkill, dmFeishuSkill, configSkill, recipeSkill];
  }
}

/** Every builtin skill's name, once: what a session's skill whitelist adds, whichever package it was handed. */
export function builtinSkillNames(): string[] {
  return [...new Set([...builtinSkillsOfSet('group'), ...builtinSkillsOfSet('dm')].map(skill => skill.name))];
}
