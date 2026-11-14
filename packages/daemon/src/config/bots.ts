import { constants, existsSync } from 'node:fs';
import { renameOverReaders } from '../server/atomic-file';
import { randomInt, randomUUID } from 'node:crypto';
import { badgeNumberSchema } from '@vonvon/protocol';
import { lstat, mkdir, open, realpath, rename, unlink, link, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths, botDir, botPaths } from './paths';
import { loadConfig } from './store';
import { isComplete, type TenantBrand, type AppConfig, type AppPreferences } from './schema';
import { acquireMutex, closeMutex, holdMutexRole } from './data-access';
import { type Allocation, type DirectoryClaim, type ObjectIdentity, SafeAppIdSchema, parseAllocations, ensureDurableDirectory, directoryIdentity, materializeAllocation, materializeDirectory, planDirectory, planAllocation, recordCurrent as recordAt, restoreParent, sameObject, syncDirectory, verifyDirectory } from './bot-namespace';
import { DirectoryError, directoryError } from './directory-errors';
import { resolveProjectsRootDir, type DirectorySettings } from './directories';
import { groupAllocationKey, parseGroupNamespaces, type GroupNamespaceState } from './group-namespace';
import {assertBridgeImportReservation} from '../import/bridge/reservation';

/** One saved bot. Credentials' secret lives in the keystore (key `app-<appId>`). */
export interface BotEntry {
  /** short human handle for `use <name>` — unique within the registry */
  name: string;
  appId: string;
  tenant: TenantBrand;
  /** bot display name from credential validation (best-effort, for `bots` list) */
  botName?: string;
  createdAt: number;
  /** Printed on the badge. Keep as a string so a number such as 007 survives a save. */
  badgeNumber?: string;
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
  recipeRegistryFormat?: 2;
  /**
   * Primary bot's appId — kept in sync with the active set (first active bot)
   * for the single-bot code paths (doctor, the implicit no-selector `run`,
   * legacy migration). The active set ({@link activeBots}) is the source of
   * truth for what `run`/`start` launches.
   */
  current?: string;
  bots: BotEntry[];
  allocations?: Record<string, Allocation>;
  /** Automatic issuance history survives a bot being renumbered or removed. */
  badgeIssuance?: BadgeIssuance;
}

interface BadgeIssuance {
  usedFavorites: string[];
  /** One past the maximum means the sequential range is exhausted. */
  nextSequential: number;
}

const BADGE_FAVORITES = [
  // Powers of two and familiar HTTP status codes.
  '128', '256', '512', '1024', '2048', '4096', '8192', '200', '404', '418',
  // Mathematical constants, the first primes, Ramanujan's number and Kaprekar's constant.
  '314', '3141', '2718', '1618', '1414', '1732', '2236', '2357', '1729', '6174',
  // Books, films and games: Bond, the answer to everything, Star Trek, System Shock and more.
  '007', '042', '1138', '1984', '2001', '2010', '1701', '0451', '1985', '9527',
  // Lucky numbers and Chinese homophones.
  '168', '518', '520', '521', '666', '777', '888', '999', '1314', '1688',
  // Internet favorites, runs and repeating digits.
  '2333', '4242', '1234', '4321', '1111', '2222', '3333', '6666', '8888', '9999',
];
const firstSequentialBadge = 10_000;
const lastSequentialBadge = 9_999_999;

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
      if(reg.recipeRegistryFormat!==undefined){
        const envelope=reg.allocations as unknown as {format?:unknown;entries?:unknown};
        if(reg.recipeRegistryFormat!==2 || !envelope || envelope.format!=='bot-allocations-v2' || Object.keys(envelope).some(k=>k!=='format'&&k!=='entries'))throw new Error('此 Bot 注册表需要更新版本');
        reg.allocations=parseAllocations(envelope.entries);
      }
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
  const content = `${JSON.stringify(reg.recipeRegistryFormat===2 ? {...reg,allocations:{format:'bot-allocations-v2',entries:reg.allocations??{}}} : reg, null, 2)}\n`;
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
    await renameOverReaders(tmp, paths.botsFile);
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

