import { constants, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths, botDir, botPaths } from './paths';
import { loadConfig } from './store';
import { isComplete, type TenantBrand, type AppConfig, type AppPreferences } from './schema';
import { acquireMutex, closeMutex } from './data-access';
import { type Allocation, type ObjectIdentity, SafeAppIdSchema, parseAllocations, ensureDurableDirectory, directoryIdentity, materializeAllocation, materializeDirectory, planDirectory, planAllocation, recordCurrent as recordAt, restoreParent, sameObject, syncDirectory, verifyDirectory } from './bot-namespace';
import { DirectoryError, directoryError } from './directory-errors';
import { resolveProjectsRootDir, type DirectorySettings } from './directories';
import { groupAllocationKey, parseGroupNamespaces, type GroupNamespaceState } from './group-namespace';

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

export interface BotsRegistry extends GroupNamespaceState {
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
      const groups = parseGroupNamespaces({ groupContainers: reg.groupContainers, groupAllocations: reg.groupAllocations }, allocations);
      return { ...reg, version: 1, current: reg.current, bots: Array.isArray(reg.bots) ? reg.bots : [],
        ...(allocations === undefined ? {} : { allocations }), ...groups };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyRegistry();
    throw error;
  }
}

async function publish(reg: BotsRegistry): Promise<void> {
  parseAllocations(reg.allocations);
  parseGroupNamespaces({ groupContainers: reg.groupContainers, groupAllocations: reg.groupAllocations }, reg.allocations);
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

/** Refuse a group creation before it reaches Feishu when this process's bot was removed or registered again (s36d1). */
export function assertBotIdentity(expected: BotIdentity): Promise<void> {
  const identity = { ...expected };
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry || !sameIdentity(entry, identity)) throw new Error('机器人已移除或重新注册，请重启后再建群');
  });
}

export function withBotGroupBinding<T>(expected: BotIdentity, group: { chatId: string; name: string; projectsRootDir: string }, operation: (scope: {
  allocatedPath: string | undefined;
  prepareDefault: () => Promise<{ cwd: string; blank: true; directories: DirectorySettings }>;
}) => Promise<T>): Promise<T> {
  const identity = { ...expected }, input = { ...group };
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry || !sameIdentity(entry, identity)) throw new Error('机器人已移除或重新注册，请重启后再绑定');
    const key = groupAllocationKey({ ...identity, chatId: input.chatId });
    const previous = registry.groupAllocations?.[key];
    return operation({ allocatedPath: previous?.state === 'ready' ? previous.namespaceRoot : undefined, prepareDefault: () => directoryError(entry.name, async () => {
      let bot = registry.allocations?.[entry.appId];
      if (!bot) {
        if (Object.keys(registry.allocations ?? {}).length >= 4096) throw new Error('Bot allocation limit reached');
        bot = await planAllocation({ ...entry, handle: entry.name, parent: input.projectsRootDir, dataDir: paths.appDir }, registry.allocations ?? {});
        registry.allocations = { ...registry.allocations, [entry.appId]: bot };
        await publish(registry);
      }
      validateAccountClaim(registry, bot, entry);
      const readyBot = await materializeBot(registry, bot);
      await publish(registry);
      let container = registry.groupContainers?.[entry.appId];
      if (!container) {
        container = { version: 1, appId: entry.appId, tenant: entry.tenant,
          ...await planDirectory({ name: 'groups', parent: readyBot.namespaceRoot, dataDir: paths.appDir, selection: { kind: 'fixed' } }, []) };
        registry.groupContainers = { ...registry.groupContainers, [entry.appId]: container };
        await publish(registry);
      }
      const readyContainer = { ...container, ...await materializeDirectory(container, paths.appDir) };
      registry.groupContainers = { ...registry.groupContainers, [entry.appId]: readyContainer };
      if (container.state === 'ready' && !sameObject(container.object, readyContainer.object)) adoptParent(registry, entry.appId, 'container', readyContainer.object);
      await publish(registry);
      let claim = registry.groupAllocations?.[key];
      if (!claim) {
        if (Object.keys(registry.groupAllocations ?? {}).length >= 4096) throw new Error('Group allocation limit reached');
        claim = { version: 1, appId: entry.appId, tenant: entry.tenant, chatId: input.chatId, initialName: input.name,
          ...await planDirectory({ name: input.name, parent: readyContainer.namespaceRoot, dataDir: paths.appDir,
            selection: { kind: 'unique', key } }, Object.values(registry.groupAllocations ?? {})) };
        registry.groupAllocations = { ...registry.groupAllocations, [key]: claim };
        await publish(registry);
      }
      claim = { ...claim, ...await materializeDirectory(claim, paths.appDir) };
      registry.groupAllocations = { ...registry.groupAllocations, [key]: claim };
      await publish(registry);
      await verifyDirectory(readyBot, paths.appDir);
      await verifyDirectory(readyContainer, paths.appDir);
      return { cwd: claim.namespaceRoot, blank: true as const, directories: { workspaces: { primary: claim.namespaceRoot, additional: [] } } };
    }) });
  });
}

