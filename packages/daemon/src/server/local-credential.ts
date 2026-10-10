import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { machineIdSchema } from '@vonvon/protocol';

async function persistentValue(file: string, create: () => string): Promise<string> {
  try { await writeFile(file, create(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await chmod(file, 0o600);
  return (await readFile(file, 'utf8')).trim();
}
export async function readLocalIdentity(home: string) {
  const credential = await persistentValue(join(home, 'local-credential'), () => randomBytes(32).toString('hex'));
  if (!/^[a-f0-9]{64}$/.test(credential)) throw new Error('Invalid local credential file');
  const machineId = machineIdSchema.parse(await persistentValue(join(home, 'machine-id'), randomUUID));
  return { credential, machineId };
}