export function requireRichRegistry():Promise<void>{return ownBots(async registry=>{
  if(registry.recipeRegistryFormat===2)return;
  const backup=join(paths.appDir,'bots.before-recipe-v2.json'), bytes=await readFile(paths.botsFile);
  const tmp=backup+'.'+randomUUID();
  const f=await open(tmp,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
  try{await link(tmp,backup);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{await unlink(tmp);}
  await syncDirectory(paths.appDir);
  registry.recipeRegistryFormat=2;await publish(registry);
});}

export function ensureRegistry(): Promise<BotsRegistry> {
  return ownBots(async registry => {
    const claimed = new Set<string>();
    const pending: BotEntry[] = [];
    for (const bot of registry.bots) {
      if (bot.badgeNumber && badgeNumberSchema.safeParse(bot.badgeNumber).success && !claimed.has(bot.badgeNumber)) {
        claimed.add(bot.badgeNumber);
      } else {
        pending.push(bot);
      }
    }
    const issuance = badgeIssuanceFor(registry);
    if (pending.length || issuance.usedFavorites.length !== (registry.badgeIssuance?.usedFavorites.length ?? 0)) {
      for (const bot of pending) {
        bot.badgeNumber = allocateBadgeNumber(issuance, claimed);
        claimed.add(bot.badgeNumber);
      }
      registry.badgeIssuance = issuance;
      await publish(registry);
    }
    return registry;
  });
}

/** Work on a copy: the next number is committed in the same publish as its bot. */
function badgeIssuanceFor(registry: BotsRegistry, newManualNumber?: string): BadgeIssuance {
  const stored = registry.badgeIssuance;
  if (stored !== undefined && (!stored || !Array.isArray(stored.usedFavorites)
    || stored.usedFavorites.length > BADGE_FAVORITES.length || !stored.usedFavorites.every(number => BADGE_FAVORITES.includes(number))
    || !Number.isInteger(stored.nextSequential) || stored.nextSequential < firstSequentialBadge || stored.nextSequential > lastSequentialBadge + 1)) {
    throw new Error('工号发放记录损坏，请检查 Bot 注册表。');
  }
  const used = new Set(stored?.usedFavorites);
  for (const bot of registry.bots) {
    if (bot.badgeNumber && BADGE_FAVORITES.includes(bot.badgeNumber)) used.add(bot.badgeNumber);
  }
  if (newManualNumber && BADGE_FAVORITES.includes(newManualNumber)) used.add(newManualNumber);
  return {usedFavorites: [...used], nextSequential: stored?.nextSequential ?? firstSequentialBadge};
}

function allocateBadgeNumber(issuance: BadgeIssuance, claimed: ReadonlySet<string>): string {
  const available = BADGE_FAVORITES.filter(number => !issuance.usedFavorites.includes(number));
  if (available.length) {
    const number = available[randomInt(available.length)]!;
    issuance.usedFavorites.push(number);
    return number;
  }
  for (let number = issuance.nextSequential; number <= lastSequentialBadge; number++) {
    if (!claimed.has(String(number))) {
      issuance.nextSequential = number + 1;
      return String(number);
    }
  }
  throw new Error('自动工号已发完（上限 9999999），无法分配新的工号。');
}

export function setBotBadgeNumber(appId: string, badgeNumber: string): Promise<{ok: true} | {ok: false; reason: string}> {
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === appId);
    if (!entry) return {ok: false, reason: '没有找到这个 Bot，请刷新后重试。'};
    if (!badgeNumberSchema.safeParse(badgeNumber).success) return {ok: false, reason: '请输入 1 至 7 位数字。'};
    if (registry.bots.some(bot => bot.appId !== appId && bot.badgeNumber === badgeNumber)) {
      return {ok: false, reason: '这个工号已有 Bot 使用。'};
    }
    if (entry.badgeNumber !== badgeNumber) {
      registry.badgeIssuance = badgeIssuanceFor(registry, badgeNumber);
      entry.badgeNumber = badgeNumber;
      await publish(registry);
    }
    return {ok: true};
  });
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

export function withRegisteredBot<T>(appId: string, operation: (identity: BotIdentity) => Promise<T>, expected?: BotIdentity): Promise<T> {
  return holdMutexRole('bots', () => ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === appId);
    if (!entry || (expected && !sameIdentity(entry, expected))) throw new Error('机器人已移除或重新注册');
    return operation(botIdentity(entry));
  }));
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
      const readyBot = await readyBotDirectory(registry, entry, input.projectsRootDir);
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
 * The bot's private-chat folder, `dm` in its stable directory (dm-agent 4.1; made on first use, like `groups`, so a bot
 * without a group gets its directory here). A fixed name under a directory only the bot allocates in, so unlike a
 * group's it needs no record of its own. A bot with no directory yet takes it under `projectsRootDir`, as its first
 * group would have. Making it again is a no-op.
 */
