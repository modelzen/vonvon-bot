import type { BuiltinSkill } from './package';
import { scheduledTasksSkill } from './scheduled-tasks';

export function builtinSkillsFor(profile: { tools: { schedule: boolean } }): BuiltinSkill[] {
  return profile.tools.schedule ? [scheduledTasksSkill] : [];
}
