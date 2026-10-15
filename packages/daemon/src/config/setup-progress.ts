import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { botPaths } from './paths';

/** What the first-run checklist cannot read from Feishu, kept per bot so it survives
 * a credential refresh. Today only the card callback (no read API exists). */
export type SetupProgress = { cardCallbackConfirmed: boolean };

export async function readSetupProgress(appId: string): Promise<SetupProgress> {
  try {
    const value: unknown = JSON.parse(await readFile(botPaths(appId).setupFile, 'utf8'));
    return { cardCallbackConfirmed: typeof value === 'object' && value !== null && (value as Record<string, unknown>).cardCallbackConfirmed === true };
  } catch {
    // Missing or unreadable: the checklist asks again, which is safe.
    return { cardCallbackConfirmed: false };
  }
}

export async function writeSetupProgress(appId: string, progress: SetupProgress): Promise<void> {
  const file = botPaths(appId).setupFile;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(progress)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}
