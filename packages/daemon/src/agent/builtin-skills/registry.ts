import type { BuiltinSkill } from './package';
import { scheduledTasksSkill } from './scheduled-tasks';

export function builtinSkillsOfSet(set: 'group'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduledTasksSkill];
  }
}
