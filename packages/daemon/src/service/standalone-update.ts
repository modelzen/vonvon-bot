import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { log } from '../core/logger';
import { paths } from '../config/paths';
import { isGeneratedGetter } from '../config/data-compatibility';
import { ensureSecretsGetterWrapper, secretsGetterContents } from '../config/store';
import { STEADY_OWNER_MS } from '../host/restart';
import { extractTarGz, removeStaging } from './archive';
import { isCompleteRelease, readCurrent, switchCurrent, VERSION } from './current-release';
import { nearestPackageRoot } from './distribution';
import { fetchManifest, ManifestError, readServerUpdateConfig, serverTarget, type Fetch, type Manifest, type ServerUpdateConfig } from './standalone-manifest';
import { acquireUpdateLock, finishOwnedUpdate, isNewer, livePid, readUpdateStatus, tryUpdateLock, UpdateBusyError, writeUpdateStatus, type UpdateStatus } from './update';

/**
 * The standalone server's update (server-3 4.4, 4.5): check the signed stable manifest, and apply it by downloading
 * the package into `releases/<v>.part`, checking it against the manifest, unpacking, renaming it to `releases/<v>` and
 * switching `current` before the daemon drains and restarts. Progress is in `update-status.json`.
 */
export type Refusal = 'rollback' | 'signature' | 'network' | 'config' | 'state';
export const REFUSAL_TEXT: Record<Refusal, string> = {
  signature: '没查到新版本：发布清单的签名不对，没有应用',
  rollback: '没查到新版本：发布清单比上次看到的旧，没有应用',
  network: '没查到新版本：连不上 dl.vonvon.cc',
  config: '没查到新版本：这个服务端包没有带发布清单的公钥',
  state: '没查到新版本：读写不了本机的更新记录 update-state.json，没有应用',
};
export type StandaloneCheck = { current: string; latest: string | null; hasUpdate: boolean; channel: 'stable'; refused?: Refusal };
export type StandaloneDeps = {
  installRoot: string;
  currentVersion: string;
  config?: () => ServerUpdateConfig | null;
  fetch?: Fetch;
  now?: () => number;
  platform?: NodeJS.Platform;
  arch?: string;
};
const EVENTS = 'core-update';

/** `app/server-update.json` of the running package; no setting or variable points anywhere else (C2). */
export const packagedUpdateConfig = (): ServerUpdateConfig | null =>
  readServerUpdateConfig(join(nearestPackageRoot(fileURLToPath(import.meta.url)), 'server-update.json'));

// ── C4 update-state.json: the highest version and publish time seen, so an older signed manifest is refused ─────
const stateSchema = z.object({ v: z.literal(1), highestSeen: z.string().regex(VERSION), lastPublishedAt: z.number().nonnegative(), lastCheckAt: z.number().nonnegative() }).strict();
type UpdateState = z.infer<typeof stateSchema>;
const stateFile = (installRoot: string): string => join(installRoot, 'update-state.json');

/** Not ENOENT and not bad JSON: the record may hold a higher version than this check could tell, so nothing is accepted. */
class StateUnusable extends Error {}
const errorCode = (error: unknown): string => (error instanceof Error && 'code' in error ? String(error.code) : 'error');

