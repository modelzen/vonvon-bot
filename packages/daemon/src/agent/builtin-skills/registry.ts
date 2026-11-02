import type { BuiltinSkill } from './package';
import { feishuMessageSkill } from './feishu-message';
import { scheduleSkill } from './schedule';

/**
 * product.md 3.6: a bound group's sessions get vonvon's own skills, every name starting `vonvon` (s1b): the task skill
 * and how a reply becomes a Feishu message. vonvon ships no Feishu-operations skill (Feishu's own lark-cli skills are the
 * user's) and no settings skill: changing settings by chat is a private chat's, whose sessions come later
 * (settings-dm-only). A comment's session gets none (its reply is a document comment).
 */
export function builtinSkillsOfSet(set: 'group'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduleSkill, feishuMessageSkill];
  }
}
