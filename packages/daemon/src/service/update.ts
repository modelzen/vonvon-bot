import {runtimeDistribution} from './distribution';
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths';
import { spawnProcess } from '../platform/spawn';
import { SERVICE_UNAVAILABLE } from '../host/service';
import { log } from '../core/logger';
import { z } from 'zod';

// `npm` via cross-spawn: on Windows it's an `npm.cmd` shim that a bare
// spawn/execFile would reject with EINVAL (CVE-2024-27980); cross-spawn runs it,
// and spawnProcess hides the console window (important when the background
// service triggers a one-click update with no console of its own).
const NPM = 'npm';

/**
 * The installed package's own root. After bundling, every source module's
 * `import.meta.url` resolves to dist/cli.js, so its parent is the package root —
 * the same layout in a global install (.../node_modules/<pkg>/) and a local
 * checkout. We read package.json from here for both the current version and the
 * canonical package name (so a rename can't drift the npm target).
 */
function pkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function pkgJson(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(pkgRoot(), 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
  } catch {
    return {};
  }
}

export function currentVersion(): string {
  return pkgJson().version ?? '0.0.0';
}

export function packageName(): string {
  return pkgJson().name ?? 'vonvon-bot';
}

/**
 * Running from a git checkout (the repo root has a .git) rather than an npm
 * install. `npm i -g` would not update that working copy, so callers should
 * steer the user to `git pull && npm i` instead.
 */
export function isDevSource(): boolean {
  return existsSync(join(pkgRoot(), '.git'));
}

/** semver-ish compare: is `a` strictly newer than `b`? (major.minor.patch) */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Latest published version on the configured registry, or null if unreachable. */
export async function latestVersion(): Promise<string | null> {
  const v = await new Promise<string | null>((resolveP) => {
    const child = spawnProcess(NPM, ['view', packageName(), 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 20000);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      failed = true;
      if (child.pid === undefined) resolveP(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP(code === 0 && !failed ? out.trim() : null);
    });
  });
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  dev: boolean;
}

export async function checkUpdate(): Promise<UpdateCheck> {
  const current = currentVersion();
  const latest = await latestVersion();
  return { current, latest, hasUpdate: !!latest && isNewer(latest, current), dev: isDevSource() };
}

export interface InstallResult {
  ok: boolean;
  /** tail of npm's combined output (capture mode) or a short status line */
  message: string;
}

/**
 * Run `npm install -g <pkg>@latest`. Async (spawn, never spawnSync) so card
 * callbacks can call it without freezing the bridge's event loop. With
 * `inherit`, npm's progress streams straight to the terminal (CLI use); without
 * it, output is captured and the tail returned for surfacing in a card.
 */
export async function installLatest(opts: { inherit?: boolean } = {}): Promise<InstallResult> {
  if ((await runtimeDistribution()).kind !== 'global-npm') return {ok:false,message:'当前 Core 不属于全局 npm 安装，请更新所属桌面应用或源码。'};
  const target = `${packageName()}@latest`;
  return await new Promise<InstallResult>((resolveP) => {
    const child = spawnProcess(NPM, ['install', '-g', target], {
      stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    if (!opts.inherit) {
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
    }
    let failure: Error | undefined;
    child.on('error', (error) => {
      failure = error;
      if (child.pid === undefined) resolveP({ ok: false, message: error.message });
    });
    child.on('close', (code) => {
      const tail = out.trim().slice(-600);
      resolveP({ ok: code === 0 && !failure, message: failure?.message ?? (opts.inherit ? `退出码 ${code}` : tail || `退出码 ${code}`) });
    });
  });
}

export async function performCoreUpdate(options: { install?: typeof installLatest } = {}): Promise<UpdateStatus> {
  const release = acquireUpdateLock();
  if (!release) throw new Error('A Core update is already in progress.');
  const from = currentVersion();
  clearUpdateStatus();
  writeUpdateStatus({ phase: 'installing', from, at: Date.now() });
  try {
    const result = await (options.install ?? installLatest)();
    if (!result.ok) throw new Error(result.message);
    const record = Object.freeze({ phase: 'restarting', ok: true, from, to: currentVersion(), at: Date.now() } satisfies UpdateStatus);
    writeUpdateStatus(record);
    return record;
  } catch (error) {
    writeUpdateStatus({ phase: 'error', ok: false, from, message: (error instanceof Error ? error.message : String(error)).slice(0, 300), at: Date.now() });
    throw error;
  } finally {
    release();
  }
}

// ── 更新互斥锁（B）+ 更新结果状态（D）────────────────────────────────────────
// 都落在 appDir，供跨进程协作：Web「升级」跑在 detached helper 里、私聊「更新」跑在
// daemon 里，两者可能并发。锁防止两个 `npm i -g` 并发把全局目录装坏；状态文件给
// helper 的结果一个 daemon 能读、Web 能轮询的落点（否则 helper 失败对网页端静默）。

function updateLockFile(): string {
  return join(paths.appDir, 'update.lock');
}

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程在、只是本进程无权 signal → 仍算活。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isUpdateLockStale(file: string): boolean {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; at?: number };
    if (typeof rec.pid !== 'number') return true; // 无 pid → 损坏，可回收
    if (!livePid(rec.pid)) return true; // 持有者已死 → 优先回收（不受时钟影响）
    return false;
  } catch {
    return true; // 损坏/读不出 → 可回收
  }
}

