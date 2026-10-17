import { constants, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths, botDir, botPaths } from './paths';
import { loadConfig } from './store';
import { isComplete, type TenantBrand, type AppConfig, type AppPreferences } from './schema';
import { acquireMutex, closeMutex } from './data-access';
import { type Allocation, SafeAppIdSchema, parseAllocations, ensureDurableDirectory, materializeAllocation, planAllocation, syncDirectory } from './bot-namespace';
import { resolveProjectsRootDir } from './directories';

/** One saved bot. Credentials' secret lives in the keystore (key `app-<appId>`). */
export interface BotEntry {
  /** short human handle for `use <name>` — unique within the registry */
  name: string;
  appId: string;
  tenant: TenantBrand;
  /** bot display name from credential validation (best-effort, for `bots` list) */
  botName?: string;
  createdAt: number;
  /** New registrations get an incarnation; old rows remain absent until re-registration. */
  registrationId?: string;
  /**
   * Whether `run` / `start` brings this bot up. The active set is multi-select
   * (`bot use`): N bots can be active at once and run simultaneously (each in
   * its own process). `undefined` on every bot means "never configured" — a
   * legacy single-bot install — and {@link activeBots} falls back to `current`
   * so behavior is unchanged until the user explicitly picks a set.
   */
  active?: boolean;
}

export interface BotsRegistry {
  version: 1;
  /**
   * Primary bot's appId — kept in sync with the active set (first active bot)
   * for the single-bot code paths (doctor, the implicit no-selector `run`,
   * legacy migration). The active set ({@link activeBots}) is the source of
   * truth for what `run`/`start` launches.
   */
  current?: string;
  bots: BotEntry[];
  allocations?: Record<string, Allocation>;
}

const emptyRegistry = (): BotsRegistry => ({ version: 1, bots: [] });

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
export async function loadBots(): Promise<BotsRegistry> {
  try {
    const file = await open(paths.botsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_REGISTRY_BYTES) throw new Error('Invalid bot registry file');
      const bytes = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, null);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > MAX_REGISTRY_BYTES) throw new Error('Bot registry size limit exceeded');
      const reg = JSON.parse(bytes.subarray(0, offset).toString('utf8')) as BotsRegistry;
      const allocations = parseAllocations(reg.allocations);
      return { ...reg, version: 1, current: reg.current, bots: Array.isArray(reg.bots) ? reg.bots : [],
        ...(allocations === undefined ? {} : { allocations }) };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyRegistry();
    throw error;
  }
}

