import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SecretBox } from './device-registry.js';
import { credentialSchema, type AccountCredential } from './account-auth.js';

export interface AccountStore {
  read(): Promise<AccountCredential | undefined>;
  save(value: AccountCredential): Promise<'secure' | 'memory'>;
  clear(): Promise<void>;
}

export function accountStore(path: string, box: SecretBox): AccountStore {
  async function clear(): Promise<void> {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return {
    async read() {
      const sealed = await readFile(path, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (sealed === undefined) return;
      if (!box.available()) throw new Error('Secure storage unavailable');
      return credentialSchema.parse(JSON.parse(box.open(sealed)));
    },
    async save(value) {
      const temporary = path + '.tmp-' + randomUUID();
      try {
        if (!box.available()) throw new Error('Secure storage unavailable');
        const sealed = box.seal(JSON.stringify(value));
        await writeFile(temporary, sealed, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
        return 'secure';
      } catch {
        // An older account or rotated token must never come back on the next launch.
        await clear();
        return 'memory';
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    clear,
  };
}
