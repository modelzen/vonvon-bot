import {createHash} from 'node:crypto';
import type {Project} from '../project/registry';
import type {SessionRecord} from './session-store';

type SkillProject = Pick<Project, 'skills' | 'richRecipe' | 'releaseCode'>;
export function projectSkillKey(project?: SkillProject): string {
  return createHash('sha256').update(JSON.stringify([
    [...new Set(project?.skills?.disabledPaths ?? [])].sort(),
    project?.richRecipe?.pointer ?? null,
    // An opt-in changes the tool catalog. Preserve existing keys for groups without it.
    ...(project?.releaseCode ? [project.releaseCode.revision] : []),
  ])).digest('hex');
}

export function sessionSkillsChanged(record: Pick<SessionRecord, 'sessionId' | 'skillProfile'>, project?: SkillProject): boolean {
  const accepted = record.skillProfile;
  if (accepted?.sessionId === record.sessionId) return accepted.key !== projectSkillKey(project);
  // A pre-profile session is safe to resume only while no per-group skill policy exists.
  return Boolean(project?.richRecipe || project?.skills?.disabledPaths.length || project?.releaseCode);
}