async function publish(reg: BotsRegistry): Promise<void> {
  parseAllocations(reg.allocations);
  const content = `${JSON.stringify(reg, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) throw new Error('Bot registry size limit exceeded');
  await ensureDurableDirectory(dirname(paths.botsFile));
  const tmp = `${paths.botsFile}.tmp-${process.pid}-${randomUUID()}`;
  let primaryError: unknown;
  try {
    const file = await open(tmp, 'wx', 0o600);
    let failed = false;
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    catch (error) { failed = true; throw error; }
    finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
    await rename(tmp, paths.botsFile);
    await syncDirectory(dirname(paths.botsFile));
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await unlink(tmp); }
    catch (error) {
      if (primaryError === undefined && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

/**
 * Return the registry, migrating a legacy single-bot install on first run: if
 * there's no bots.json yet but a complete flat `~/.feishu-codex-bridge/config.json`
 * exists, move its config/projects/sessions/processes into `bots/<appId>/` and
 * register it as `default` (current). Idempotent — a no-op once bots.json exists.
 */
async function loadOrMigrate(): Promise<BotsRegistry> {
  try { await lstat(paths.botsFile); return loadBots(); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  // No registry yet. Read the legacy flat config explicitly (don't rely on the
  // current useBotDir() state) and migrate it if it's a complete bot.
  const flatConfigPath = join(paths.appDir, 'config.json');
  const flat = await loadConfig(flatConfigPath);
  if (!isComplete(flat)) return emptyRegistry();

  const { id: appId, tenant } = flat.accounts.app;
  const dest = botDir(appId);
  await mkdir(dest, { recursive: true });
  for (const file of ['config.json', 'projects.json', 'sessions.json', 'processes.json']) {
    await moveIfExists(join(paths.appDir, file), join(dest, file));
  }

  const reg: BotsRegistry = {
    version: 1,
    current: appId,
    bots: [{ name: 'default', appId, tenant, createdAt: nowMs() }],
  };
  await publish(reg);
  return reg;
}

let writers: Promise<unknown> = Promise.resolve();
function ownBots<T>(operation: (registry: BotsRegistry) => Promise<T>): Promise<T> {
  const run = writers.then(async () => {
    await ensureDurableDirectory(paths.appDir);
    const mutex = await acquireMutex(paths.appDir, 'bots', 30_000);
    try { return await operation(await loadOrMigrate()); }
    finally { await closeMutex(mutex); }
  });
  writers = run.catch(() => undefined);
  return run;
}

export function ensureRegistry(): Promise<BotsRegistry> {
  return ownBots(async registry => registry);
}

export type BotIdentity = Readonly<Pick<BotEntry, 'appId' | 'tenant' | 'createdAt' | 'registrationId'>>;
export function botIdentity(entry: BotEntry): BotIdentity {
  return Object.freeze({ appId: entry.appId, tenant: entry.tenant, createdAt: entry.createdAt,
    ...(entry.registrationId === undefined ? {} : { registrationId: entry.registrationId }) });
}
function sameIdentity(entry: BotEntry, expected: BotIdentity): boolean {
  return entry.appId === expected.appId && entry.tenant === expected.tenant
    && entry.createdAt === expected.createdAt && entry.registrationId === expected.registrationId;
}

type RegisterEntryResult = { kind: 'registered'; entry: BotEntry } | { kind: 'already-registered'; entry: BotEntry };
export type RegistrationCommit = Readonly<{
  entry: Readonly<BotEntry>; snapshot: Readonly<Partial<AppConfig>>;
  preferences: Readonly<AppPreferences> | undefined; namespaceRoot: string;
}>;
export function registerBotEntry(
  input: Pick<BotEntry, 'appId' | 'tenant' | 'botName'> & { desiredName: string; initialPreferences?: AppPreferences },
  persistAccount: (selected: RegistrationCommit) => Promise<void>,
): Promise<RegisterEntryResult> {
  const identity = structuredClone(input);
  return ownBots(async registry => {
    const previous = registry.bots.find(bot => bot.appId === identity.appId);
    if (previous) return { kind: 'already-registered', entry: previous };
    if (!SafeAppIdSchema.safeParse(identity.appId).success) throw new Error('Invalid bot app ID');
    const snapshot = await loadConfig(botPaths(identity.appId).configFile);
    const preferences = structuredClone(isComplete(snapshot) ? snapshot.preferences : identity.initialPreferences);
    const allocations = registry.allocations ?? {};
    let allocation = Object.hasOwn(allocations, identity.appId) ? allocations[identity.appId] : undefined;
    if (allocation) validateAccountClaim(registry, allocation, identity);
    else {
      if (Object.keys(allocations).length >= 4096) throw new Error('Bot allocation limit reached');
      allocation = await planAllocation({ ...identity, handle: uniqueName(registry, identity.desiredName),
        parent: resolveProjectsRootDir(preferences?.projectsRootDir), dataDir: paths.appDir }, allocations);
      registry.allocations = { ...allocations, [identity.appId]: allocation };
    }
    // Re-publish visible intent before a retry can create or trust its directory.
    await publish(registry);
    allocation = await materializeAllocation(allocation, paths.appDir);
    registry.allocations = { ...registry.allocations, [identity.appId]: allocation };
    await publish(registry);
    const entry: BotEntry = { appId: identity.appId, tenant: identity.tenant, botName: identity.botName,
      name: allocation.handle, createdAt: Date.now(), registrationId: randomUUID() };
    await persistAccount(Object.freeze({ entry: Object.freeze({ ...entry }), snapshot: structuredClone(snapshot),
      preferences: structuredClone(preferences), namespaceRoot: allocation.namespaceRoot }));
    registry.bots.push(entry);
    registry.current ??= entry.appId;
    await publish(registry);
    return { kind: 'registered', entry };
  });
}

function validateAccountClaim(registry: BotsRegistry, allocation: Allocation, account: Pick<BotEntry, 'appId' | 'tenant'>): void {
  if (allocation.appId !== account.appId || allocation.tenant !== account.tenant
    || registry.bots.some(bot => bot.appId !== account.appId && bot.name === allocation.handle)
    || registry.bots.some(bot => bot.appId === account.appId && bot.name !== allocation.handle)) {
    throw new Error('Bot allocation account conflict');
  }
}

export function findBot(reg: BotsRegistry, nameOrAppId: string): BotEntry | undefined {
  return reg.bots.find((b) => b.name === nameOrAppId || b.appId === nameOrAppId);
}

export function currentBot(reg: BotsRegistry): BotEntry | undefined {
  return reg.current ? reg.bots.find((b) => b.appId === reg.current) : undefined;
}

/**
 * The bots `run` / `start` should bring up — the multi-select active set.
 *
 * Once the user has configured the set via `bot use`, every bot carries an
 * explicit `active` flag (true/false), so this returns exactly the selected
 * bots (possibly empty if they deselected all). A legacy install where no bot
 * has the flag yet falls back to just `current`, so single-bot behavior is
 * unchanged until the user opts into multi-select.
 */
export function activeBots(reg: BotsRegistry): BotEntry[] {
  const configured = reg.bots.some((b) => b.active !== undefined);
  if (configured) return reg.bots.filter((b) => b.active === true);
  const cur = currentBot(reg);
  return cur ? [cur] : [];
}

/** Apply one activation delta to the current disk state, including the legacy current fallback. */
export function setBotActivation(appId: string, enabled: boolean): Promise<BotsRegistry> {
  return ownBots(async registry => {
    if (!registry.bots.some(bot => bot.appId === appId)) throw new Error(`机器人「${appId}」不存在。`);
    const active = new Set(activeBots(registry).map(bot => bot.appId));
    if (enabled) active.add(appId); else active.delete(appId);
    for (const bot of registry.bots) bot.active = active.has(bot.appId);
    const primary = registry.bots.find(bot => bot.active);
    if (primary) registry.current = primary.appId;
    await publish(registry);
    return registry;
  });
}

export type RemoveBotResult = { kind: 'removed'; registry: BotsRegistry }
  | { kind: 'missing' | 'stale' | 'active' | 'running' };
export function removeBot(
  expected: BotIdentity,
  callbacks: { isRunning: () => Promise<boolean>; cleanup: () => Promise<void> },
): Promise<RemoveBotResult> {
  const identity = { ...expected };
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry) return { kind: 'missing' };
    if (!sameIdentity(entry, identity)) return { kind: 'stale' };
    if (await callbacks.isRunning()) return { kind: 'running' };
    if (activeBots(registry).some(bot => bot.appId === identity.appId)) return { kind: 'active' };
    const allocation = registry.allocations?.[entry.appId];
    if (allocation) validateAccountClaim(registry, allocation, entry);
    await callbacks.cleanup();
    registry.bots = registry.bots.filter(bot => bot !== entry);
    if (registry.current === entry.appId) registry.current = registry.bots[0]?.appId;
    await publish(registry);
    return { kind: 'removed', registry };
  });
}

export function commitBotCredentialRefresh(
  expected: BotIdentity, persist: () => Promise<void>,
): Promise<'committed' | 'stale'> {
  const identity = { ...expected };
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry || !sameIdentity(entry, identity)) return 'stale';
    await persist();
    return 'committed';
  });
}

/** A registry-unique short name derived from `desired` (slugified, suffixed on clash). */
export function uniqueName(reg: BotsRegistry, desired: string): string {
  const base = slugify(desired) || 'bot';
  const claimed = new Set([...reg.bots.map(bot => bot.name), ...Object.values(reg.allocations ?? {}).map(record => record.handle)]);
  if (!claimed.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!claimed.has(candidate)) return candidate;
  }
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function nowMs(): number {
  return Date.now();
}

async function moveIfExists(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  await rename(src, dest);
}
