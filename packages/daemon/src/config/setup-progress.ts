import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** Writes into the bot's existing directory only: a bot deleted meanwhile stays deleted
 * instead of coming back as a directory holding nothing but this file. */
export async function writeSetupProgress(appId: string, progress: SetupProgress): Promise<void> {
  const file = botPaths(appId).setupFile;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(progress)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('没有这个 Bot。');
    throw error;
  }
}
