import {
  checkUpdate,
  currentVersion,
  daemonRunning,
  installLatest,
  isDevSource,
  isNewer,
  latestVersion,
  packageName,
  readUpdateStatus,
  restartDaemon,
  UpdateBusyError,
} from '../../service/update';
import { desktopDownloadNoticeForHost } from '../../service/desktop-release';
import { runtimeDistribution, type Distribution } from '../../service/distribution';
import { coreUpdateStatusText, type CoreUpdateStatus, type MachineReply } from '@vonvon/protocol';
import { paths } from '../../config/paths';
import { readRunningPidLock } from '../../server/pid-lock';
import { VERSION } from '../../service/current-release';
import { checkStandaloneUpdate, REFUSAL_TEXT, startStandaloneUpdate, type ApplyDeps, type Refusal, type StandaloneCheck } from '../../service/standalone-update';
import { badArgs, CommandError } from '../command-error';
import { print, withDaemon, type Daemon, type Io } from '../daemon-client';

function printDesktopGuidance(): void {
  const notice = desktopDownloadNoticeForHost();
  if (notice) console.log(`\n${notice}`);
}

/**
 * Self-update to the latest npm release and, if a background daemon is running,
 * restart it so the new code takes effect. With `--check`, only report whether a
 * newer version exists (no install).
 */
export async function runUpdate(opts: { check?: boolean } = {}): Promise<void> {
  const distribution = await runtimeDistribution();
  if (distribution.kind === 'bundled') {
    console.log('这个命令行随 Vonvon Bot 桌面应用提供，请在桌面应用里更新。');
    return;
  }
  try {
    await runCliUpdate(opts);
  } finally {
    printDesktopGuidance();
  }
}

