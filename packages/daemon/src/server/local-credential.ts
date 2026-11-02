import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { machineIdSchema, type MachineId } from '@vonvon/protocol';
import { writeFileAtomic } from './atomic-file';

async function persistentValue(file: string, create: () => string): Promise<string> {
  try { await writeFile(file, create(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await chmod(file, 0o600);
  return (await readFile(file, 'utf8')).trim();
}
/** The data root's UUID, made once; also the device id (devices 4.1). */
export async function readMachineId(home: string): Promise<MachineId> {
  return machineIdSchema.parse(await persistentValue(join(home, 'machine-id'), randomUUID));
}
/** devices 4.1/4.4: a new credential every daemon start, so one caught while the port was free a moment no longer works. */
export async function createLocalIdentity(home: string): Promise<{ credential: string; machineId: MachineId }> {
  const machineId = await readMachineId(home);
  const credential = randomBytes(32).toString('hex');
  await writeFileAtomic(join(home, 'local-credential'), credential);
  return { credential, machineId };
}
