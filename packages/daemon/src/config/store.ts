import { selfEntry } from '../core/self-entry';
import { homedir } from 'node:os';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { paths } from './paths';
import type { AppConfig, AppPreferences, TenantBrand } from './schema';
import { secretKeyForApp } from './schema';
import { parseBotDefaults, resolveBotDefaults, validateConfigDefaults } from './defaults';
import { admitDirectoryChanges, configDirectories } from './directories';
import { getterContents } from './data-compatibility';

export async function loadConfig(path: string = paths.configFile): Promise<Partial<AppConfig>> {
  try {
    const text = await readFile(path, 'utf8');
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error('Invalid config JSON');
    }
    validateConfigDefaults(config);
    configDirectories(config);
    return config as Partial<AppConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Build an AppConfig whose secret is an exec-provider SecretRef pointing at
 * the local keystore via the secrets-getter wrapper. Bridge short-circuits
 * the spawn and reads the keystore directly; lark-cli can read the same way.
 */
export async function buildEncryptedAccountConfig(
  appId: string,
  tenant: TenantBrand,
  preferences?: AppPreferences,
): Promise<AppConfig> {
  const defaults = parseBotDefaults(preferences?.defaults);
  configDirectories({ preferences });
  const resolved = resolveBotDefaults(defaults);
  const initialPreferences: AppPreferences = {
    ...preferences,
    defaults: { ...defaults, permission: resolved.permission, network: resolved.network },
  };
  const wrapperPath = await ensureSecretsGetterWrapper();
  return {
    accounts: {
      app: {
        id: appId,
        secret: { source: 'exec', provider: 'bridge', id: secretKeyForApp(appId) },
        tenant,
      },
    },
    secrets: {
      providers: {
        bridge: process.platform === 'win32'
          ? { source: 'exec', command: process.execPath, args: [selfEntry(), 'secrets', 'get'], env: { HOME: homedir(), USERPROFILE: homedir(), VONVON_HOME: paths.appDir, ELECTRON_RUN_AS_NODE: '1' } }
          : { source: 'exec', command: wrapperPath, args: [] },
      },
    },
    preferences: initialPreferences,
  };
}

/**
 * Write the secrets-getter wrapper pointing at the current node + bridge
 * entry. Always rewrites (node path can move). 0700 perms.
 */
export async function ensureSecretsGetterWrapper(): Promise<string> {
  const wrapperPath = paths.secretsGetterScript;
  const node = process.execPath;
  const bridgeEntry = selfEntry();
  const content = getterContents({ nodePath: node, cliPath: bridgeEntry }, paths.appDir);
  await mkdir(dirname(wrapperPath), { recursive: true });
  const tmp = `${wrapperPath}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await chmod(tmp, 0o700);
  await rename(tmp, wrapperPath);
  return wrapperPath;
}

// 同进程内并发 saveConfig 串行化 + tmp 唯一名：避免两次写共用 tmp 文件交错（rename
// 命中被对方写一半的 tmp → JSON 损坏，或丢写）。
let saveChain: Promise<unknown> = Promise.resolve();
export function saveConfig(cfg: AppConfig, path: string = paths.configFile, expected?: Partial<AppConfig>, beforeCommit?: () => void): Promise<void> {
  const expectedSnapshot = expected === undefined ? undefined : structuredClone(expected);
  // Snapshot before yielding so queued saves validate exactly what they write.
  let serialized: string;
  try {
    validateConfigDefaults(cfg);
    configDirectories(cfg);
    serialized = `${JSON.stringify(cfg, null, 2)}\n`;
    validateConfigDefaults(JSON.parse(serialized));
    configDirectories(JSON.parse(serialized));
  } catch (error) {
    return Promise.reject(error);
  }
  const run = saveChain.then(async () => {
    const nextDirectories = configDirectories(JSON.parse(serialized));
    // Old callers without a declaration/CAS can still replace malformed legacy JSON.
    const previous = expectedSnapshot || nextDirectories ? await loadConfig(path) : {};
    if (expectedSnapshot && JSON.stringify(previous) !== JSON.stringify(expectedSnapshot)) throw new Error('配置已被其他进程修改，请重启 daemon 后重新加载');
    await admitDirectoryChanges(nextDirectories, configDirectories(previous), paths.appDir);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tmp, serialized, 'utf8');
      await chmod(tmp, 0o600);
      beforeCommit?.();
      await rename(tmp, path);
    } finally { await unlink(tmp).catch(() => undefined); }
  });
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
