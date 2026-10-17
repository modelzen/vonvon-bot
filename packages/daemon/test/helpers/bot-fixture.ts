import { mkdir, writeFile } from 'node:fs/promises';
import { paths } from '../../src/config/paths';
import type { BotsRegistry } from '../../src/config/bots';

/** Isolated test setup, deliberately outside the production writer API. */
export async function seedBots(registry: BotsRegistry): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  await writeFile(paths.botsFile, JSON.stringify(registry));
}
