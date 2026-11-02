import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLocalIdentity, readMachineId } from '../src/server/local-credential';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-credential-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

// devices 4.3: a credential printed by `vonvon open --print` lives only as long as that daemon run.
it('rotates the credential on every start and keeps the machine id', async () => {
  const first = await createLocalIdentity(home);
  const second = await createLocalIdentity(home);
  expect(first.credential).toMatch(/^[a-f0-9]{64}$/);
  expect(second.credential).not.toBe(first.credential);
  expect(second.machineId).toBe(first.machineId);
  expect(await readMachineId(home)).toBe(first.machineId);
  expect((await readFile(join(home, 'local-credential'), 'utf8')).trim()).toBe(second.credential);
  if (process.platform !== 'win32') expect((await stat(join(home, 'local-credential'))).mode & 0o777).toBe(0o600);
});
