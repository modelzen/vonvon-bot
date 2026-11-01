import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { deviceKeyPair, loadOrCreateDevice, renameDevice } from '../src/remote/device';

const machineId = '00000000-0000-4000-8000-000000000000';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'vonvon-device-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const mode = async (name: string): Promise<number> => (await stat(join(home, name))).mode & 0o777;

it('creates the identity once, owner-only, keyed to the machine id', async () => {
  const [first, racing] = await Promise.all([loadOrCreateDevice(home, machineId), loadOrCreateDevice(home, machineId)]);
  expect(racing).toEqual(first);
  expect(first.deviceId).toBe(machineId);
  expect(first.keypair.publicKey).toHaveLength(43);
  if (process.platform !== 'win32') expect(await mode('device.json')).toBe(0o600);
  const text = await readFile(join(home, 'device.json'), 'utf8');
  expect(await loadOrCreateDevice(home, machineId)).toEqual(first);
  expect(await readFile(join(home, 'device.json'), 'utf8')).toBe(text);
  expect(deviceKeyPair(first).publicKey).toHaveLength(32);
  expect(deviceKeyPair(first).privateKey.asymmetricKeyType).toBe('x25519');
});

it('refuses a damaged identity and leaves the file for the owner', async () => {
  await writeFile(join(home, 'device.json'), '{}');
  await expect(loadOrCreateDevice(home, machineId)).rejects.toThrow('device.json 损坏');
  expect(await readFile(join(home, 'device.json'), 'utf8')).toBe('{}');
});

it('renames the device and keeps the file owner-only', async () => {
  const before = await loadOrCreateDevice(home, machineId);
  expect(await renameDevice(home, 'A')).toEqual({ ...before, name: 'A' });
  expect((await loadOrCreateDevice(home, machineId)).name).toBe('A');
  if (process.platform !== 'win32') expect(await mode('device.json')).toBe(0o600);
  await expect(renameDevice(home, '')).rejects.toThrow();
});
