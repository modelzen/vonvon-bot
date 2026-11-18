import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { deviceRouteSchema, type DeviceRoute } from '@vonvon/protocol';
import { staticKeyFromBase64url, type StaticKey } from '@vonvon/client/secure';

/** devices-ui-1a 4.2: only each device's client private key is sealed, not the list: when the keychain refuses or the app's
 * signature changed, the list stays and those devices ask to be paired again. */
export interface SecretBox { available(): boolean; seal(plain: string): string; open(sealed: string): string }
/** The part of Electron's `safeStorage` the box uses. */
export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(encrypted: Buffer): string }
export function electronSecretBox(storage: SafeStorageLike): SecretBox {
  return {
    available: () => storage.isEncryptionAvailable(),
    seal: plain => storage.encryptString(plain).toString('base64'),
    open: sealed => storage.decryptString(Buffer.from(sealed, 'base64')),
  };
}

export const MAX_DEVICES = 32;
const problemSchema = z.object({ code: z.enum(['revoked', 'identity_changed', 'unknown_client']), at: z.number().int() }).strict();
const lastKnownSchema = z.object({
  version: z.string(), protocolVersion: z.number().int(), platform: z.string().optional(), deviceName: z.string().optional(), at: z.number().int(),
}).strict();
const storedDeviceSchema = z.object({
  deviceId: z.guid(),
  /** The name this computer gave it. */
  name: z.string().min(1).max(40),
  /** The link's `device.pk`. */
  pk: z.string(),
  /** From the pairing result. */
  clientId: z.string(),
  /** X25519, base64url; the private key sealed by the box, base64. */
  clientKey: z.object({ publicKey: z.string(), secretKeySealed: z.string() }).strict(),
  routes: z.array(deviceRouteSchema).min(1).max(8),
  lastRoute: deviceRouteSchema.optional(),
  addedAt: z.number().int(),
  lastConnectedAt: z.number().int().optional(),
  lastKnown: lastKnownSchema.optional(),
  problem: problemSchema.optional(),
}).strict();
export type StoredDevice = z.infer<typeof storedDeviceSchema>;
export type StoredProblem = NonNullable<StoredDevice['problem']>['code'];
const fileSchema = z.object({ v: z.literal(1), devices: z.array(storedDeviceSchema).max(MAX_DEVICES) }).strict();
/** A file from a newer desktop: the fields this one knows, entry by entry, the rest dropped (and never written back). */
const lenientDeviceSchema = storedDeviceSchema.extend({
  clientKey: storedDeviceSchema.shape.clientKey.strip(),
  lastKnown: lastKnownSchema.strip().optional(),
  problem: problemSchema.strip().optional(),
}).strip();

export type RegistryStatus = 'ok' | 'newer' | 'recovered' | 'unreadable';
export type RegistryErrorCode = 'registry_newer' | 'registry_unreadable' | 'too_many' | 'key_unreadable' | 'no_secure_storage';
export class RegistryError extends Error {
  constructor(readonly code: RegistryErrorCode) {
    super(`device registry: ${code}`);
    this.name = 'RegistryError';
  }
}

export interface DeviceRegistry {
  readonly status: RegistryStatus;
  list(): readonly StoredDevice[];
  get(deviceId: string): StoredDevice | undefined;
  /** Adds the device or replaces it whole. */
  put(device: StoredDevice): Promise<void>;
  /** Read, patch and write inside the write queue, so a rename and a connection never overwrite each other. */
  update(deviceId: string, patch: (device: StoredDevice) => StoredDevice): Promise<StoredDevice | undefined>;
  remove(deviceId: string): Promise<boolean>;
  sealKey(generated: { publicKeyBase64url: string; privateKeyBase64url: string }): StoredDevice['clientKey'];
  /** Throws RegistryError('key_unreadable') when the box cannot open it. */
  openKey(device: StoredDevice): StaticKey;
}

