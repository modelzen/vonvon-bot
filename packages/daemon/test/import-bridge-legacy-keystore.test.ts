import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canDecryptLegacySecret,
  decryptLegacySecret,
  loadLegacyKeystoreKey,
  type LegacySecretEnvelope,
} from '../src/import/bridge/legacy-keystore';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-import-key-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encrypt(key: Buffer, secret: Buffer): LegacySecretEnvelope {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

describe('legacy Bridge keystore', () => {
  it('derives the pinned key and decrypts the exact synthetic secret, then permits disposal', async () => {
    const root = await fixture();
    const salt = Buffer.alloc(32, 0x42);
    await writeFile(join(root, '.keystore.salt'), salt);
    const loaded = await loadLegacyKeystoreKey(root);
    expect(loaded.state).toBe('ready');
    if (loaded.state !== 'ready') throw new Error('fixture key unavailable');
    const expected = pbkdf2Sync(`${hostname()}|${userInfo().username}`, salt, 100_000, 32, 'sha256');
    expect(loaded.key).toEqual(expected);
    const envelope = encrypt(expected, Buffer.from('synthetic-app-secret'));
    expect(canDecryptLegacySecret(loaded.key, envelope)).toBe(true);
    const plaintext = decryptLegacySecret(loaded.key, envelope);
    expect(plaintext?.toString()).toBe('synthetic-app-secret');
    plaintext?.fill(0);
    loaded.key.fill(0);
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);
    expect(loaded.key.every((byte) => byte === 0)).toBe(true);
    expected.fill(0);
    salt.fill(0);
  });

  it('separates absent salt from malformed salt and refuses a symlink', async () => {
    const root = await fixture();
    expect(await loadLegacyKeystoreKey(root)).toEqual({ state: 'missing' });
    const saltFile = join(root, '.keystore.salt');
    await writeFile(saltFile, Buffer.alloc(31));
    expect(await loadLegacyKeystoreKey(root)).toEqual({ state: 'invalid' });
    await rm(saltFile);
    await symlink(join(root, 'missing-target'), saltFile);
    expect(await loadLegacyKeystoreKey(root)).toEqual({ state: 'invalid' });
    if (process.platform !== 'win32') {
      await rm(saltFile);
      expect(spawnSync('mkfifo', [saltFile]).status).toBe(0);
      expect(await loadLegacyKeystoreKey(root)).toEqual({ state: 'invalid' });
    }
  });

  it('rejects tampering, wrong seed, and invalid envelope encodings', async () => {
    const key = Buffer.alloc(32, 0x19);
    const envelope = encrypt(key, Buffer.from('synthetic-secret'));
    const badTag = Buffer.from(envelope.tag, 'base64');
    badTag[0] = (badTag[0] ?? 0) ^ 1;
    const variants: LegacySecretEnvelope[] = [
      { ...envelope, tag: badTag.toString('base64') },
      { ...envelope, iv: '@@@=' },
      { ...envelope, iv: Buffer.alloc(11).toString('base64') },
      { ...envelope, iv: 'A'.repeat(1024) },
      { ...envelope, tag: 'A'.repeat(1024) },
      { ...envelope, data: '' },
      { ...envelope, data: 'A===' },
      { ...envelope, data: 'AB==' },
      { ...envelope, data: 'A'.repeat(128 * 1024) },
      { ...envelope, data: 'A'.repeat(128 * 1024 + 1) },
      { ...envelope, tag: Buffer.alloc(15).toString('base64') },
    ];
    for (const variant of variants) {
      expect(canDecryptLegacySecret(key, variant)).toBe(false);
      expect(decryptLegacySecret(key, variant)).toBeUndefined();
    }
    const wrongKey = pbkdf2Sync('other-host|other-user', Buffer.alloc(32, 0x42), 100_000, 32, 'sha256');
    expect(canDecryptLegacySecret(wrongKey, envelope)).toBe(false);
    wrongKey.fill(0);
    key.fill(0);
  });
});