/**
 * A bot's stable directory, made again with a deleted projects root above it when its parent checks out (s36c2d). A
 * made root is published at once, the rest by the caller. A new inode is the parent of the records under it, which
 * change in the same publish.
 */
async function materializeBot(registry: BotsRegistry, allocation: Allocation): Promise<Extract<Allocation, { state: 'ready' }>> {
  const root = await restoreParent(allocation, paths.appDir);
  // Every bot under that root lost its directory with it: their records name the new root, made again on use.
  if (root) {
    registry.allocations = Object.fromEntries(Object.entries(registry.allocations ?? {}).map(([appId, record]) =>
      [appId, record.parent === allocation.parent ? { ...record, parentIdentity: root } : record]));
    await publish(registry);
  }
  const recorded = registry.allocations?.[allocation.appId] ?? allocation;
  const ready = await materializeAllocation(recorded, paths.appDir);
  registry.allocations = { ...registry.allocations, [allocation.appId]: ready };
  if (recorded.state === 'ready' && !sameObject(recorded.object, ready.object)) adoptParent(registry, allocation.appId, 'bot', ready.object);
  return ready;
}
function adoptParent(registry: BotsRegistry, appId: string, level: 'bot' | 'container', object: ObjectIdentity): void {
  if (level === 'bot') {
    const container = registry.groupContainers?.[appId];
    if (container) registry.groupContainers = { ...registry.groupContainers, [appId]: { ...container, parentIdentity: object } };
    return;
  }
  registry.groupAllocations = Object.fromEntries(Object.entries(registry.groupAllocations ?? {}).map(([key, claim]) =>
    [key, claim.appId === appId ? { ...claim, parentIdentity: object } : claim]));
}

export type DirectoryRepair = { handle: string; recorded: number; missing: number };
/**
 * `vonvon bot repair-dir`: after a migration or a restore from backup, take the bot's directories at their recorded
 * paths as its own again: the bot directory, its `groups` and each group's. A directory that is gone keeps its record
 * and is made again on use. A bot found by name, app ID, or the handle a removed bot's allocation keeps.
 */
export function repairBotDirectories(wanted: string): Promise<DirectoryRepair> {
  const target = String(wanted);
  return ownBots(async registry => {
    const appId = registry.bots.find(bot => bot.name === target || bot.appId === target)?.appId
      ?? Object.values(registry.allocations ?? {}).find(record => record.handle === target || record.appId === target)?.appId;
    const allocation = appId === undefined ? undefined : registry.allocations?.[appId];
    if (!appId || !allocation) throw new Error(`没有找到「${target}」的目录记录：它不是这台电脑上注册的 bot，或者注册得早，还没分配过自己的目录。`);
    return directoryError(allocation.handle, async () => {
      const result = { handle: allocation.handle, recorded: 0, missing: 0 };
      const count = (present: boolean): void => { if (present) result.recorded++; else result.missing++; };
      const recordCurrent: typeof recordAt = (record, parent, dataDir) => recordAt(record, parent, dataDir).catch((error: unknown) => {
        if (!(error instanceof Error && error.message === 'Namespace path changed')) throw error;
        throw new DirectoryError(`「${allocation.handle}」的目录位置变了（比如换成了链接），只能按原来的路径重新记录。把目录放回原处后再运行。`, { cause: error });
      });
      let parentIdentity: ObjectIdentity;
      try { parentIdentity = await directoryIdentity(allocation.parent); }
      catch { throw new DirectoryError(`「${allocation.handle}」的目录所在的文件夹不在了（外接盘没接上的话，接上后重试）。`); }
      const bot = await recordCurrent(allocation, parentIdentity, paths.appDir);
      registry.allocations = { ...registry.allocations, [appId]: bot.record };
      count(bot.present);
      const container = registry.groupContainers?.[appId];
      if (bot.present && bot.record.state === 'ready' && container) {
        const groups = await recordCurrent(container, bot.record.object, paths.appDir);
        registry.groupContainers = { ...registry.groupContainers, [appId]: groups.record };
        count(groups.present);
        if (groups.present && groups.record.state === 'ready') {
          const owner = groups.record.object;
          for (const [key, claim] of Object.entries(registry.groupAllocations ?? {})) {
            if (claim.appId !== appId) continue;
            const group = await recordCurrent(claim, owner, paths.appDir);
            registry.groupAllocations = { ...registry.groupAllocations, [key]: group.record };
            count(group.present);
          }
        }
      }
      await publish(registry);
      return result;
    });
  });
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
      const handle = uniqueName(registry, identity.desiredName);
      allocation = await directoryError(handle, () => planAllocation({ ...identity, handle,
        parent: resolveProjectsRootDir(preferences?.projectsRootDir), dataDir: paths.appDir }, allocations));
      registry.allocations = { ...allocations, [identity.appId]: allocation };
    }
    // Re-publish visible intent before a retry can create or trust its directory.
    await publish(registry);
    const pending = allocation;
    allocation = await directoryError(pending.handle, () => materializeBot(registry, pending));
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
