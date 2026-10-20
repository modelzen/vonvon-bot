import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { inspectLocalPath, LocalFileSafetyError, readBoundedFile } from './bounded-local-files';

export interface LegacySecretEnvelope {
  iv: string;
  data: string;
  tag: string;
}

export type LegacyKeystoreKey =
  | { state: 'ready'; key: Buffer }
  | { state: 'missing' }
  | { state: 'invalid' };

export async function loadLegacyKeystoreKey(
  sourceDir: string,
  signal?: AbortSignal,
): Promise<LegacyKeystoreKey> {
  let salt: Buffer;
  try {
    if (!await inspectLocalPath(sourceDir, join(sourceDir, '.keystore.salt'), signal)) return { state: 'missing' };
    salt = await readBoundedFile(join(sourceDir, '.keystore.salt'), {
      maxBytes: 32,
      timeoutMs: 2_000,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof LocalFileSafetyError && error.problem === 'timed-out')) {
      throw error;
    }
    if (isMissingFile(error)) return { state: 'missing' };
    return { state: 'invalid' };
  }
  if (salt.length !== 32) {
    salt.fill(0);
    return { state: 'invalid' };
  }
  try {
    return {
      state: 'ready',
      key: pbkdf2Sync(`${hostname()}|${userInfo().username}`, salt, 100_000, 32, 'sha256'),
    };
  } finally {
    salt.fill(0);
  }
}

export function canDecryptLegacySecret(key: Buffer, envelope: LegacySecretEnvelope): boolean {
  const plaintext = decryptLegacySecret(key, envelope);
  if (!plaintext) return false;
  plaintext.fill(0);
  return true;
}

export function decryptLegacySecret(
  key: Buffer,
  envelope: LegacySecretEnvelope,
): Buffer | undefined {
  if (envelope.iv.length !== 16 || envelope.tag.length !== 24 || envelope.data.length > 128 * 1024) return undefined;
  const iv = decodeCanonicalBase64(envelope.iv);
  const data = decodeCanonicalBase64(envelope.data);
  const tag = decodeCanonicalBase64(envelope.tag);
  if (!iv || !data || !tag || iv.length !== 12 || data.length === 0 || tag.length !== 16) {
    iv?.fill(0);
    data?.fill(0);
    tag?.fill(0);
    return undefined;
  }
  let updateChunk: Buffer | undefined;
  let finalChunk: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    updateChunk = decipher.update(data);
    finalChunk = decipher.final();
    if (updateChunk.length + finalChunk.length === 0) return undefined;
    return Buffer.concat([updateChunk, finalChunk]);
  } catch {
    return undefined;
  } finally {
    iv.fill(0);
    data.fill(0);
    tag.fill(0);
    updateChunk?.fill(0);
    finalChunk?.fill(0);
  }
}

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') === value) return decoded;
  decoded.fill(0);
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
