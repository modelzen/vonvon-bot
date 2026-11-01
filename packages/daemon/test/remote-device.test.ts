import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { deviceKeyPair, loadOrCreateDevice, renameDevice } from '../src/remote/device';
import { devicesPath } from '../src/remote/files';

const machineId = '00000000-0000-4000-8000-000000000000';
const posix = process.platform !== 'win32';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-device-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const file = (): string => devicesPath(home, 'device.json');
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

it('creates the identity once, owner-only, keyed to the machine id', async () => {
  const [first, racing] = await Promise.all([loadOrCreateDevice(home, machineId), loadOrCreateDevice(home, machineId)]);
  expect(racing).toEqual(first);
  expect(first.deviceId).toBe(machineId);
  expect(first.keypair.publicKey).toHaveLength(43);
  if (posix) expect([await mode(file()), await mode(join(home, 'devices'))]).toEqual([0o600, 0o700]);
  const text = await readFile(file(), 'utf8');
  expect(await loadOrCreateDevice(home, machineId)).toEqual(first);
  expect(await readFile(file(), 'utf8')).toBe(text);
  expect(deviceKeyPair(first).publicKey).toHaveLength(32);
  expect(deviceKeyPair(first).privateKey.asymmetricKeyType).toBe('x25519');
});
it('refuses a damaged identity and leaves the file for the owner', async () => {
  await mkdir(join(home, 'devices'));
  await writeFile(file(), '{}');
  await expect(loadOrCreateDevice(home, machineId)).rejects.toThrow('device.json 损坏');
  expect(await readFile(file(), 'utf8')).toBe('{}');
});
it('renames the device and keeps the file owner-only', async () => {
  const before = await loadOrCreateDevice(home, machineId);
  expect(await renameDevice(home, 'A')).toEqual({ ...before, name: 'A' });
  expect((await loadOrCreateDevice(home, machineId)).name).toBe('A');
  if (posix) expect(await mode(file())).toBe(0o600);
  await expect(renameDevice(home, '')).rejects.toThrow();
});
// D1-SEC-5: a copied or restored data root (umask 022) left the key readable to the other accounts. main 必败: it stayed 0644.
it.skipIf(!posix)('narrows a looser identity file and directory to owner-only, and refuses a link', async () => {
  const before = await loadOrCreateDevice(home, machineId);
  await chmod(file(), 0o644);
  await chmod(join(home, 'devices'), 0o755);
  expect(await loadOrCreateDevice(home, machineId)).toEqual(before);
  expect([await mode(file()), await mode(join(home, 'devices'))]).toEqual([0o600, 0o700]);
  await rm(file());
  await writeFile(join(home, 'elsewhere.json'), '{}');
  await symlink(join(home, 'elsewhere.json'), file());
  await expect(loadOrCreateDevice(home, machineId)).rejects.toThrow('device.json 是一个链接');
});
// D1-R5: a newer version's optional field is no damage, and a rename keeps it; a newer format says so. main 必败: both were "损坏".
it('reads and keeps the fields a newer version added, and names a newer format', async () => {
  const before = await loadOrCreateDevice(home, machineId);
  const stored = JSON.parse(await readFile(file(), 'utf8'));
  await writeFile(file(), JSON.stringify({ ...stored, accountId: 'acc_1', keypair: { ...stored.keypair, sealed: true } }));
  expect(await loadOrCreateDevice(home, machineId)).toEqual(before);
  expect(await renameDevice(home, 'B')).toEqual({ ...before, name: 'B' });
  expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ name: 'B', accountId: 'acc_1', keypair: { sealed: true } });
  await writeFile(file(), JSON.stringify({ ...stored, v: 2 }));
  await expect(loadOrCreateDevice(home, machineId)).rejects.toThrow('较新版本');
});
