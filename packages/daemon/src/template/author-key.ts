import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify as cryptoVerify,
} from 'node:crypto';
import { chmod, link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { DEVICES_DIR, prepareDevicesDirectory } from '../remote/files';
import { canonicalPromoBytes, type PublicPromoPayload } from './schema';

export const AUTHOR_KEY_FILENAME = 'author-key.json';

/** SPKI DER prefix for raw 32-byte Ed25519 public keys (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface AuthorKeyPair {
  /** Base64url-encoded raw 32-byte Ed25519 public key (43 chars). */
  publicKey: string;
  /** PKCS#8 PEM private key (kept strictly inside `0700` `devices/` with mode `0600`). */
  privateKeyPem: string;
  createdAt: string;
}

interface StoredAuthorKey {
  schemaVersion: 1;
  algorithm: 'ed25519';
  publicKey: string;
  privateKeyPem: string;
  createdAt: string;
}

/**
 * Stored inside `<dataRoot>/devices/` (`0700`), which `claudeReadScope` denies as a whole directory
 * before any group session starts (covering both first-time creation and temporary files).
 */
export function authorKeyPath(dataRoot: string = paths.appDir): string {
  return join(dataRoot, DEVICES_DIR, AUTHOR_KEY_FILENAME);
}

export function generateAuthorKeyPair(): AuthorKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
  if (rawPub.length !== 32) throw new Error('生成的 Ed25519 公钥长度异常');
  return {
    publicKey: rawPub.toString('base64url'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    createdAt: new Date().toISOString(),
  };
}

async function readValidatedAuthorKey(file: string): Promise<AuthorKeyPair | undefined> {
  let info;
  try {
    info = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw err;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`创作者密钥文件类型异常（不允许链接或目录）：${file}`);
  }
  if (process.platform !== 'win32') {
    if (process.getuid && info.uid !== process.getuid()) {
      throw new Error(`创作者密钥文件属主不是当前用户：${file}`);
    }
    if ((info.mode & 0o777) !== 0o600) {
      await chmod(file, 0o600);
    }
  }
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as Partial<StoredAuthorKey>;
  if (parsed.schemaVersion === 1 && parsed.algorithm === 'ed25519' && typeof parsed.publicKey === 'string' && typeof parsed.privateKeyPem === 'string') {
    return {
      publicKey: parsed.publicKey,
      privateKeyPem: parsed.privateKeyPem,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  }
  throw new Error(`创作者密钥文件格式损坏：${file}`);
}

/**
 * Load the owner's local Ed25519 author key from `<dataRoot>/devices/author-key.json`, creating it
 * atomically with exclusive 0600 permissions if absent.
 */
export async function loadOrCreateAuthorKey(dataRoot: string = paths.appDir): Promise<AuthorKeyPair> {
  await prepareDevicesDirectory(dataRoot);
  const file = authorKeyPath(dataRoot);
  const existing = await readValidatedAuthorKey(file);
  if (existing) return existing;

  const created = generateAuthorKeyPair();
  const stored: StoredAuthorKey = { schemaVersion: 1, algorithm: 'ed25519', ...created };
  const payload = `${JSON.stringify(stored, null, 2)}\n`;

  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(tmp, 0o600).catch(() => undefined);
  try {
    await link(tmp, file);
    return created;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      const winner = await readValidatedAuthorKey(file);
      if (winner) return winner;
    }
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EXDEV' || code === 'ENOSYS')) {
      try {
        await writeFile(file, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return created;
      } catch (winErr) {
        if ((winErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
          const winner = await readValidatedAuthorKey(file);
          if (winner) return winner;
        }
        throw winErr;
      }
    }
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export function signPromoPayload(payload: PublicPromoPayload, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const bytes = canonicalPromoBytes(payload);
  return cryptoSign(null, bytes, key).toString('base64url');
}

export function verifyPromoPayload(payload: PublicPromoPayload, signature: string): boolean {
  try {
    const rawPub = Buffer.from(payload.author.publicKey, 'base64url');
    if (rawPub.length !== 32) return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sig = Buffer.from(signature, 'base64url');
    if (sig.length !== 64) return false;
    return cryptoVerify(null, canonicalPromoBytes(payload), key, sig);
  } catch {
    return false;
  }
}

function canonicalCoverBytes(
  templateId: string,
  version: string,
  docUrl: string,
  authorPublicKey: string,
  coverBytes: Uint8Array,
): Buffer {
  const hash = createHash('sha256').update(coverBytes).digest('hex');
  return Buffer.from(`vonvon-template-cover/1\n${templateId}\n${version}\n${docUrl}\n${authorPublicKey}\n${hash}`, 'utf8');
}

export function signCoverBytes(
  templateId: string,
  version: string,
  docUrl: string,
  authorPublicKey: string,
  coverBytes: Uint8Array,
  privateKeyPem: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, canonicalCoverBytes(templateId, version, docUrl, authorPublicKey, coverBytes), key).toString('base64url');
}
