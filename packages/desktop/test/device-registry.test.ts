import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateStaticKey } from '@vonvon/protocol/secure-channel';
import { createDeviceLog } from '../src/device-log.js';
import { electronSecretBox, MAX_DEVICES, openDeviceRegistry, RegistryError, type StoredDevice } from '../src/device-registry.js';
import { plainSecretBox } from './helpers/fake-secure-server.js';

// devices-ui-1a 第 5 节 device-registry: a mktemp directory, a box that only wraps. main 必败: there was no device list.
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vonvon-devices-'));
  directories.push(path);
  return path;
}
const box = plainSecretBox();
function device(registry: { sealKey: (generated: { publicKeyBase64url: string; privateKeyBase64url: string }) => StoredDevice['clientKey'] }, overrides: Partial<StoredDevice> = {}) {
  const generated = generateStaticKey();
  const stored: StoredDevice = {
    deviceId: randomUUID(), name: '书房的 Mac', pk: generateStaticKey().publicKeyBase64url, clientId: 'cl_0123456789abcdef',
    clientKey: registry.sealKey(generated), routes: [{ host: '203.0.113.10', port: 7767, kind: 'public' }], addedAt: 1,
    ...overrides,
  };
  return { stored, privateKey: generated.privateKeyBase64url };
}

describe('device list', () => {
  it('reads back what it wrote, 0600, with no private key in the clear', async () => {
    const path = join(await directory(), 'devices.json');
    const registry = await openDeviceRegistry(path, box);
    const a = device(registry);
    const b = device(registry, { name: '机房', routes: [{ host: 'fd7a:115c:a1e0::1', port: 7767, kind: 'tailscale' }] });
    await registry.put(a.stored);
    await registry.put(b.stored);
    const again = await openDeviceRegistry(path, box);
    expect(again.status).toBe('ok');
    expect(again.list()).toEqual([a.stored, b.stored]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(a.privateKey);
    expect(text).not.toContain(b.privateKey);
    expect(again.openKey(again.get(a.stored.deviceId)!).publicKey.toString('base64url')).toBe(a.stored.clientKey.publicKey);
    expect((await readdir(join(path, '..'))).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('keeps both of two updates sent at once', async () => {
    const path = join(await directory(), 'devices.json');
    const registry = await openDeviceRegistry(path, box);
    const a = device(registry);
    await registry.put(a.stored);
    await Promise.all([
      registry.update(a.stored.deviceId, current => ({ ...current, name: '改过的名字' })),
      registry.update(a.stored.deviceId, current => ({ ...current, lastConnectedAt: 42 })),
    ]);
    expect((await openDeviceRegistry(path, box)).get(a.stored.deviceId)).toMatchObject({ name: '改过的名字', lastConnectedAt: 42 });
  });

  it('sets a broken file aside and starts over', async () => {
    const dir = await directory();
    const path = join(dir, 'devices.json');
    await writeFile(path, '{');
    const registry = await openDeviceRegistry(path, box, { now: () => 1234 });
    expect(registry.status).toBe('recovered');
    expect(registry.list()).toEqual([]);
    expect(await readdir(dir)).toContain('devices.json.broken-1234');
    await registry.put(device(registry).stored);
    expect((await openDeviceRegistry(path, box)).list()).toHaveLength(1);
  });

  it('reads a newer file as far as it understands it and never writes it', async () => {
    const path = join(await directory(), 'devices.json');
    const registry = await openDeviceRegistry(join(await directory(), 'scratch.json'), box);
    const good = device(registry).stored;
    await writeFile(path, JSON.stringify({ v: 2, devices: [{ ...good, color: 'blue' }, { deviceId: 'broken' }] }));
    const newer = await openDeviceRegistry(path, box);
    expect(newer.status).toBe('newer');
    expect(newer.list()).toEqual([good]);
    await expect(newer.put(device(newer).stored)).rejects.toMatchObject({ code: 'registry_newer' });
    await expect(newer.update(good.deviceId, current => current)).rejects.toBeInstanceOf(RegistryError);
    expect(JSON.parse(await readFile(path, 'utf8')).v).toBe(2);
  });

  it('keeps the list when the keychain will not open a key', async () => {
    const path = join(await directory(), 'devices.json');
    const writer = await openDeviceRegistry(path, box);
    const a = device(writer).stored;
    await writer.put(a);
    const refusing = await openDeviceRegistry(path, plainSecretBox({ open: () => { throw new Error('keychain said no'); } }));
    expect(refusing.list()).toEqual([a]);
    expect(() => refusing.openKey(a)).toThrow(expect.objectContaining({ code: 'key_unreadable' }));
    const unavailable = await openDeviceRegistry(path, plainSecretBox({ available: () => false }));
    expect(unavailable.list()).toEqual([a]);
    expect(() => unavailable.openKey(a)).toThrow(expect.objectContaining({ code: 'key_unreadable' }));
    expect(() => unavailable.sealKey(generateStaticKey())).toThrow(expect.objectContaining({ code: 'no_secure_storage' }));
  });

  it('takes 32 devices and refuses a 33rd', async () => {
    const path = join(await directory(), 'devices.json');
    const registry = await openDeviceRegistry(path, box);
    const template = device(registry).stored;
    for (let index = 0; index < MAX_DEVICES; index++) await registry.put({ ...template, deviceId: randomUUID() });
    await expect(registry.put({ ...template, deviceId: randomUUID() })).rejects.toMatchObject({ code: 'too_many' });
    // Replacing one already there is not a new one.
    await registry.put({ ...registry.list()[0]!, name: '换了名字' });
    expect(registry.list()).toHaveLength(MAX_DEVICES);
  });

  it('opens an unreadable list read-only instead of failing the app', async () => {
    // A directory where the file should be: reading fails (EISDIR), as it would for a permission problem.
    const registry = await openDeviceRegistry(await directory(), box);
    expect(registry.status).toBe('unreadable');
    expect(registry.list()).toEqual([]);
    await expect(registry.put(device(registry).stored)).rejects.toMatchObject({ code: 'registry_unreadable' });
  });

  it('seals with safeStorage and opens what it sealed', () => {
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from([...Buffer.from(plain)].reverse()),
      decryptString: (sealed: Buffer) => Buffer.from([...sealed].reverse()).toString(),
    };
    const sealed = electronSecretBox(storage).seal('private');
    expect(sealed).not.toContain('private');
    expect(electronSecretBox(storage).open(sealed)).toBe('private');
  });

  it('logs one line an event, only the fields it was given, 0600', async () => {
    const path = join(await directory(), 'devices.log');
    const log = createDeviceLog(path, () => Date.UTC(2026, 10, 1, 8));
    log('device-closed', { id: '1a2b3c4d', code: 'client_revoked' });
    log('device-opened', { id: '1a2b3c4d', cause: 'reopened' });
    await expect.poll(async () => (await readFile(path, 'utf8').catch(() => '')).split('\n').length).toBe(3);
    expect(await readFile(path, 'utf8')).toBe('2026-11-01T08:00:00.000Z device-closed id=1a2b3c4d code=client_revoked\n2026-11-01T08:00:00.000Z device-opened id=1a2b3c4d cause=reopened\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
