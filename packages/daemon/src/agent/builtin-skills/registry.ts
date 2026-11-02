import type { BuiltinSkill } from './package';
import { scheduledTasksSkill } from './scheduled-tasks';

/**
 * product.md 3.6: a bound group's sessions get the task skill only. vonvon ships no Feishu skill of its own (Feishu's own
 * lark-cli skills are the user's) and no settings skill: changing settings by chat is a private chat's, whose sessions
 * come later (settings-dm-only).
 */
export function builtinSkillsOfSet(set: 'group'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduledTasksSkill];
  }
}