export function ensureBotDmDirectory(expected: BotIdentity, projectsRootDir: string): Promise<string> {
  const identity = { ...expected };
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry || !sameIdentity(entry, identity)) throw new Error('机器人已移除或重新注册，请重启');
    await assertBridgeImportReservation(paths.appDir, identity.appId);
    return directoryError(entry.name, async () => {
      let readyBot: Extract<Allocation, { state: 'ready' }>;
      try { readyBot = await readyBotDirectory(registry, entry, projectsRootDir); }
      catch (error) {
        // A restored data directory (or a new mount number after a restart) keeps these paths but not their
        // filesystem identities. Only this app-owned subtree can be reconciled without operator intervention.
        if (!(error instanceof Error && ['Namespace parent changed', 'Namespace directory changed'].includes(error.message))) throw error;
        const recovered = await recoverManagedBotDirectory(registry, entry);
        if (!recovered) throw error;
        readyBot = recovered;
      }
      const folder = join(readyBot.namespaceRoot, 'dm');
      await inspectDmDirectory(folder, true);
      await ensureDurableDirectory(folder, async () => {
        await verifyDirectory(readyBot, paths.appDir);
        await inspectDmDirectory(folder, true);
      });
      await inspectDmDirectory(folder, false);
      await verifyDirectory(readyBot, paths.appDir);
      return folder;
    });
  });
}