/** A live update owns the lock until it exits or releases it, without an age limit. */
export function acquireUpdateLock(): (() => void) | null {
  const file = updateLockFile();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx'); // O_EXCL：创建即占有，创建失败即已存在
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return releaseUpdateLock(file); // 只删「属于自己」的锁，绝不误删他人的
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null; // EACCES/ENOSPC/… → 当作拿不到锁，绝不 throw
      if (!isUpdateLockStale(file)) return null;
      try {
        rmSync(file, { force: true }); // 回收陈旧锁后重试 wx 创建
      } catch {
        /* 可能被别人抢先回收，交给下一轮 */
      }
    }
  }
  return null; // 连续抢回收都输 → 当作进行中（安全：绝不并发 npm）
}

/** release：只在锁文件仍指向自己时删——避免删掉「回收了本进程陈旧锁后的新持有者」的锁。 */
function releaseUpdateLock(file: string): () => void {
  return () => {
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
      if (rec.pid !== process.pid) return; // 不是自己的锁（已被回收/换主）→ 别动
    } catch {
      /* 损坏/已不存在 → 落到下面尽力删（force 对不存在无害） */
    }
    try {
      rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
  };
}

/** What a standalone update is doing inside its phase (server-3 C3). */
export const updateDetails = ['downloading', 'verifying', 'unpacking', 'switching', 'draining', 'waiting', 'rolled-back'] as const;
export const updateStatusSchema = z.object({
  phase: z.enum(['installing', 'restarting', 'done', 'error']),
  ok: z.boolean().optional(), message: z.string().optional(),
  from: z.string().optional(), to: z.string().optional(), at: z.number(),
  /** The release a standalone update switched `current` away from: the one a rollback goes back to. */
  previous: z.string().optional(),
  progress: z.object({ transferred: z.number().nonnegative(), total: z.number().nonnegative() }).strict().optional(),
  detail: z.enum(updateDetails).optional(),
  rolledBack: z.boolean().optional(),
}).strict();
export type UpdateStatus = Readonly<z.infer<typeof updateStatusSchema>>;
export type UpdatePhase = UpdateStatus['phase'];

/** A Core update already holds `update.lock`. */
export class UpdateBusyError extends Error {
  constructor() { super('已有更新正在进行。'); }
}

const OWNED_FIELDS = ['phase', 'ok', 'message', 'from', 'to', 'at', 'previous', 'detail', 'rolledBack'] as const;

/** Ends `expected` only while the file is still that record; returns what it wrote. */
export function finishOwnedUpdate(expected: UpdateStatus | undefined, outcome: 'done' | 'error', message?: string, extra: { rolledBack?: boolean } = {}): UpdateStatus | undefined {
  if (!expected) return undefined;
  const release = acquireUpdateLock();
  if (!release) { log.info('daemon-restart', 'update_record_ownership_lost', { reason: 'lock_busy' }); return undefined; }
  try {
    const current = readUpdateStatus();
    if (!current || OWNED_FIELDS.some(field => current[field] !== expected[field])) {
      log.info('daemon-restart', 'update_record_ownership_lost', { reason: 'record_changed' });
      return undefined;
    }
    const { progress: _progress, detail: _detail, ...kept } = expected;
    const record: UpdateStatus = { ...kept, phase: outcome, ok: outcome === 'done', ...(message ? { message } : {}), ...extra, at: Date.now() };
    writeUpdateStatus(record);
    return record;
  } finally { release(); }
}

function updateStatusFile(): string {
  return join(paths.appDir, 'update-status.json');
}

/**
 * 记录更新进度/结果，供 Web 控制台轮询显示（尤其失败——否则 detached helper 的失败对
 * 网页端完全静默）。同步、尽力而为、绝不抛。
 */
export function writeUpdateStatus(status: UpdateStatus): void {
  const file = updateStatusFile();
  try {
    // Whole-file replace: a reader polling it never sees half a record.
    writeFileSync(`${file}.tmp`, JSON.stringify(status), 'utf8');
    renameSync(`${file}.tmp`, file);
  } catch {
    /* best-effort */
  }
}

export function readUpdateStatus(): UpdateStatus | null {
  try {
    const result = updateStatusSchema.safeParse(JSON.parse(readFileSync(updateStatusFile(), 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** 清掉上一次的更新结果——Web 提交新升级前调用，之后读到的状态才确定属于本次。 */
export function clearUpdateStatus(): void {
  try {
    rmSync(updateStatusFile(), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Is the OS background service currently running? Platform-aware (launchd on
 * macOS, Task Scheduler on Windows); false on platforms without a service.
 */
export function daemonRunning(): boolean {
  return false;
}

/**
 * Restart the background daemon so it reloads the freshly-installed code. When
 * invoked from a card handler the running process *is* that daemon, so this kill
 * terminates the caller — send any "done" UI before calling it.
 */
export async function restartDaemon(): Promise<void> {
  throw new Error(SERVICE_UNAVAILABLE);
}