async function readState(installRoot: string, current: string): Promise<UpdateState> {
  const baseline: UpdateState = { v: 1, highestSeen: current, lastPublishedAt: 0, lastCheckAt: 0 };
  let text: string;
  try { text = await readFile(stateFile(installRoot), 'utf8'); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return baseline; // the first check
    log.warn(EVENTS, 'update-state-unreadable', { code: errorCode(error) });
    throw new StateUnusable();
  }
  try { return stateSchema.parse(JSON.parse(text)); }
  catch {
    log.warn(EVENTS, 'update-state-unreadable', { code: 'invalid' });
    // Kept aside before the baseline is written over it.
    await copyFile(stateFile(installRoot), `${stateFile(installRoot)}.invalid`).catch(() => undefined);
    return baseline;
  }
}
async function writeState(installRoot: string, state: UpdateState): Promise<void> {
  // Each writer its own temporary file: a shared one is renamed away under the second writer.
  const temporary = `${stateFile(installRoot)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, stateFile(installRoot));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    log.warn(EVENTS, 'update-state-unwritable', { code: errorCode(error) });
    throw new StateUnusable();
  }
}
/** The daily check, the page's 检查 and an update read and write `update-state.json` one at a time in this process. */
let stateTurn: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = stateTurn.then(work, work);
  stateTurn = run.catch(() => undefined);
  return run;
}
// Daemons of different data directories share the install root and so this record (review 206): the read, compare and
// write also hold `update-state.lock` beside it. The lock is update-lock.ts's (review 220): a live holder is never
// taken over, however long it holds, so a check that cannot get it in time fails closed with `refused: 'state'`.
const STATE_LOCK_WAIT_MS = 15_000;
async function withStateLock<T>(installRoot: string, work: () => Promise<T>): Promise<T> {
  const file = join(installRoot, 'update-state.lock');
  let release: () => void;
  for (const deadline = Date.now() + STATE_LOCK_WAIT_MS; ;) {
    const attempt = tryUpdateLock(file);
    if (typeof attempt === 'function') { release = attempt; break; }
    if (attempt !== 'busy' || Date.now() > deadline) {
      log.warn(EVENTS, 'update-state-unwritable', { code: attempt === 'busy' ? 'EBUSY' : errorCode(attempt) });
      throw new StateUnusable();
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  try { return await work(); }
  finally { release(); }
}

async function readManifest(deps: StandaloneDeps): Promise<{ check: StandaloneCheck; manifest?: Manifest }> {
  const base = { current: deps.currentVersion, latest: null, hasUpdate: false, channel: 'stable' as const };
  const config = (deps.config ?? packagedUpdateConfig)();
  if (!config) {
    log.warn(EVENTS, 'update-config-missing', {});
    return { check: { ...base, refused: 'config' } };
  }
  let manifest: Manifest;
  try { manifest = await fetchManifest(config, deps.fetch); }
  catch (error) {
    const reason = error instanceof ManifestError ? error.reason : 'http';
    log.warn(EVENTS, 'update-manifest-refused', { reason });
    return { check: { ...base, refused: reason === 'http' ? 'network' : 'signature' } };
  }
  return inTurn(() => withStateLock(deps.installRoot, async () => {
    const state = await readState(deps.installRoot, deps.currentVersion);
    // Equal is accepted: the same manifest read again, or one whose update did not go through.
    if (manifest.publishedAt < state.lastPublishedAt || isNewer(state.highestSeen, manifest.version)) {
      log.warn(EVENTS, 'update-manifest-refused', { reason: 'rollback', version: manifest.version, highestSeen: state.highestSeen });
      return { check: { ...base, refused: 'rollback' as const } };
    }
    await writeState(deps.installRoot, {
      v: 1, highestSeen: isNewer(manifest.version, state.highestSeen) ? manifest.version : state.highestSeen,
      lastPublishedAt: Math.max(state.lastPublishedAt, manifest.publishedAt), lastCheckAt: (deps.now ?? Date.now)(),
    });
    // latest even when it is this version: the page shows "已是最新 0.9.0".
    return { check: { ...base, latest: manifest.version, hasUpdate: isNewer(manifest.version, deps.currentVersion) }, manifest };
  })).catch(error => { if (error instanceof StateUnusable) return { check: { ...base, refused: 'state' as const } }; throw error; });
}

let lastCheck: StandaloneCheck | undefined;
export async function checkStandaloneUpdate(deps: StandaloneDeps): Promise<StandaloneCheck> {
  lastCheck = (await readManifest(deps)).check;
  return lastCheck;
}
/** What the daily check last found, for `checkCoreUpdate { fresh: false }`. */
export const lastStandaloneCheck = (): StandaloneCheck | undefined => lastCheck;

const DAY = 24 * 3_600_000;
/** 60 s after start, then every 24 h, only to show "有新版本"; a failed check waits for the next one. Never applies. */
export function scheduleStandaloneChecks(deps: StandaloneDeps & { setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout }): () => void {
  const schedule = deps.setTimeout ?? setTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const next = (delay: number): void => {
    timer = schedule(() => {
      if (stopped) return;
      next(DAY);
      void checkStandaloneUpdate(deps).catch(error => log.fail(EVENTS, error, { phase: 'daily-check' }));
    }, delay);
    timer.unref?.();
  };
  next(60_000);
  return () => { stopped = true; (deps.clearTimeout ?? clearTimeout)(timer); };
}

// ── 4.5 apply ─────────────────────────────────────────────────────────────────────────────────────────────────
export type ApplyOptions = { version?: string; allowDowngrade?: boolean };
export type ApplyDeps = StandaloneDeps & {
  /** The daemon's drain and restart. Without it (the CLI with no daemon running) the update ends at the switch. */
  requestRestart?: (status: UpdateStatus) => void;
  /** The daemon already stops or restarts: no update starts, and none switches `current` any more. */
  stopping?: () => boolean;
  /** Some daemon process holds the pid lock (the CLI asks): a `restarting` record may still be someone's. */
  ownerAlive?: boolean;
  extract?: (archive: string, into: string) => Promise<void>;
  /** Sees each record written, in order. */
  onStatus?: (status: UpdateStatus) => void;
};
class Failure extends Error {}

/** How long a standalone `restarting` record nobody has taken yet still holds off another update. */
export const RESTART_PENDING_MS = 10 * 60_000;
/**
 * A standalone update that switched `current` and asked for the restart is not over until the helper or the new
 * daemon ends its record: another update meanwhile would overwrite it, and the helper would neither roll back nor
 * say done (server-3 review F1). While the old daemon drains, it refuses through `stopping`; once it is gone, the
 * helper holds `update.lock`. In between, and when the helper was lost before it took the record, the record's age
 * decides; a live pid-lock owner (a daemon still starting) keeps it pending whatever its age.
 */
export function restartPending(status: UpdateStatus | null, now: number, ownerAlive = false): boolean {
  if (status?.phase !== 'restarting' || status.previous === undefined) return false;
  // `waiting`: the helper took the record and holds `update.lock` until the outcome; with the lock free here, it is gone.
  return ownerAlive || (status.detail !== 'waiting' && now - status.at < RESTART_PENDING_MS);
}
/** What the user reads for an error that is not ours: a file system error by its code, never by the paths it names. */
const failureText = (error: unknown, installRoot: string): string => {
  const code = errorCode(error);
  if (code !== 'error') return `更新失败：${code}`;
  return `更新失败：${(error instanceof Error ? error.message : String(error)).split(installRoot).join('<安装目录>')}`;
};

/** Complete releases kept besides the current one, newest first. */
async function keptReleases(installRoot: string, current: string | undefined): Promise<string[]> {
  const names = await readdir(join(installRoot, 'releases')).catch(() => [] as string[]);
  const kept: string[] = [];
  for (const name of names) if (name !== current && await isCompleteRelease(installRoot, name)) kept.push(name);
  return kept.sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Daemons of every data directory share `releases/` (the check after review 207): what writes or clears it holds this. */
export const acquireReleasesLock = (installRoot: string): (() => void) | null => acquireUpdateLock(join(installRoot, 'releases.lock'));

/**
 * Takes `update.lock` and `releases.lock` and writes `installing` before it returns, or throws UpdateBusyError (a lock
 * is busy, the daemon already stops or restarts, or an earlier update's restart has not ended); the work goes on in
 * `done`. The locks are released before `requestRestart`, which may itself end the record (a stop that cancels the
 * restart); the `restarting` record keeps other updates off from then on (restartPending).
 */
export function startStandaloneUpdate(options: ApplyOptions, deps: ApplyDeps): { done: Promise<UpdateStatus> } {
  const busy = '服务端正在重启或停止，这次不更新；等它起来后再试。';
  if (deps.stopping?.()) throw new UpdateBusyError(busy);
  const own = acquireUpdateLock();
  const shared = own && acquireReleasesLock(deps.installRoot);
  if (!own || !shared) { own?.(); throw new UpdateBusyError(); }
  const release = (): void => { shared(); own(); };
  const at = (deps.now ?? Date.now)();
  const pending = readUpdateStatus();
  if (restartPending(pending, at, deps.ownerAlive)) {
    release();
    throw new UpdateBusyError(`上一次更新（到 ${pending?.to ?? '新版本'}）还在等重启的结果，等它有结果再试。`);
  }
  const root = deps.installRoot;
  const platform = deps.platform ?? process.platform;
  const fetcher = deps.fetch ?? fetch;
  const from = deps.currentVersion;
  let status: UpdateStatus = { phase: 'installing', from, at, detail: options.allowDowngrade ? 'switching' : 'downloading' };
  const write = (next: UpdateStatus): UpdateStatus => { status = next; writeUpdateStatus(next); deps.onStatus?.(next); return next; };
  const step = (detail: UpdateStatus['detail'], extra: Partial<UpdateStatus> = {}): UpdateStatus => write({ phase: 'installing', from, at, detail, ...extra });
  write(status);

  const download = async (manifest: Manifest, version: string): Promise<void> => {
    const target = serverTarget(platform, deps.arch);
    if (!target) throw new Failure(`这台电脑（${platform}-${deps.arch ?? process.arch}）没有对应的服务端包。`);
    const file = manifest.files[target];
    const staging = join(root, 'releases', `${version}.part`);
    await removeStaging(root, version);
    try {
      await mkdir(staging, { recursive: true });
      const archive = join(staging, 'download.tar.gz');
      let response: Response;
      try { response = await fetcher(file.url, { signal: AbortSignal.timeout(600_000) }); }
      catch (error) { throw new Failure(`下载失败：${error instanceof Error ? error.message : String(error)}`); }
      const length = response.headers.get('content-length');
      if (response.status !== 200 || !response.body || (length !== null && Number(length) !== file.size)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Failure(response.status !== 200 ? `下载失败：HTTP ${response.status}` : '下载的大小和发布清单不一致');
      }
      const hash = createHash('sha512');
      let transferred = 0;
      let reported = 0;
      const handle = await open(archive, 'wx', 0o600);
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          transferred += chunk.byteLength;
          if (transferred > file.size) throw new Failure('下载的大小和发布清单不一致');
          hash.update(chunk);
          await handle.write(chunk);
          if (transferred - reported >= 1024 * 1024) { reported = transferred; step('downloading', { progress: { transferred, total: file.size } }); }
        }
      } catch (error) {
        throw error instanceof Failure ? error : new Failure(`下载失败：${error instanceof Error ? error.message : String(error)}`);
      } finally { await handle.close(); }
      step('verifying', { progress: { transferred, total: file.size } });
      if (transferred !== file.size || hash.digest('hex') !== file.sha512) throw new Failure('下载内容和发布清单不一致');
      log.info(EVENTS, 'update-standalone-downloaded', { version, size: file.size });
      step('unpacking');
      await (deps.extract ?? extractTarGz)(archive, staging);
      await rm(archive, { force: true });
      const node = join(staging, 'node', 'bin', 'node');
      const marker = await readFile(join(staging, 'standalone.json'), 'utf8').then(text => JSON.parse(text) as { version?: unknown }, () => ({}) as { version?: unknown });
      if (marker.version !== version || !await isFile(join(staging, 'app', 'bin', 'vonvon.mjs')) || !await isFile(node)) throw new Failure('下载的服务端包不完整。');
      await chmod(node, 0o755);
      await rename(staging, join(root, 'releases', version));
    } catch (error) {
      // Whatever stopped it, a refusal of ours or an I/O error in the unpacker (review 220): the `.part` this run made
      // goes, never a half release; the complete releases beside it are not touched (removeStaging names only `.part`).
      await removeStaging(root, version).catch(() => undefined);
      throw error;
    }
  };

  const done = (async (): Promise<UpdateStatus> => {
    let version: string | undefined;
    try {
      const current = (await readCurrent(root))?.version;
      if (options.allowDowngrade) {
        version = options.version;
        if (!version) throw new Failure('降级要写明版本：--allow-downgrade --to <版本>。');
        if (version === from) return write({ phase: 'done', ok: true, from, to: version, at, message: `已经是 ${version}，不用切换。` });
        // No signed manifest vouches for an older package, so only a release still kept here is used.
        if (!await isCompleteRelease(root, version)) {
          const [previous] = await keptReleases(root, current);
          throw new Failure(previous ? `本机没有 ${version}，只能降到保留着的上一版 ${previous}。` : `本机没有 ${version}，也没有保留着的上一版。`);
        }
      } else {
        const { check, manifest } = await readManifest(deps);
        if (check.refused || !manifest) throw new Failure(REFUSAL_TEXT[check.refused ?? 'network']);
        if (options.version && options.version !== manifest.version) throw new Failure(`发布清单上的版本是 ${manifest.version}，不是 ${options.version}。`);
        if (!check.hasUpdate) return write({ phase: 'done', ok: true, from, to: manifest.version, at, message: '已是最新' });
        version = manifest.version;
        // Downloaded before and not switched to: used as it is.
        if (await isCompleteRelease(root, version)) await removeStaging(root, version);
        else await download(manifest, version);
      }
      // A rollback goes back to the release running now, not to what `current` named: that may be `version` itself
      // (a switch whose restart did not happen, or the install script's).
      const prior = await isCompleteRelease(root, from) ? from
        : current !== undefined && current !== version && await isCompleteRelease(root, current) ? current : undefined;
      if (!prior) throw new Failure(`本机找不到正在运行的 ${from} 的完整目录，切过去以后没有能退回的版本，这次不更新。`);
      step('switching', { to: version });
      if (deps.stopping?.()) throw new Failure('服务端开始停止或重启了，这次没有切换版本；下载好的版本留着，下次更新直接用。');
      await switchCurrent(root, version);
      log.info(EVENTS, 'update-standalone-swapped', { from, to: version, previous: prior });
      if (!deps.requestRestart) return write({ phase: 'done', ok: true, from, to: version, previous: prior, at, message: `已切到 ${version}，运行 vonvon daemon start 生效。` });
      const restarting = write({ phase: 'restarting', ok: true, from, to: version, previous: prior, at, detail: 'draining' });
      release();
      deps.requestRestart(restarting);
      return restarting;
    } catch (error) {
      log.fail(EVENTS, error, { phase: 'apply', ...(version ? { to: version } : {}) });
      const message = error instanceof Failure ? error.message : failureText(error, root);
      return write({ phase: 'error', ok: false, from, ...(version ? { to: version } : {}), at, message: message.slice(0, 300) });
    } finally { release(); }
  })();
  return { done };
}

// ── 4.6, 4.10 at startup ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Daemons of other data directories run from the same `releases/` (the check after review 207): each notes the release
 * it runs as `running/<pid>-<version>`, and a restart helper the release it may go back to. A cleanup keeps what live
 * processes noted and drops the notes of dead ones.
 */
export async function noteRunning(installRoot: string, version: string): Promise<void> {
  try {
    await mkdir(join(installRoot, 'running'), { recursive: true });
    await writeFile(join(installRoot, 'running', `${process.pid}-${version}`), '');
  } catch (error) { log.warn(EVENTS, 'update-running-unwritable', { code: errorCode(error) }); }
}
async function runningVersions(installRoot: string): Promise<string[]> {
  const dir = join(installRoot, 'running');
  const versions: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const [, pid, version] = /^([1-9]\d*)-(\d+\.\d+\.\d+)$/.exec(name) ?? [];
    if (!pid || !version) continue;
    if (livePid(Number(pid))) versions.push(version);
    else await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
  return versions;
}

/**
 * Keeps the given releases, the one `current` names and those live processes run (noteRunning); removes other versions
 * and every `.part`. Only direct children of `releases/` named like a version, real directories, holding
 * `standalone.json` or named `.part`. A directory that cannot be removed is left for the next start, and so is all of
 * it while an update holds `releases.lock`, when `current` cannot be read, or while this data directory's getter is not
 * on it.
 *
 * `current` is read here, under `releases.lock` (review 221): every switch to a newly unpacked release holds that lock
 * (startStandaloneUpdate), so what is read is what stays current until the lock goes. The caller's `keep` may be older
 * than that: another data directory's update can switch `current` between the caller's read and this lock, or while a
 * restart helper waits. Every standalone getter and service definition goes through `current`, so the release it
 * names must never go.
 */
export async function cleanupReleases(installRoot: string, keep: ReadonlyArray<string | undefined>, remove: (dir: string) => Promise<void> = dir => rm(dir, { recursive: true })): Promise<void> {
  const release = acquireReleasesLock(installRoot);
  if (!release) return;
  try {
    let current: Awaited<ReturnType<typeof readCurrent>>;
    try { current = await readCurrent(installRoot); }
    catch (error) { log.warn(EVENTS, 'update-cleanup-skipped', { name: 'current', code: errorCode(error) }); return; }
    // This data directory's getter still naming a release (its rewrite at startup failed) keeps every release.
    const getter = await ownGetter(installRoot);
    if (getter === 'stale' || getter === 'unreadable') { log.warn(EVENTS, 'update-cleanup-skipped', { name: 'getter', code: getter }); return; }
    const kept = [...keep, current?.version, ...await runningVersions(installRoot)];
    const releases = join(installRoot, 'releases');
    for (const name of await readdir(releases).catch(() => [] as string[])) {
      const match = /^(\d+\.\d+\.\d+)(\.part)?$/.exec(name);
      if (!match || (!match[2] && kept.includes(match[1]))) continue;
      const dir = join(releases, name);
      try {
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || dirname(dir) !== releases) continue;
        if (!match[2] && !await isFile(join(dir, 'standalone.json'))) continue;
        await remove(dir);
      } catch (error) {
        log.warn(EVENTS, 'update-cleanup-skipped', { name, code: errorCode(error) });
      }
    }
  } finally { release(); }
}

/**
 * This data directory's secrets getter and `current` (reviews 207, 221). Only a standalone build before I3b wrote a
 * getter naming its own release (`releases/<v>`), and none was published: the first server package, 0.9.0, has this
 * code. A getter of ours is told by its header (isGeneratedGetter), never by finding the install root's path in its
 * text, which the shell quoting changes when the path holds `'`. 'other' is none, or not ours: nothing to keep for it.
 */
async function ownGetter(installRoot: string): Promise<'current' | 'other' | 'stale' | 'unreadable'> {
  let text: string;
  try { text = await readFile(paths.secretsGetterScript, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'EISDIR'].includes(errorCode(error))) return 'other';
    log.warn(EVENTS, 'update-getter-unreadable', { code: errorCode(error) });
    return 'unreadable';
  }
  if (!isGeneratedGetter(text)) return 'other';
  return text === secretsGetterContents(installRoot) ? 'current' : 'stale';
}
/** A getter of ours that names anything but `current` is rewritten at startup, before any cleanup. */
async function moveGetterToCurrent(installRoot: string): Promise<void> {
  if (await ownGetter(installRoot) !== 'stale') return;
  await ensureSecretsGetterWrapper(installRoot).catch(error => log.fail(EVENTS, error, { phase: 'getter' }));
}

