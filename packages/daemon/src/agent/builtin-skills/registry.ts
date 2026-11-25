import { createHash } from 'node:crypto';
import type { BuiltinSkill } from './package';
import { configSkill } from './config';
import { dmFeishuSkill, feishuSkill } from './feishu';
import { dmScheduleSkill, scheduleSkill } from './schedule';

export const BUILTIN_SKILL_PREFIX = 'vonvon:';

/** Stable cross-Provider selector for a VonVon built-in skill (also matches Claude's plugin-qualified skill name). */
export function builtinSkillSelector(name: string): string {
  return `${BUILTIN_SKILL_PREFIX}${name}`;
}

export function isBuiltinSkillSelector(path: string): boolean {
  return path.startsWith(BUILTIN_SKILL_PREFIX);
}

/**
 * product.md 3.6: vonvon's own skills, every name starting `vonvon` (s1b). A bound group's sessions get the task skill
 * and the Feishu skill; a private chat gets the same two names in its own words, and `vonvon-config` (dm-agent 9). vonvon
 * ships no other Feishu-operations skill (Feishu's own lark-cli skills are the user's). A comment's session gets none
 * (its reply is a document comment).
 */
export function builtinSkillsOfSet(set: 'group' | 'dm'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduleSkill, feishuSkill];
    case 'dm': return [dmScheduleSkill, dmFeishuSkill, configSkill];
  }
}

/** Built-in skills enabled for a specific group or DM after applying its `disabledPaths`. */
export function enabledBuiltinSkills(set: 'group' | 'dm', disabledPaths?: readonly string[]): BuiltinSkill[] {
  const all = builtinSkillsOfSet(set);
  if (!disabledPaths?.length) return all;
  const disabled = new Set(disabledPaths);
  return all.filter(skill => !disabled.has(builtinSkillSelector(skill.name)));
}

/**
 * Package directory variant when a group/DM disables a subset of built-in skills.
 * Returns `undefined` when all skills in `set` are enabled so the canonical `builtin/<set>` path stays shared and readable.
 */
export function builtinSubsetVariant(set: 'group' | 'dm', enabled: readonly BuiltinSkill[]): string | undefined {
  const full = builtinSkillsOfSet(set);
  const enabledNames = [...new Set(enabled.map(skill => skill.name))].sort();
  const fullNames = [...new Set(full.map(skill => skill.name))].sort();
  if (enabledNames.length === fullNames.length && enabledNames.every((name, i) => name === fullNames[i])) {
    return undefined;
  }
  const hash = createHash('sha256').update(enabledNames.join(',')).digest('hex').slice(0, 12);
  return `subset-${hash}`;
}

/** Every builtin skill's name, once: what a session's skill whitelist adds, whichever package it was handed. */
export function builtinSkillNames(): string[] {
  return [...new Set([...builtinSkillsOfSet('group'), ...builtinSkillsOfSet('dm')].map(skill => skill.name))];
}
