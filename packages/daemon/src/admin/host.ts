import type {Distribution} from '../service/distribution';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, platform, release } from 'node:os';
import { paths } from '../config/paths';
import { bridgeVersion } from '../core/version';
import {
  visibleCatalog,
  createBackend,
  effectiveDefaultBackend,
  isInstallable,
  isBackendEntryInstalled,
  type BackendCatalogEntry,
} from '../agent';
import type { BackendDepState } from '../agent/types';
import type { UpdateCheck } from '../service/update';

/** daemon 生命周期快照（GET /api/daemon）。V2 前台进程的 pid/版本/时长。 */
export interface DaemonStatus {
  distribution?: Distribution;
  platformName?: string;
  installed: boolean;
  /** 当前内嵌 Web 的 daemon 进程正在运行。 */
  running: boolean;
  /** 当前 daemon 为前台进程。 */
  selfHosted: boolean;
  /** 当前前台 daemon 的实际 PID。 */
  pid?: number;
  lastExit?: string;
  /** 当前运行的 bridge 版本（package.json）。 */
  version: string;
  /** 本进程（内嵌 web 的 daemon 进程）已运行毫秒数；只读预览进程为 undefined。 */
  uptimeMs?: number;
  servicePath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  /** 当前运行时是否支持服务管理。V2 为 false。 */
  supported: boolean;
}

/** 宿主机体检（GET /api/host-doctor）：后端环境 + Node/平台/路径/日志体量。 */
export interface HostDoctor {
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
  appDir: string;
  /** 日志目录绝对路径。 */
  logsDir: string;
  /** 磁盘上日志总字节数（logs/ 目录递归累加；读不到为 0）。 */
  logBytes: number;
  /** 当前 bridge 版本。 */
  version: string;
}

export function toDaemonStatus(opts: {
  foreground?: { pid: number; startedAt: number };
  version: string;
  now?: number;
}): DaemonStatus {
  return {
    installed: false,
    running: opts.foreground !== undefined,
    selfHosted: opts.foreground !== undefined,
    pid: opts.foreground?.pid,
    version: opts.version,
    uptimeMs: opts.foreground ? Math.max(0, (opts.now ?? Date.now()) - opts.foreground.startedAt) : undefined,
    supported: false,
  };
}

/** 递归累加目录字节数（读不到的项跳过，绝不抛错）。 */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (st.isDirectory()) total += await dirBytes(full);
      else if (st.isFile()) total += st.size;
    } catch {
      /* 单项读不到（权限/竞态）→ 跳过 */
    }
  }
  return total;
}

/** 宿主机体检聚合（绝不抛错）。后端探测由调用方（service 层复用 doctorBackends）
 * 单独并发；这里只管 Node/平台/路径/日志体量这部分宿主机域。 */
export async function collectHostDoctor(logsDir: string = join(paths.appDir, 'logs')): Promise<HostDoctor> {
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    appDir: paths.appDir,
    logsDir,
    logBytes: await dirBytes(logsDir),
    version: bridgeVersion(),
  };
}

/**
 * 一条后端体检行（Web 后端页 / 宿主机体检共用）：catalog 元数据 + doctor 三态 +
 * 依赖安装态。从 catalog 渲染（不硬编码列表）；新后端注册到 catalog 即自动出现。
 */
export interface BackendDoctorRow {
  id: string;
  /** catalog displayName */
  name: string;
  /** agent 家族（picker 分组用） */
  agentFamily: string;
  /** 接入方式短名（app-server / sdk / acp） */
  access: string;
  ok: boolean;
  version: string | null;
  location?: string;
  hint?: string;
  /** 依赖安装态三态（installed / not-installed / external-missing） */
  depState: BackendDepState;
  /** 可一键按需下载（npm-ondemand 且当前未装） */
  installable: boolean;
  /** 体积提示 MB（installable 时给下载确认用） */
  approxSizeMB?: number;
  /** 手动装法 / 下载旁注 */
  installCmd?: string;
  /** 全局有效默认后端 */
  isDefault: boolean;
}

/**
 * 一条 catalog 的依赖安装态（doctor.ok 不直接等于装了——已装未登录也 ok:false，所以
 * 安装态单独由 catalog dep + 解析判定）：
 *   npm-ondemand —— 解析得到包 = installed，否则 not-installed（可一键下载）。
 *   external-cli / npm-external —— 不在此探解析（走 PATH / 握手），按 probe.ok：
 *     ok = installed，否则 external-missing（手动装）。
 */
function depStateFor(entry: BackendCatalogEntry, ok: boolean): BackendDepState {
  if (entry.dep.kind === 'npm-ondemand') {
    // bin 类（claude-pty-acp）查 .bin、库类（SDK）查 require.resolve——统一走 isBackendEntryInstalled。
    return isBackendEntryInstalled(entry) ? 'installed' : 'not-installed';
  }
  return ok ? 'installed' : 'external-missing';
}

/**
 * 后端体检聚合（从 catalog 渲染 + 每条带 depState/installable）。绝不抛错——
 * 每条 doctor 独立降级（force 探「现在」的状态）。service.ts 的 doctorBackends /
 * probeAllBackends 复用它（host.ts 是宿主机域聚合的单一出口）。
 */
export async function doctorBackends(): Promise<BackendDoctorRow[]> {
  const def = await effectiveDefaultBackend({ force: true }).catch(() => undefined);
  return Promise.all(
    visibleCatalog().map(async (entry) => {
      const probe = await createBackend(entry.id)
        .doctor({ force: true })
        .catch(() => undefined);
      const ok = probe?.ok === true;
      const installable = isInstallable(entry) && !ok;
      const depState = depStateFor(entry, ok);
      return {
        id: entry.id,
        name: entry.displayName,
        agentFamily: entry.agentFamily,
        access: entry.access,
        ok,
        version: probe?.version ?? null,
        location: probe?.location,
        hint: ok ? undefined : (probe?.hint ?? entry.dep.detectHint),
        depState,
        installable,
        approxSizeMB: entry.dep.approxSizeMB,
        installCmd: entry.dep.installCmd,
        isDefault: entry.id === def,
      };
    }),
  );
}

/**
 * 绝对路径到本包的 bin 入口（与 service/common.resolveCliBinPath 同算法）。打包后
 * 本模块在 dist/，bin 在 ../bin/feishu-codex-bridge.mjs——全局安装与本地 checkout
 * 同布局。detached helper 必须用绝对路径起（脱离本进程后 cwd / PATH 不可依赖）。
 */
export function resolveCliBinPath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return resolve(distDir, '..', 'bin', 'feishu-codex-bridge.mjs');
}

export type DaemonControlAction = 'restart' | 'update' | 'start' | 'stop';

/**
 * 构建 detached helper 的 spawn 命令（纯函数，exported for tests）：用当前 Node
 * 执行 bin 入口的内部子命令 `__daemon-control <action>`。该 helper 进程
 * detached + unref，与 web 进程脱钩——即便本 daemon 随后被 service stop 杀掉，
 * helper 仍会把 service 重新拉起（restart），或先 npm i -g 再重启（update）。
 *
 * 不直接 spawn `npm` / `launchctl`：把全部逻辑收进 helper 子命令，命令面最小
 * （只一个固定 action 形参），无任意字符串拼进 shell，天然无注入面。
 */
export function buildDaemonControlCommand(
  action: DaemonControlAction,
  binPath: string = resolveCliBinPath(),
  nodePath: string = process.execPath,
): { command: string; args: string[] } {
  return { command: nodePath, args: [binPath, '__daemon-control', action] };
}

export type { UpdateCheck };
