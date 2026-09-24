import { promises as fs } from 'node:fs';

export async function promoteRuntimeStage(stage, destination) {
  await fs.rename(stage, destination);
}