/** A DM leaf is app-owned too: never follow an existing link, including a dangling one. */
async function inspectDmDirectory(folder: string, allowMissing: boolean): Promise<void> {
  try {
    const entry = await lstat(folder);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Invalid namespace directory');
  } catch (error) {
    if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (await realpath(folder) !== folder) throw new Error('Namespace path changed');
}

/** The bot's stable directory, allocated under `projectsRootDir` when it has none, and checked or made; published. */
async function readyBotDirectory(registry: BotsRegistry, entry: BotEntry, projectsRootDir: string): Promise<Extract<Allocation, { state: 'ready' }>> {
  let bot = registry.allocations?.[entry.appId];
  if (!bot) {
    if (Object.keys(registry.allocations ?? {}).length >= 4096) throw new Error('Bot allocation limit reached');
    bot = await planAllocation({ ...entry, handle: entry.name, parent: projectsRootDir, dataDir: paths.appDir }, registry.allocations ?? {});
    registry.allocations = { ...registry.allocations, [entry.appId]: bot };
    await publish(registry);
  }
  validateAccountClaim(registry, bot, entry);
  const ready = await materializeBot(registry, bot);
  await publish(registry);
  return ready;
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

/** `others`: the registered bots under the same projects root whose records still name the root as it was. */
export type DirectoryRepair = { handle: string; recorded: number; missing: number; others: string[] };

/** Re-record a complete tree in memory. Callers publish only after every directory has passed their policy. */
async function recordBotTree(registry: BotsRegistry, allocation: Allocation, parentIdentity: ObjectIdentity,
  recordCurrent: typeof recordAt): Promise<Pick<DirectoryRepair, 'recorded' | 'missing'>> {
  const appId = allocation.appId;
  const result = { recorded: 0, missing: 0 };
  const count = (present: boolean): void => { if (present) result.recorded++; else result.missing++; };
  const bot = await recordCurrent(allocation, parentIdentity, paths.appDir);
  registry.allocations = { ...registry.allocations, [appId]: bot.record };
  count(bot.present);
  const container = registry.groupContainers?.[appId];
  if (bot.present && bot.record.state === 'ready' && container) {
    const groups = await recordCurrent(container, bot.record.object, paths.appDir);
    registry.groupContainers = { ...registry.groupContainers, [appId]: groups.record };
    count(groups.present);
    if (groups.present && groups.record.state === 'ready') {
      for (const [key, claim] of Object.entries(registry.groupAllocations ?? {})) {
        if (claim.appId !== appId) continue;
        const group = await recordCurrent(claim, groups.record.object, paths.appDir);
        registry.groupAllocations = { ...registry.groupAllocations, [key]: group.record };
        count(group.present);
      }
    }
  }
  return result;
}

/**
 * DM startup may repair restored identities only inside <data>/projects. Custom roots still require repair-dir.
 * Every existing directory must remain at its original canonical path, on the data volume, with no links or
 * occupied reservations. Check a clone, including the group ledger, so a rejected descendant changes no records.
 */
async function recoverManagedBotDirectory(registry: BotsRegistry, entry: BotEntry): Promise<Extract<Allocation, { state: 'ready' }> | undefined> {
  const allocation = registry.allocations?.[entry.appId];
  if (!allocation || allocation.state !== 'ready') return undefined;
  validateAccountClaim(registry, allocation, entry);
  const dataRoot = await realpath(paths.appDir);
  const parent = join(dataRoot, 'projects');
  if (allocation.parent !== parent || dirname(allocation.namespaceRoot) !== parent) return undefined;
  if (await realpath(parent) !== parent) return undefined;
  const parentIdentity = await directoryIdentity(parent);
  if (parentIdentity.dev !== (await directoryIdentity(dataRoot)).dev) return undefined;
  const checked: Extract<DirectoryClaim, { state: 'ready' }>[] = [];
  const recordManaged: typeof recordAt = async (record, owner, dataDir) => {
    // recordAt also rejects links and changes in ancestor paths, including dangling links.
    const current = await recordAt(record, owner, dataDir);
    if (current.present) {
      if (record.state !== 'ready') throw new Error('Reserved namespace already exists; recovery requires operator review');
      if (current.record.state !== 'ready' || current.record.object.dev !== parentIdentity.dev) throw new Error('Namespace directory changed');
      checked.push(current.record);
    }
    return current;
  };
  const next = structuredClone(registry);
  await recordBotTree(next, allocation, parentIdentity, recordManaged);
  const recovered = next.allocations?.[entry.appId];
  // A missing bot directory is handled by ordinary materialization, not by taking over another tree.
  if (!recovered || recovered.state !== 'ready' || !checked.some(record => record.namespaceRoot === recovered.namespaceRoot)) return undefined;
  for (const record of checked) await verifyDirectory(record, paths.appDir);
  await inspectDmDirectory(join(recovered.namespaceRoot, 'dm'), true);
  await publish(next);
  registry.allocations = next.allocations;
  registry.groupContainers = next.groupContainers;
  registry.groupAllocations = next.groupAllocations;
  return recovered;
}

/**
 * `vonvon bot repair-dir`: after a migration or a restore from backup, take the bot's directories at their recorded
 * paths as its own again: the bot directory, its `groups` and each group's. A directory that is gone keeps its record
 * and is made again on use. A bot found by name, app ID, or the handle a removed bot's allocation keeps. It repairs
 * one bot; the others under the same projects root are named, to run it for each. Its failures are told in Chinese,
 * a broken bots.json and a held lock included.
 */
export function repairBotDirectories(wanted: string): Promise<DirectoryRepair> {
  const target = String(wanted);
  return directoryError(target, () => ownBots(async registry => {
    const appId = registry.bots.find(bot => bot.name === target || bot.appId === target)?.appId
      ?? Object.values(registry.allocations ?? {}).find(record => record.handle === target || record.appId === target)?.appId;
    const allocation = appId === undefined ? undefined : registry.allocations?.[appId];
    if (!appId || !allocation) throw new Error(`没有找到「${target}」的目录记录：它不是这台电脑上注册的 bot，或者注册得早，还没分配过自己的目录。`);
    return directoryError(allocation.handle, async () => {
      const result: DirectoryRepair = { handle: allocation.handle, recorded: 0, missing: 0, others: [] };
      const recordCurrent: typeof recordAt = (record, parent, dataDir) => recordAt(record, parent, dataDir).catch((error: unknown) => {
        if (!(error instanceof Error && error.message === 'Namespace path changed')) throw error;
        throw new DirectoryError(`「${allocation.handle}」的目录位置变了（比如换成了链接），只能按原来的路径重新记录。把目录放回原处后再运行。`, { cause: error });
      });
      let parentIdentity: ObjectIdentity;
      try { parentIdentity = await directoryIdentity(allocation.parent); }
      catch (error) {
        // A link, a file or no permission is said as itself by directoryError.
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        throw new DirectoryError(`「${allocation.handle}」的目录所在的文件夹不在了（外接盘没接上的话，接上后重试）。`, { cause: error });
      }
      result.others = Object.values(registry.allocations ?? {}).filter(record => record.appId !== appId && record.parent === allocation.parent
        && !sameObject(record.parentIdentity, parentIdentity) && registry.bots.some(bot => bot.appId === record.appId)).map(record => record.handle);
      Object.assign(result, await recordBotTree(registry, allocation, parentIdentity, recordCurrent));
      await publish(registry);
      return result;
    });
  }));
}

type RegisterEntryResult = { kind: 'registered'; entry: BotEntry } | { kind: 'already-registered'; entry: BotEntry };
export type RegistrationCommit = Readonly<{
  entry: Readonly<BotEntry>; snapshot: Readonly<Partial<AppConfig>>;
  preferences: Readonly<AppPreferences> | undefined; namespaceRoot: string;
}>;
export function registerBotEntry(
  input: Pick<BotEntry, 'appId' | 'tenant' | 'botName'> & { desiredName: string; initialPreferences?: AppPreferences },
  persistAccount: (selected: RegistrationCommit) => Promise<void>,
  imported?: {txId: string; registrationId: string; onBeforePublish: (handle: string) => Promise<void>},
): Promise<RegisterEntryResult> {
  const identity = structuredClone(input);
  return ownBots(async registry => {
    await assertBridgeImportReservation(paths.appDir, identity.appId, imported?.txId);
    const previous = registry.bots.find(bot => bot.appId === identity.appId);
    if (previous && imported) throw new Error('Imported bot already registered');
    if (previous) return { kind: 'already-registered', entry: previous };
    if (!SafeAppIdSchema.safeParse(identity.appId).success) throw new Error('Invalid bot app ID');
    const issuance = badgeIssuanceFor(registry);
    const claimed = new Set(registry.bots.flatMap(bot => bot.badgeNumber ? [bot.badgeNumber] : []));
    const badgeNumber = allocateBadgeNumber(issuance, claimed);
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
    await imported?.onBeforePublish(allocation.handle);
    // Re-publish visible intent before a retry can create or trust its directory.
    await publish(registry);
    const pending = allocation;
    allocation = await directoryError(pending.handle, () => materializeBot(registry, pending));
    await publish(registry);
    const entry: BotEntry = { appId: identity.appId, tenant: identity.tenant, botName: identity.botName, badgeNumber,
      name: allocation.handle, createdAt: Date.now(), registrationId: imported?.registrationId ?? randomUUID() };
    await persistAccount(Object.freeze({ entry: Object.freeze({ ...entry }), snapshot: structuredClone(snapshot),
      preferences: structuredClone(preferences), namespaceRoot: allocation.namespaceRoot }));
    registry.bots.push(entry);
    registry.badgeIssuance = issuance;
    registry.current ??= entry.appId;
    await publish(registry);
    return { kind: 'registered', entry };
  });
}

/** Import admission shares the same interprocess mutex as ordinary registration. */
export function reserveImportedBots(appIds: readonly string[], reserve: () => Promise<void>): Promise<void> {
  return ownBots(async registry => {
    if (registry.bots.some(bot => appIds.includes(bot.appId)) || appIds.some(id => registry.allocations?.[id])) throw new Error('Bot destination conflict');
    await reserve();
  });
}
export function unregisterImportedBots(entries: readonly {appId: string; registrationId: string; handle?: string}[]): Promise<void> {
  return ownBots(async registry => {
    registry.badgeIssuance = badgeIssuanceFor(registry);
    for (const entry of entries) {
      const existing = registry.bots.find(bot => bot.appId === entry.appId);
      if (existing && existing.registrationId !== entry.registrationId) throw new Error('Imported registration ownership changed');
      registry.bots = registry.bots.filter(bot => bot.appId !== entry.appId);
      const allocation = registry.allocations?.[entry.appId];
      if (allocation && allocation.handle === entry.handle) delete registry.allocations![entry.appId];
    }
    if (!registry.bots.some(bot => bot.appId === registry.current)) registry.current = registry.bots.find(bot => bot.active)?.appId ?? registry.bots[0]?.appId;
    await publish(registry);
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
    if (!registry.bots.some(bot => bot.appId === appId)) throw new Error(`Bot「${appId}」不存在。`);
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
    await assertBridgeImportReservation(paths.appDir, identity.appId);
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry) return { kind: 'missing' };
    if (!sameIdentity(entry, identity)) return { kind: 'stale' };
    if (await callbacks.isRunning()) return { kind: 'running' };
    if (activeBots(registry).some(bot => bot.appId === identity.appId)) return { kind: 'active' };
    const allocation = registry.allocations?.[entry.appId];
    if (allocation) validateAccountClaim(registry, allocation, entry);
    registry.badgeIssuance = badgeIssuanceFor(registry);
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
    await assertBridgeImportReservation(paths.appDir, identity.appId);
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry || !sameIdentity(entry, identity)) return 'stale';
    await persist();
    return 'committed';
  });
}

/**
 * The bot was renamed in Feishu: its display name follows what `bot/v3/info` now says. Only `botName` changes; the
 * handle (`name`, its directory) and the appId stay. A bot removed or registered again meanwhile is left alone.
 */
export function updateBotName(expected: BotIdentity, botName: string): Promise<'updated' | 'unchanged' | 'stale'> {
  const identity = { ...expected };
  return ownBots(async registry => {
    const entry = registry.bots.find(bot => bot.appId === identity.appId);
    if (!entry || !sameIdentity(entry, identity)) return 'stale';
    if (entry.botName === botName) return 'unchanged';
    entry.botName = botName;
    await publish(registry);
    return 'updated';
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
