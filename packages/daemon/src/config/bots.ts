import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths, botDir } from './paths';
import { loadConfig } from './store';
import { isComplete, type TenantBrand } from './schema';
import { acquireMutex, closeMutex } from './data-access';

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
}

const emptyRegistry = (): BotsRegistry => ({ version: 1, bots: [] });

export async function loadBots(): Promise<BotsRegistry> {
  try {
    const text = await readFile(paths.botsFile, 'utf8');
    const reg = JSON.parse(text) as BotsRegistry;
    return { ...reg, version: 1, current: reg.current, bots: Array.isArray(reg.bots) ? reg.bots : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw err;
  }
}

async function publish(reg: BotsRegistry): Promise<void> {
  await mkdir(dirname(paths.botsFile), { recursive: true });
  const tmp = `${paths.botsFile}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, paths.botsFile);
}

/**
 * Return the registry, migrating a legacy single-bot install on first run: if
 * there's no bots.json yet but a complete flat `~/.feishu-codex-bridge/config.json`
 * exists, move its config/projects/sessions/processes into `bots/<appId>/` and
 * register it as `default` (current). Idempotent — a no-op once bots.json exists.
 */
async function loadOrMigrate(): Promise<BotsRegistry> {
  if (existsSync(paths.botsFile)) return loadBots();

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
    await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
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
export function registerBotEntry(
  input: Pick<BotEntry, 'appId' | 'tenant' | 'botName'> & { desiredName: string },
  persistAccount: (selected: Readonly<BotEntry>) => Promise<void>,
): Promise<RegisterEntryResult> {
  const identity = { ...input };
  return ownBots(async registry => {
    const previous = registry.bots.find(bot => bot.appId === identity.appId);
    if (previous) return { kind: 'already-registered', entry: previous };
    const entry: BotEntry = { appId: identity.appId, tenant: identity.tenant, botName: identity.botName,
      name: uniqueName(registry, identity.desiredName), createdAt: Date.now(), registrationId: randomUUID() };
    await persistAccount(Object.freeze({ ...entry }));
    registry.bots.push(entry);
    registry.current ??= entry.appId;
    await publish(registry);
    return { kind: 'registered', entry };
  });
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
  if (!reg.bots.some((b) => b.name === base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!reg.bots.some((b) => b.name === candidate)) return candidate;
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