async function runCliUpdate(opts: { check?: boolean }): Promise<void> {
  const pkg = packageName();
  const current = currentVersion();
  console.log(`当前版本：v${current}`);
  console.log('查询最新版本…');
  const latest = await latestVersion();

  if (!latest) {
    console.log('⚠️ 查不到最新版本（网络或 npm registry 问题）。');
    process.exitCode = 1;
    return;
  }
  if (!isNewer(latest, current)) {
    console.log(`✓ 已是最新版本（v${current}）。`);
    return;
  }

  console.log(`发现新版本：v${current} → v${latest}`);
  if (opts.check) {
    console.log(`运行 \`npm i -g ${pkg}@latest\` 安装更新，再用 \`vonvon daemon restart\` 重启后台服务。`);
    return;
  }
  if (isDevSource()) {
    console.log('检测到源码开发模式（仓库内有 .git）。请用：git pull && npm i —— 跳过全局安装。');
    return;
  }

  console.log(`开始全局安装最新版（npm i -g ${pkg}@latest）…`);
  const res = await installLatest({ inherit: true });
  if (!res.ok) {
    console.log(`❌ 安装失败：${res.message}`);
    console.log(`可在终端手动执行：npm i -g ${pkg}@latest`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 已更新到 v${latest}`);

  if (daemonRunning()) {
    console.log('重启后台服务以加载新版本…');
    try {
      await restartDaemon();
      console.log('✓ 后台服务已重启，新版本已生效。');
    } catch (err) {
      console.log(`⚠️ 自动重启失败：${err instanceof Error ? err.message : String(err)}`);
      console.log('请手动执行：vonvon daemon restart');
    }
  } else {
    console.log('未检测到运行中的后台 daemon；下次 `start` / `run` 即用新版本。');
  }
}

// ── `vonvon update` (server-3 4.8) ──────────────────────────────────────────────────────────────────────────────
export type UpdateCommandOptions = { check?: boolean; allowDowngrade?: boolean; to?: string };
export type UpdateCommandDeps = {
  distribution: () => Promise<Distribution>;
  daemonRunning: () => Promise<boolean>;
  daemon: Daemon;
  readStatus: () => CoreUpdateStatus | null;
  now: () => number;
  pause: (ms: number) => Promise<void>;
  /** The standalone update run here, when no daemon does it. */
  local: (installRoot: string) => ApplyDeps;
};
const defaultDeps = (): UpdateCommandDeps => ({
  distribution: runtimeDistribution,
  daemonRunning: async () => Boolean((await readRunningPidLock(paths.appDir).catch(() => null))?.listen),
  daemon: fn => withDaemon(fn),
  readStatus: readUpdateStatus,
  now: Date.now,
  pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
  local: installRoot => ({ installRoot, currentVersion: currentVersion() }),
});
/** After the daemon goes away to restart, how long `update-status.json` is read for the outcome (4.6 60 + 25 s, and more). */
export const OUTCOME_WAIT_MS = 120_000;

type CheckReply = Extract<MachineReply, { type: 'coreUpdate' }> | (StandaloneCheck & { source: 'local' });
function checkLine(reply: CheckReply): string {
  if (reply.refused) return `当前 ${reply.current}，${REFUSAL_TEXT[reply.refused as Refusal] ?? `没查到新版本：${reply.refused}`}`;
  if (reply.latest === null) return `当前 ${reply.current}，没查到最新版本`;
  return reply.hasUpdate ? `当前 ${reply.current}，最新 ${reply.latest}（有新版本，运行 vonvon update 更新）` : `当前 ${reply.current}，已是最新`;
}

/** Prints each change of the status: a JSON line `{ event: 'status', … }`, or a line of text at each step and 10 %. */
function statusPrinter(io: Io, since: number) {
  let last = '';
  return (status: CoreUpdateStatus | null): CoreUpdateStatus | null => {
    if (!status || status.at < since) return null; // an earlier update's record
    const tenth = status.progress && status.progress.total > 0 ? Math.floor(status.progress.transferred / status.progress.total * 10) : -1;
    const key = JSON.stringify([status.phase, status.detail, status.message, io.json ? status.progress?.transferred : tenth]);
    if (key !== last) {
      last = key;
      io.write(io.json ? `${JSON.stringify({ event: 'status', ...status })}\n` : `${coreUpdateStatusText(status)}\n`);
    }
    return status;
  };
}

function outcome(io: Io, status: CoreUpdateStatus): void {
  if (status.phase === 'error') {
    const back = status.rolledBack && status.previous && !status.message?.includes('已切回') ? `（已切回 ${status.previous}）` : '';
    throw new CommandError('failed', `更新没有完成：${status.message ?? '原因不明'}${back}`, { partial: { status } });
  }
  const line = status.message === '已是最新' ? `已是最新（${status.to ?? status.from}）` : status.message?.includes('daemon start') ? status.message : `已更新到 ${status.to}`;
  print(io, [line], { status });
}

export async function runUpdateCommand(options: UpdateCommandOptions, io: Io, deps: UpdateCommandDeps = defaultDeps()): Promise<void> {
  if (options.allowDowngrade && options.to === undefined) throw badArgs('--allow-downgrade 要和 --to <版本> 一起用。');
  if (options.to !== undefined && !VERSION.test(options.to)) throw badArgs(`--to 要写成 1.2.3 这样的版本号，不是「${options.to}」。`);
  const distribution = await deps.distribution();
  const running = await deps.daemonRunning();
  if (distribution.kind === 'development') throw new CommandError('refused', '源码开发态不升级：在仓库里 git pull && npm i。');
  if (distribution.kind === 'global-npm') {
    if (options.to !== undefined) throw badArgs('全局 npm 安装只能更新到最新版，不能指定版本。');
    if (!io.json) return runUpdate({ check: options.check });
    const found = await checkUpdate();
    if (options.check || !found.hasUpdate || found.dev) { print(io, [], { distribution: distribution.kind, ...found }); return; }
    const installed = await installLatest();
    if (!installed.ok) throw new CommandError('failed', `安装失败：${installed.message}`);
    print(io, [], { distribution: distribution.kind, ...found, updated: true });
    return;
  }
  // bundled: the desktop shell updates it, through the daemon (U4); with no daemon running, the desktop app does.
  if (distribution.kind !== 'standalone' && !(distribution.kind === 'bundled' && running)) {
    throw new CommandError('refused', distribution.kind === 'bundled' ? '这个命令行随 Vonvon Bot 桌面应用提供，请在桌面应用里更新。' : '这个安装方式不能用 vonvon update 更新。');
  }
  const installRoot = distribution.kind === 'standalone' ? distribution.installRoot : undefined;
  if (options.check) {
    const reply: CheckReply = running
      ? await deps.daemon(async call => {
        const answer = await call('检查更新', c => c.machine({ type: 'checkCoreUpdate' }));
        if (answer.type !== 'coreUpdate') throw new CommandError('failed', `检查更新没有完成：daemon 回了意外的结果（${answer.type}）。`);
        return answer;
      })
      : { ...await checkStandaloneUpdate(deps.local(installRoot!)), source: 'local' as const };
    print(io, [checkLine(reply)], reply);
    return;
  }
  const since = deps.now() - 2000;
  const show = statusPrinter(io, since);
  const wanted = { ...(options.to !== undefined ? { version: options.to } : {}), ...(options.allowDowngrade ? { allowDowngrade: true } : {}) };
  if (!running) {
    let job: ReturnType<typeof startStandaloneUpdate>;
    try { job = startStandaloneUpdate(wanted, deps.local(installRoot!)); }
    catch (error) { if (error instanceof UpdateBusyError) throw new CommandError('conflict', error.message); throw error; }
    let settled: CoreUpdateStatus | undefined;
    void job.done.then(status => { settled = status; });
    while (!settled) { show(deps.readStatus()); await deps.pause(500); }
    show(settled);
    outcome(io, settled);
    return;
  }
  let accepted = false;
  try {
    const ended = await deps.daemon(async call => {
      const started = await call('开始更新', c => c.machine({ type: 'applyCoreUpdate', ...wanted }));
      if (started.type !== 'done') throw new CommandError('failed', `更新没有开始：daemon 回了意外的结果（${started.type}）。`);
      accepted = true;
      for (;;) {
        const reply = await call('读更新进度', c => c.machine({ type: 'coreUpdateStatus' }));
        const status = show(reply.type === 'coreUpdateStatus' ? reply.status : null);
        if (status?.phase === 'done' || status?.phase === 'error') return status;
        await deps.pause(500);
      }
    });
    outcome(io, ended);
    return;
  } catch (error) {
    // The daemon closes every connection when it drains to restart: the rest is in update-status.json.
    if (!accepted || !(error instanceof CommandError) || (error.kind !== 'connection' && error.kind !== 'outcome-unknown')) throw error;
  }
  const until = deps.now() + OUTCOME_WAIT_MS;
  while (deps.now() < until) {
    const status = show(deps.readStatus());
    if (status?.phase === 'done' || status?.phase === 'error') { outcome(io, status); return; }
    await deps.pause(500);
  }
  throw new CommandError('outcome-unknown', '更新的结果还没出来。稍后运行 vonvon update --check 或 vonvon daemon status 查看。');
}
