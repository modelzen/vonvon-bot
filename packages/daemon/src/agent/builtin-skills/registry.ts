import type { BuiltinSkill } from './package';
import { feishuMessageSkill } from './feishu-message';
import { scheduleSkill } from './schedule';

/**
 * product.md 3.6: a bound group's sessions get vonvon's own skills, every name starting `vonvon` (s1b): the task skill
 * and how a reply becomes a Feishu message. vonvon ships no Feishu-operations skill (Feishu's own lark-cli skills are the
 * user's). A private chat has its own package: `vonvon-config` joins it with the rest of the settings work (dm-agent 9).
 * A comment's session gets none (its reply is a document comment).
 */
export function builtinSkillsOfSet(set: 'group' | 'dm'): BuiltinSkill[] {
  switch (set) {
    case 'group':
    case 'dm': return [scheduleSkill, feishuMessageSkill];
  }
}
