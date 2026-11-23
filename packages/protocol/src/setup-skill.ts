export function isSetupSkillName(name: string): boolean {
  return name.toLowerCase().includes('setup');
}

export function setupSkillsFirst<T extends {name: string}>(skills: readonly T[]): T[] {
  return [...skills.filter(skill => isSetupSkillName(skill.name)), ...skills.filter(skill => !isSetupSkillName(skill.name))];
}