type Loaded = { status: RegistryStatus; devices: StoredDevice[] };
async function load(path: string, now: () => number): Promise<Loaded> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ok', devices: [] };
    return { status: 'unreadable', devices: [] };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = undefined; }
  if (raw && typeof raw === 'object' && 'v' in raw && typeof raw.v === 'number' && raw.v > 1 && 'devices' in raw && Array.isArray(raw.devices)) {
    const devices: StoredDevice[] = [];
    for (const entry of raw.devices as unknown[]) {
      const parsed = lenientDeviceSchema.safeParse(entry);
      if (parsed.success && devices.length < MAX_DEVICES && !devices.some(device => device.deviceId === parsed.data.deviceId)) devices.push(parsed.data);
    }
    return { status: 'newer', devices };
  }
  const parsed = fileSchema.safeParse(raw);
  if (parsed.success && new Set(parsed.data.devices.map(device => device.deviceId)).size === parsed.data.devices.length) return { status: 'ok', devices: parsed.data.devices };
  // Kept aside, not lost: a broken list starts over empty.
  try { await rename(path, `${path}.broken-${now()}`); }
  catch { return { status: 'unreadable', devices: [] }; }
  return { status: 'recovered', devices: [] };
}

/** Never throws: when the list cannot be used the app still starts, with the device functions limited (4.2). */
export async function openDeviceRegistry(path: string, box: SecretBox, opts: { now?: () => number } = {}): Promise<DeviceRegistry> {
  const now = opts.now ?? Date.now;
  const loaded = await load(path, now).catch((): Loaded => ({ status: 'unreadable', devices: [] }));
  const status = loaded.status;
  let devices: readonly StoredDevice[] = loaded.devices;
  let queue: Promise<unknown> = Promise.resolve();

  const writable = (): void => {
    if (status === 'newer') throw new RegistryError('registry_newer');
    if (status === 'unreadable') throw new RegistryError('registry_unreadable');
  };
  async function write(next: readonly StoredDevice[]): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({ v: 1, devices: next }, null, 2)}\n`, { mode: 0o600 });
    // writeFile's mode applies only when it creates the file; a leftover temporary keeps its own.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
  /** Every write in order, each from the list the previous one left; the memory changes only once the file did. */
  function queued<T>(change: (current: readonly StoredDevice[]) => { next?: readonly StoredDevice[]; result: T }): Promise<T> {
    const run = queue.then(async () => {
      writable();
      const { next, result } = change(devices);
      if (next) {
        await write(next);
        devices = next;
      }
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    get status() { return status; },
    list: () => devices,
    get: deviceId => devices.find(device => device.deviceId === deviceId),
    put(device) {
      const parsed = storedDeviceSchema.parse(device);
      return queued(current => {
        const index = current.findIndex(entry => entry.deviceId === parsed.deviceId);
        if (index < 0 && current.length >= MAX_DEVICES) throw new RegistryError('too_many');
        const next = index < 0 ? [...current, parsed] : current.map((entry, at) => at === index ? parsed : entry);
        return { next, result: undefined };
      });
    },
    update(deviceId, patch) {
      return queued(current => {
        const index = current.findIndex(entry => entry.deviceId === deviceId);
        if (index < 0) return { result: undefined };
        const changed = storedDeviceSchema.parse(patch(current[index]!));
        if (changed.deviceId !== deviceId) throw new Error('A device update cannot change its id');
        return { next: current.map((entry, at) => at === index ? changed : entry), result: changed };
      });
    },
    remove(deviceId) {
      return queued(current => {
        if (!current.some(entry => entry.deviceId === deviceId)) return { result: false };
        return { next: current.filter(entry => entry.deviceId !== deviceId), result: true };
      });
    },
    sealKey(generated) {
      if (!box.available()) throw new RegistryError('no_secure_storage');
      return { publicKey: generated.publicKeyBase64url, secretKeySealed: box.seal(generated.privateKeyBase64url) };
    },
    openKey(device) {
      if (!box.available()) throw new RegistryError('key_unreadable');
      try { return staticKeyFromBase64url(device.clientKey.publicKey, box.open(device.clientKey.secretKeySealed)); }
      catch { throw new RegistryError('key_unreadable'); }
    },
  };
}

export type { DeviceRoute };
