import { constants } from 'node:fs';
import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { syncDirectory } from '../config/bot-namespace';
import { writeFileAtomic } from '../server/atomic-file';
import { devicesPath, prepareDevicesDirectory, refuseNewer } from './files';

/** An X25519 key as JWK `x` / `d`: 32 bytes, base64url. */
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** `<dataRoot>/devices/device.json` (devices 4.1): this data root's identity; clients pin its public key when they pair. */
export const deviceIdentitySchema = z.object({
  v: z.literal(1), deviceId: z.string().uuid(), name: z.string().min(1).max(40),
  keypair: z.object({ publicKey: keySchema, secretKey: keySchema }).strict(),
}).strict();
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;
/** What the file may hold: the fields above, and any a newer version added, kept when this one writes it back. */
const deviceFileSchema = z.looseObject({ ...deviceIdentitySchema.shape, keypair: z.looseObject(deviceIdentitySchema.shape.keypair.shape) });
type DeviceFile = z.infer<typeof deviceFileSchema>;

const code = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;
const serialize = (value: DeviceFile): string => `${JSON.stringify(value, null, 2)}\n`;
const known = ({ v, deviceId, name, keypair: { publicKey, secretKey } }: DeviceFile): DeviceIdentity => ({ v, deviceId, name, keypair: { publicKey, secretKey } });

/** Only a regular file of this user, never through a link; a mode wider than 0600 (a copied or restored data root) is narrowed. */
async function readDevice(home: string): Promise<DeviceFile> {
  const file = devicesPath(home, 'device.json');
  let handle;
  try { handle = await open(file, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (code(error) !== 'ELOOP') throw error;
    throw new Error(`device.json 是一个链接：${file}。换回原来的文件再启动。`);
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== 'win32' && info.uid !== process.getuid?.())) {
      throw new Error(`device.json 必须是当前用户自己的普通文件：${file}。改好它的类型和属主再启动。`);
    }
    if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  refuseNewer(file, parsed);
  try { return deviceFileSchema.parse(parsed); }
  catch {
    // Never rebuilt: every paired client pinned this key, and a new one would look like another device to them.
    throw new Error(`device.json 损坏：${file} 不是有效的设备身份。从备份恢复它；确实要换一个新身份，删掉它再启动，已配对的设备都要重新配对。`);
  }
}
/** First start: a new X25519 key pair and the host name. A file that does not parse fails the start instead. */
export async function loadOrCreateDevice(home: string, machineId: string): Promise<DeviceIdentity> {
  await prepareDevicesDirectory(home);
  try { return known(await readDevice(home)); }
  catch (error) { if (code(error) !== 'ENOENT') throw error; }
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const identity = deviceIdentitySchema.parse({
    v: 1, deviceId: machineId, name: hostname().trim().slice(0, 40) || 'Vonvon Bot',
    keypair: { publicKey: publicKey.export({ format: 'jwk' }).x, secretKey: privateKey.export({ format: 'jwk' }).d },
  });
  // Written whole and synced, then linked: two first starts at once keep one identity, and neither a crash nor a power
  // loss leaves a half file that would stop every later start (a damaged identity is never rebuilt).
  const file = devicesPath(home, 'device.json');
  const temporary = join(dirname(file), `.device.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(serialize(identity)); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, file);
    // The link is the commit point: a directory that cannot be synced only costs durability, never the identity.
    await syncDirectory(dirname(file)).catch(() => undefined);
    return identity;
  } catch (error) {
    if (code(error) === 'EEXIST') return known(await readDevice(home));
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

export async function renameDevice(home: string, name: string): Promise<DeviceIdentity> {
  await prepareDevicesDirectory(home);
  const current = await readDevice(home);
  const renamed = { ...current, name: deviceIdentitySchema.shape.name.parse(name) };
  await writeFileAtomic(devicesPath(home, 'device.json'), serialize(renamed), { durable: true });
  return known(renamed);
}
/** For the secure channel (D2). */
export function deviceKeyPair(identity: DeviceIdentity): { publicKey: Buffer; privateKey: KeyObject } {
  const { publicKey: x, secretKey: d } = identity.keypair;
  return { publicKey: Buffer.from(x, 'base64url'), privateKey: createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x, d }, format: 'jwk' }) };
}
