import { selfEntry } from '../core/self-entry';
import { homedir } from 'node:os';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { classifyDistribution, nearestPackageRoot } from '../service/distribution';
import { paths } from './paths';
import type { AppConfig, AppPreferences, TenantBrand } from './schema';
import { secretKeyForApp } from './schema';
import { parseBotDefaults, resolveBotDefaults, validateConfigDefaults } from './defaults';
import { admitDirectoryChanges, configDirectories } from './directories';
import { getterContents } from './data-compatibility';
import { cardDisplayConfigSchema } from '@vonvon/protocol';
import { log } from '../core/logger';

const warnedCardDisplay = new Set<string>();
function sanitizeCardDisplay(config: unknown, location: string): void {
  if (!config || typeof config !== 'object' || !('preferences' in config)) return;
  const preferences = (config as { preferences?: unknown }).preferences;
  if (!preferences || typeof preferences !== 'object' || !('cardDisplay' in preferences)) return;
  const stored = preferences as { cardDisplay?: unknown };
  if (stored.cardDisplay === undefined || cardDisplayConfigSchema.safeParse(stored.cardDisplay).success) return;
  delete stored.cardDisplay;
  if (!warnedCardDisplay.has(location)) {
    warnedCardDisplay.add(location);
    log.warn('card', 'display-config-invalid', { scope: 'bot', action: 'ignored-stored-card-display' });
  }
}

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
    sanitizeCardDisplay(config, path);
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

/** The install root of the standalone server this process runs from, if it runs from one. */
function ownStandaloneRoot(): string | undefined {
  const own = classifyDistribution(nearestPackageRoot(selfEntry()));
  return own.kind === 'standalone' ? own.installRoot : undefined;
}

/**
 * What the secrets-getter wrapper of this data directory holds. A standalone server's names only
 * `<installRoot>/current`, never a versioned release (reviews 207, 221): the wrapper outlives the release that writes
 * it, the getters of data directories whose daemon does not run are never seen by the cleanup of `releases/`, and
 * that cleanup never removes the release `current` names (cleanupReleases). Elsewhere the running Node and entry.
 */
export function secretsGetterContents(installRoot: string | undefined): string {
  const node = installRoot ? join(installRoot, 'current', 'node', 'bin', 'node') : process.execPath;
  const bridgeEntry = installRoot ? join(installRoot, 'current', 'app', 'bin', 'vonvon.mjs') : selfEntry();
  return getterContents({ nodePath: node, cliPath: bridgeEntry }, paths.appDir);
}

/**
 * Write the secrets-getter wrapper (secretsGetterContents). Always rewrites (node path can move). 0700 perms.
 * `installRoot` is this process's own standalone install unless a caller names one.
 */
export async function ensureSecretsGetterWrapper(installRoot: string | undefined = ownStandaloneRoot()): Promise<string> {
  const wrapperPath = paths.secretsGetterScript;
  const content = secretsGetterContents(installRoot);
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
    if (cfg.preferences?.cardDisplay !== undefined && !cardDisplayConfigSchema.safeParse(cfg.preferences.cardDisplay).success) throw new Error('消息卡配置无效');
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
