import { copyFile, link } from 'node:fs/promises';
import { join } from 'node:path';

export async function fixtureNode(directory: string): Promise<string> {
  const nodePath = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    await link(process.execPath, nodePath);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') throw error;
    await copyFile(process.execPath, nodePath);
  }
  return nodePath;
}
