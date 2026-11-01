import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../server/atomic-file';

/** An X25519 key as JWK `x` / `d`: 32 bytes, base64url. */
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** `<dataRoot>/device.json` (devices 4.1): this data root's identity; clients pin its public key when they pair. */
export const deviceIdentitySchema = z.object({
  v: z.literal(1), deviceId: z.string().uuid(), name: z.string().min(1).max(40),
  keypair: z.object({ publicKey: keySchema, secretKey: keySchema }).strict(),
}).strict();
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

const deviceFile = (home: string): string => join(home, 'device.json');
const code = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;
const serialize = (identity: DeviceIdentity): string => `${JSON.stringify(identity, null, 2)}\n`;

async function readDevice(home: string): Promise<DeviceIdentity> {
  const text = await readFile(deviceFile(home), 'utf8');
  try { return deviceIdentitySchema.parse(JSON.parse(text)); }
  catch {
    // Never rebuilt: every paired client pinned this key, and a new one would look like another device to them.
    throw new Error(`device.json 损坏：${deviceFile(home)} 不是有效的设备身份。从备份恢复它；确实要换一个新身份，删掉它再启动，已配对的设备都要重新配对。`);
  }
}

/** First start: a new X25519 key pair and the host name. A file that does not parse fails the start instead. */
export async function loadOrCreateDevice(home: string, machineId: string): Promise<DeviceIdentity> {
  try { return await readDevice(home); }
  catch (error) { if (code(error) !== 'ENOENT') throw error; }
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const identity = deviceIdentitySchema.parse({
    v: 1, deviceId: machineId, name: hostname().trim().slice(0, 40) || 'Vonvon Bot',
    keypair: { publicKey: publicKey.export({ format: 'jwk' }).x, secretKey: privateKey.export({ format: 'jwk' }).d },
  });
  // Written whole, then linked: two first starts at once keep one identity, and a crash leaves no half file.
  const temporary = join(home, `.device.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serialize(identity), { flag: 'wx', mode: 0o600 });
    await link(temporary, deviceFile(home));
    return identity;
  } catch (error) {
    if (code(error) === 'EEXIST') return readDevice(home);
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

export async function renameDevice(home: string, name: string): Promise<DeviceIdentity> {
  const identity = deviceIdentitySchema.parse({ ...await readDevice(home), name });
  await writeFileAtomic(deviceFile(home), serialize(identity));
  return identity;
}

/** For the secure channel (D2). */
export function deviceKeyPair(identity: DeviceIdentity): { publicKey: Buffer; privateKey: KeyObject } {
  const { publicKey: x, secretKey: d } = identity.keypair;
  return { publicKey: Buffer.from(x, 'base64url'), privateKey: createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x, d }, format: 'jwk' }) };
}
