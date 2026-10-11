import { homedir } from 'node:os';
import { resolveDataRoot } from '../../../../config/data-root.js';

export function resolvePaseoHome(_env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataRoot(homedir()).path;
}