/**
 * The new daemon, once it publishes its port: this data directory's getter goes onto `current`; an `installing` record
 * nobody holds the lock for was cut short; a standalone `restarting` record for this version is done (unless `current`
 * was moved back meanwhile); then releases besides the current and previous one, and those live daemons of other data
 * directories run, go.
 */
export async function settleUpdateAtStartup(options: { version: string; installRoot?: string; alive?: () => boolean; pause?: (ms: number) => Promise<void> }): Promise<void> {
  if (options.installRoot) await moveGetterToCurrent(options.installRoot);
  const status = readUpdateStatus();
  if (status?.phase === 'installing') {
    const release = acquireUpdateLock();
    if (release) {
      try { if (readUpdateStatus()?.at === status.at) writeUpdateStatus({ phase: 'error', ok: false, from: status.from, ...(status.to ? { to: status.to } : {}), at: Date.now(), message: '上次更新中断' }); }
      finally { release(); }
    }
  }
  // U4: an update the desktop app ran for the server it carries. The new app stopped the old server and started this one;
  // there is no helper to roll back, so no steady wait, and no install root.
  if (status?.phase === 'restarting' && status.via === 'desktop') {
    if (status.to === undefined || status.to === options.version) finishOwnedUpdate(status, 'done');
    else finishOwnedUpdate(status, 'error', `重启后仍是 ${options.version}`);
  }
  if (!options.installRoot) return;
  await noteRunning(options.installRoot, options.version);
  // A restart is ended only once this process has stayed up as long as the helper watches a new owner (review 207):
  // one that listens and dies at once leaves the record to the helper, which then switches back.
  if (status?.phase === 'restarting') await (options.pause ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); })))(STEADY_OWNER_MS);
  if (options.alive?.() === false) return;
  const current = await readCurrent(options.installRoot).catch(() => null);
  if (status?.phase === 'restarting' && status.previous !== undefined) {
    if (status.to !== options.version) finishOwnedUpdate(status, 'error', `重启后仍是 ${options.version}`);
    else if (current?.version !== options.version) finishOwnedUpdate(status, 'error', `升级和回滚撞上了，当前运行 ${options.version}`);
    else finishOwnedUpdate(status, 'done');
  }
  if (!current) return;
  const release = acquireUpdateLock();
  if (!release) return; // an update of this data directory is under way
  try {
    const latest = readUpdateStatus();
    // Never the current release itself: a record naming it would leave no release to go back to.
    const candidates = [latest?.to === current.version ? latest.previous : undefined, ...await keptReleases(options.installRoot, current.version)];
    const previous = candidates.find(version => version !== undefined && version !== current.version);
    await cleanupReleases(options.installRoot, [current.version, previous]);
  } finally { release(); }
}
