import { join } from 'node:path';
import type { ReadScope } from '../agent/types';
import { SafeAppIdSchema } from './bot-namespace';
import { KEYSTORE_READ_FILES } from './keystore';

export const ROOT_SECRETS = ['secrets.enc', 'master.key', '.keystore.salt', 'local-credential', 'config.json'] as const;
export const SECRETS_GET_FILES: readonly string[] = KEYSTORE_READ_FILES;

export function claudeReadScope(input: {
  dataRoot: string; projectsRoot: string; appId: string; chatId?: string; extraAllow?: string[];
}): ReadScope {
  const { dataRoot, projectsRoot, appId, extraAllow = [] } = input;
  const deny = [join(dataRoot, 'bots'), join(dataRoot, 'projects'), join(dataRoot, 'library'), projectsRoot,
    ...ROOT_SECRETS.filter(file => !SECRETS_GET_FILES.includes(file)).map(file => join(dataRoot, file))];
  const allow = SECRETS_GET_FILES.filter(file => file.startsWith('bots/')).map(file => join(dataRoot, file));
  if (SafeAppIdSchema.safeParse(appId).success) allow.push(join(dataRoot, 'bots', appId, 'skills'));
  allow.push(...extraAllow);
  return { deny: [...new Set(deny)], allow: [...new Set(allow)] };
}
