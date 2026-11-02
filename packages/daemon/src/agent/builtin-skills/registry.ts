import type { BuiltinSkill } from './package';
import { feishuSkill } from './feishu';
import { scheduledTasksSkill } from './scheduled-tasks';
import { settingsSkill } from './settings';

/**
 * product.md 3.6: a bound group's sessions get the task skill and the Feishu one (T4b, skills-scope); a private chat's
 * set has the Feishu skill and the settings one, which only a private chat gets. No private chat runs a session yet, so
 * nothing hands the `dm` set over: s54a does, leaving the settings skill out while 聊天改设置 is off.
 */
export function builtinSkillsOfSet(set: 'group' | 'dm'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduledTasksSkill, feishuSkill];
    case 'dm': return [feishuSkill, settingsSkill];
  }
}
