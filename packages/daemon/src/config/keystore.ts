import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { paths } from './paths';
import { acquireMutex, closeMutex } from './data-access';

/** Readers take no locks, create no directories or files, and use no sockets. They read the store before the key;
 * no store means no secret, without opening the key. Writers publish the key first (temp, fsync, link, directory
 * fsync), then the store (temp, fsync, rename, directory fsync), replacing the whole store without truncation.
 * master.key is published once: never overwrite, delete or rename onto it. Key rotation needs a new reader protocol.
 * Readers return plaintext only after GCM final authenticates it. Hard links are allowed: a killed first writer
 * may leave the key's temporary link behind, and authentication checks the content rather than the link count.
 * Data leases exclude secrets get; operations that must exclude readers cannot rely on assertNoDataLeases.
 */
/** Files a keystore read opens under the data root, in order; s31b leaves them readable. */
export const KEYSTORE_READ_FILES = ['secrets.enc', 'master.key'] as const;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const encoded = z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Invalid base64');
const envelope = z.object({
  iv: encoded.refine(value => Buffer.from(value, 'base64').length === 12),
  data: encoded,
  tag: encoded.refine(value => Buffer.from(value, 'base64').length === 16),
}).strict();
const storeSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), envelope) }).strict();
type StoreFile = z.infer<typeof storeSchema>;
type Envelope = z.infer<typeof envelope>;
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** An error the key page tells apart by its code (admin/secrets.ts); its message stays for logs. A missing master key
 * is lstat's own ENOENT inside: keyForMutation tells a first save by it, and the reads give it a code (keyForStore). */
const keystoreError = (code: string, message: string, cause?: unknown): Error => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });

async function readStore(): Promise<StoreFile | undefined> {
  let text: string;
  let handle;
  try { handle = await open(paths.secretsFile, READ_FLAGS); }
  catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof Error && 'code' in error && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
      throw keystoreError('KEYSTORE_STORE_FORMAT', 'Secrets store must be a regular file.', error);
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw keystoreError('KEYSTORE_STORE_FORMAT', 'Secrets store must be a regular file.');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  try { return storeSchema.parse(JSON.parse(text)); }
  catch (error) { throw keystoreError('KEYSTORE_STORE_FORMAT', 'Secrets store is not valid.', error); }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File data is still synced before publication.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function loadKey(): Promise<Buffer> {
  const metadata = await lstat(paths.masterKeyFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw keystoreError('KEYSTORE_MASTER_KEY_MODE', 'Master key must be a private regular file.');
  const handle = await open(paths.masterKeyFile, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) {
      throw keystoreError('KEYSTORE_MASTER_KEY_MODE', 'Master key must contain 32 bytes and be owned by the current user with mode 0600.');
    }
    const key = await handle.readFile();
    if (key.length !== 32) throw keystoreError('KEYSTORE_MASTER_KEY_MODE', 'Invalid master key length.');
    return key;
  } finally { await handle.close(); }
}

/** The master key of a store that is there: gone, it is said by its code, so no other missing file reads as it. */
async function keyForStore(): Promise<Buffer> {
  try { return await loadKey(); }
  catch (error) {
    if (missing(error)) throw keystoreError('KEYSTORE_MASTER_KEY_MISSING', 'Master key is missing for an existing secrets store.', error);
    throw error;
  }
}

async function keyForMutation(storeExists: boolean): Promise<Buffer> {
  try { return await loadKey(); }
  catch (error) {
    if (!missing(error)) throw error;
    if (storeExists) throw keystoreError('KEYSTORE_MASTER_KEY_MISSING', 'Master key is missing for an existing secrets store.');
  }
  const temporary = `${paths.masterKeyFile}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(randomBytes(32)); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, paths.masterKeyFile); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    await syncDirectory(dirname(paths.masterKeyFile));
    return await loadKey();
  } finally { await unlink(temporary); }
}

async function writeStore(store: StoreFile, beforeCommit?: () => Promise<void>): Promise<void> {
  const temporary = `${paths.secretsFile}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await beforeCommit?.();
    await rename(temporary, paths.secretsFile);
    await syncDirectory(dirname(paths.secretsFile));
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

function encrypt(key: Buffer, plaintext: string | Buffer, iv = randomBytes(12)): Envelope {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([typeof plaintext === 'string' ? cipher.update(plaintext, 'utf8') : cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export async function getSecret(id: string): Promise<string | undefined> {
  const store = await readStore();
  if (!store) return undefined;
  const key = await keyForStore();
  if (!Object.hasOwn(store.entries, id)) return undefined;
  const entry = store.entries[id];
  if (!entry) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) { throw keystoreError('KEYSTORE_DECRYPT', 'Secret could not be decrypted with this master key.', error); }
}

let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(async () => {
    await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
    const mutex = await acquireMutex(paths.appDir, 'keystore', 30_000);
    try { return await operation(); }
    finally { await closeMutex(mutex); }
  });
  mutations = result.catch(() => undefined);
  return result;
}

export function setSecret(id: string, plaintext: string, beforeCommit?: () => Promise<void>): Promise<void> {
  return mutate(async () => {
    const previous = await readStore();
    const key = await keyForMutation(previous !== undefined);
    const store: StoreFile = previous ?? { version: 1, entries: {} };
    Object.defineProperty(store.entries, id, { value: encrypt(key, plaintext), enumerable: true, configurable: true, writable: true });
    await writeStore(store, beforeCommit);
  });
}

export function removeSecret(id: string): Promise<boolean> {
  return mutate(async () => {
    const store = await readStore();
    if (!store) return false;
    await keyForStore();
    if (!Object.hasOwn(store.entries, id)) return false;
    delete store.entries[id];
    await writeStore(store);
    return true;
  });
}

export async function listSecretIds(): Promise<string[]> {
  const store = await readStore();
  if (!store) return [];
  await keyForStore();
  return Object.keys(store.entries);
}

/** Migration creates, never replaces. The journal owns this exact IV, including across process crashes. */
export function createSecret(id: string, plaintext: Buffer, iv: Buffer): Promise<void> {
  if (iv.length !== 12) return Promise.reject(new Error('Invalid secret ownership'));
  return mutate(async () => {
    const previous = await readStore();
    if (previous && Object.hasOwn(previous.entries, id)) throw new Error('Secret already exists');
    const key = await keyForMutation(previous !== undefined);
    try {
      const store: StoreFile = previous ?? {version: 1, entries: {}};
      Object.defineProperty(store.entries, id, {value: encrypt(key, plaintext, iv), enumerable: true, configurable: true, writable: true});
      await writeStore(store);
    } finally { key.fill(0); }
  });
}
export function removeSecretIfIv(id: string, iv: Buffer): Promise<'removed' | 'absent' | 'foreign'> {
  return mutate(async () => {
    const store = await readStore();
    const entry = store?.entries[id];
    if (!store || !entry) return 'absent';
    if (entry.iv !== iv.toString('base64')) return 'foreign';
    const key = await keyForStore(); key.fill(0);
    delete store.entries[id];
    await writeStore(store);
    return 'removed';
  });
}
