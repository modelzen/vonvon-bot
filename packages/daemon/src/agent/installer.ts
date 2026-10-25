import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { npmInvocation } from '../platform/npm';
import { spawnProcess } from '../platform/spawn';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { isBackendPackageInUserDir } from './backend-loader';
import { fixNativeHelperPerms } from './native-helpers';

/**
 * 按需后端依赖的安装执行器（npm-ondemand 包；Claude SDK 使用此托管安装流程）。
 *
 * 装到用户私装目录 {@link paths.backendsDir}（永远用户可写，零 sudo/brew——见
 * design/backend-catalog-ondemand.md §2.2 方案A）。流程：
 *   ① 确保 backendsDir 有 package.json（npm `--prefix` 目录必须有 package.json
 *      才不向上回溯查找——实验 D；首次写一个最小 private 包等价 `npm init`）。
 *   ② spawn `npm install <pkg> --prefix backendsDir --include=optional`（--include=optional
 *      拉平台二进制——实验 F）。npm 用 {@link npmInvocation}：桌面应用自带的 npm 由本进程的
 *      Node 执行，没装 Node 的 Mac 也能装；npm 安装版用 PATH 上的 npm。
 *      stdout/stderr 逐块流给 onProgress（Web SSE / DM 卡轮询的进度源）。
 *
 * 可取消：传 AbortSignal，abort 时 kill npm 子进程并清半装子目录回滚。
 * 限纯 JS / 自带 prebuild 二进制的包（catalog 的 npm-ondemand 标注保证）——不触发
 * 本机原生编译，所以无需 build 工具链。
 */

let mutationTail: Promise<void> = Promise.resolve();
let queuePosition = 0;

function enqueueMutation<T>(kind: 'install' | 'uninstall', pkg: string, run: () => Promise<T>): Promise<T> {
  const position = ++queuePosition;
  const result = mutationTail.then(run);
  mutationTail = result.then(() => undefined, () => undefined);
  log.info('backend-queue', 'reserved', { kind, pkg, position });
  return result;
}

/** 查 npm registry 上某包的最新版本（`npm view <pkg> version`）。用于后端「检查更新」。
 *  8s 后尝试终止 npm，等待 close 后返回；失败时返回 null。 */
export async function latestNpmVersion(pkg: string, timeoutMs = 8000): Promise<string | null> {
  const bare = stripVersion(pkg);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      const npm = npmInvocation();
      child = spawnProcess(npm.command, [...npm.args, 'view', bare, 'version', '--no-fund', '--no-audit'], {
        stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...npm.env },
      });
    } catch {
      resolve(null);
      return;
    }
    let failed = false;
    child.on('error', () => { failed = true; });
    const pid = child.pid;
    if (pid === undefined) {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      failed = true;
      try { child.kill('SIGTERM'); } catch { }
      log.info('backend-version', 'term_sent', { pkg, pid });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const v = out.trim().split('\n').pop()?.trim() ?? '';
      resolve(!failed && code === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : null);
    });
  });
}

/** 安装结果：ok + npm 退出码 + 合并输出尾部（失败时给用户看的诊断）。 */
export interface InstallResult {
  ok: boolean;
  /** npm 进程退出码（被取消时为 null） */
  code: number | null;
  /** 是否被 AbortSignal 取消 */
  aborted: boolean;
  /** 合并 stdout/stderr 的尾部（最多 ~2KB，失败诊断用） */
  tail: string;
}

/** 进度回调：npm 每输出一块就回调一次（已按行无关，原样字符串块）。 */
export type InstallProgress = (chunk: string) => void;

/** backendsDir 里要写的最小 package.json（让 npm `--prefix` 不向上回溯——实验 D）。 */
const BACKENDS_PACKAGE_JSON = JSON.stringify(
  { name: 'feishu-codex-bridge-backends', private: true, version: '0.0.0' },
  null,
  2,
);

/** 确保 backendsDir 存在且有最小 package.json（幂等；已存在不覆写，保留 npm 写的锁等）。 */
async function ensureBackendsDir(): Promise<void> {
  await mkdir(paths.backendsDir, { recursive: true });
  const pkgFile = join(paths.backendsDir, 'package.json');
  if (!existsSync(pkgFile)) {
    await writeFile(pkgFile, `${BACKENDS_PACKAGE_JSON}\n`, 'utf8');
  }
}

/**
 * 构建 `npm install` 命令（纯函数，exported for tests——单测只验命令构建，不真跑 npm）。
 * 装进 backendsDir、拉平台二进制、用桥的 npm 缓存目录、关进度条（避免流里乱码）。
 *
 * **用默认 --save（不加 --no-save）**：backendsDir 是多后端共享的一个 node_modules + 一个
 * package.json。npm install 会按 package.json reconcile，把「不在 package.json 里」的包当
 * extraneous 删掉。所以若用 --no-save + 最小 package.json，装第二个后端会把第一个 prune
 * 掉（实测：装第二个后端后第一个的 .bin 消失）——后端变互斥。默认 --save 把每个装过的包
 * 记进 package.json，多后端因此**共存**：从空目录装一个后端只有它自己，之后再装另一个
 * 两者并存（按需下载、各自体积如实呈现）。代价是「重装/修复一个」会按 package.json
 * 重装全部（缓存热则已装的近乎 no-op）。卸载见 {@link uninstallBackendDep}（连带 --save 移除
 * package.json 条目，避免下次装别的又把它带回）。
 */
export function buildInstallCommand(
  pkg: string,
  opts: { prefix?: string; cacheDir?: string; npm?: ReturnType<typeof npmInvocation> } = {},
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const prefix = opts.prefix ?? paths.backendsDir;
  const cacheDir = opts.cacheDir ?? paths.npmCacheDir;
  const npm = opts.npm ?? npmInvocation();
  return {
    command: npm.command,
    args: [
      ...npm.args,
      'install',
      pkg,
      '--prefix',
      prefix,
      '--include=optional',
      '--no-audit',
      '--no-fund',
      '--no-progress',
      '--cache',
      cacheDir,
    ],
    env: npm.env,
  };
}

/**
 * 按需安装一个后端依赖到用户私装目录。绝不抛错——失败落 {@link InstallResult}.ok=false
 * （HTTP/卡片层据 tail 给诊断）。装完用用户目录的存在性校验；校验不过即视为失败
 * 并回滚半装子目录。可取消（signal.abort → kill npm + 回滚）。
 *
 * @param pkg     npm 包名（catalog 的 installSpec.pkg；可带 @version）
 * @param onProgress npm 输出流回调（每块）
 * @param signal  取消信号（abort → kill 子进程 + rm 半装子目录）
 * @param opts.binName  bin 类后端的 bin 名。给了 ⇒ 安装后校验走
 *   node_modules/.bin 存在性而非 require.resolve（bin-only 包无 main 入口，resolve 必失败）。
 */
export function installBackendDep(
  pkg: string,
  onProgress?: InstallProgress,
  signal?: AbortSignal,
  opts?: { binName?: string },
): Promise<InstallResult> {
  return enqueueMutation('install', pkg, () => installInTurn(pkg, onProgress, signal, opts));
}

async function installInTurn(
  pkg: string,
  onProgress?: InstallProgress,
  signal?: AbortSignal,
  opts?: { binName?: string },
): Promise<InstallResult> {
  if (signal?.aborted) return { ok: false, code: null, aborted: true, tail: '安装已取消' };
  // 包名去掉版本后缀（@scope/name@1.2.3 → @scope/name）用于回滚定位 + 校验。
  const bareName = stripVersion(pkg);
  try {
    await ensureBackendsDir();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.fail('agent', err, { phase: 'backend-install-mkdir', pkg });
    return { ok: false, code: null, aborted: false, tail: `创建后端目录失败：${msg}` };
  }

  if (signal?.aborted) {
    return { ok: false, code: null, aborted: true, tail: '安装已取消' };
  }

  const npm = npmInvocation();
  const { command, args, env } = buildInstallCommand(pkg, { npm });
  log.info('agent', 'backend-install-start', { pkg, npm: npm.args[0] ?? 'PATH' });

  const result = await new Promise<InstallResult>((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, code: null, aborted: false, tail: `spawn npm 失败：${msg}` });
      return;
    }

    let out = '';
    const capture = (s: string): void => {
      if (!s) return;
      out += s;
      if (out.length > 8192) out = out.slice(-8192);
      onProgress?.(s);
    };
    const decode = (stream: typeof child.stdout): (() => void) => {
      const decoder = new StringDecoder('utf8');
      let ended = false;
      const flush = (): void => {
        if (ended) return;
        ended = true;
        capture(decoder.end());
      };
      stream?.on('data', (data: Buffer) => capture(decoder.write(data)));
      stream?.once('end', flush);
      return flush;
    };
    const flushStdout = decode(child.stdout);
    const flushStderr = decode(child.stderr);

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let childError: Error | undefined;
    child.on('error', (error) => { childError = error; });
    child.on('close', (code) => {
      flushStdout();
      flushStderr();
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: code === 0 && !aborted && !childError, code, aborted, tail: (out + (childError?.message ?? '')).slice(-2000) });
    });
  });

  // 取消 / 退出码非零 → 回滚半装子目录（避免 resolve 假阳性放行一个加载会炸的包）。
  if (!result.ok) {
    await rollback(bareName);
    log.warn('agent', 'backend-install-failed', { pkg, code: result.code, aborted: result.aborted });
    return result;
  }

  const verifyOk = isBackendPackageInUserDir(bareName, opts?.binName);
  if (!verifyOk) {
    await rollback(bareName);
    log.warn('agent', 'backend-install-unverified', { pkg });
    return {
      ok: false,
      code: result.code,
      aborted: false,
      tail: `${result.tail}\n\n安装后校验失败：「${bareName}」${opts?.binName ? '.bin 里找不到可执行' : '用户目录里找不到 package.json'}（可能半装/平台二进制缺失），已尝试回滚。`,
    };
  }

  // 治本：修 node-pty spawn-helper 的可执行位（npm 安装偶发丢 +x → posix_spawnp
  // failed）。在 verify 通过后跑——绝不抛错，不影响安装结果。
  await fixNativeHelperPerms().catch(() => undefined);

  log.info('agent', 'backend-install-done', { pkg });
  return result;
}

/** 卸载一个按需后端依赖（省空间 / 重装前清理）。绝不抛错。
 * npm 负责同步 package.json / lockfile 并回收不再使用的依赖（包括 hoisted 平台二进制）；
 * 仍被其他已安装后端使用的共享依赖保留。整个 npm 进程和校验都持有同一个 mutation 队列位置。 */
export type UninstallResult = 'not-installed' | 'uninstalled' | 'failed';

export function uninstallBackendDep(pkg: string, opts?: { binName?: string }): Promise<UninstallResult> {
  return enqueueMutation('uninstall', pkg, async () => {
    const bareName = stripVersion(pkg);
    if (!isBackendPackageInUserDir(bareName, opts?.binName)) return 'not-installed';
    try {
      await ensureBackendsDir();
      const npm = npmInvocation();
      const args = [
        ...npm.args, 'uninstall', bareName, '--prefix', paths.backendsDir,
        '--save', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress',
        '--cache', paths.npmCacheDir,
      ];
      log.info('agent', 'backend-uninstall-start', { pkg, npm: npm.args[0] ?? 'PATH' });
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawnProcess(npm.command, args, { stdio: 'ignore', env: { ...process.env, ...npm.env } });
        let failed = false;
        child.on('error', () => { failed = true; });
        // 等 close 后才释放共享前缀，失败时也不能和下一次安装同时修改 node_modules。
        child.on('close', (code) => resolve(code === 0 && !failed));
      });
      if (!ok || isBackendPackageInUserDir(bareName, opts?.binName)) {
        log.warn('agent', 'backend-uninstall-failed', { pkg });
        return 'failed';
      }
      log.info('agent', 'backend-uninstall-done', { pkg });
      return 'uninstalled';
    } catch (err) {
      log.fail('agent', err, { phase: 'backend-uninstall', pkg });
      return 'failed';
    }
  });
}

/** rm -rf backendsDir/node_modules/<pkg> + 从 package.json 移除条目 + 删 package-lock.json
 * （安装失败后的半装回滚；显式卸载由 npm 处理完整依赖树）。绝不抛错。 */
async function rollback(bareName: string): Promise<void> {
  // scoped 包名（@scope/name）是两级目录，rm 整个包目录即可（@scope 空壳无害留着）。
  const target = join(paths.backendsDir, 'node_modules', ...bareName.split('/'));
  await rm(target, { recursive: true, force: true }).catch(() => undefined);
  // 连带从 package.json 删依赖条目——否则下次装别的后端时 npm 按 package.json reconcile
  // 又把它拉回来（默认 --save 把装过的都记进 package.json，多后端靠它共存；卸载就得反向清）。
  await removeBackendsDep(bareName);
  // 关键：删掉 package-lock.json。否则 lock 仍记着「<pkg> 已装」，下次 `npm i <pkg>` 会以为
  // 已满足、只「added 1 package」而**不恢复刚被 rm 的主包目录** → 校验又失败 → 再回滚 →
  // 永远装不上（实测踩坑）。删 lock 让下次安装全量重解析（其余后端按 package.json 一并恢复，
  // 缓存热则近乎 no-op）。
  await rm(join(paths.backendsDir, 'package-lock.json'), { force: true }).catch(() => undefined);
}

/** 从 backendsDir/package.json 的 dependencies 里删一个包（直接编辑 JSON，不 spawn npm）。绝不抛错。 */
async function removeBackendsDep(bareName: string): Promise<void> {
  const pkgFile = join(paths.backendsDir, 'package.json');
  try {
    const raw = await readFile(pkgFile, 'utf8');
    const json = JSON.parse(raw) as { dependencies?: Record<string, string> };
    if (json.dependencies && bareName in json.dependencies) {
      delete json.dependencies[bareName];
      await writeFile(pkgFile, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* 文件不存在 / 解析失败 → 无条目可删，忽略 */
  }
}

/** 去掉版本后缀：`@scope/name@1.2.3` → `@scope/name`，`name@1.2.3` → `name`。 */
export function stripVersion(pkg: string): string {
  const at = pkg.lastIndexOf('@');
  // scoped 包以 @ 开头（lastIndexOf>0 才是版本分隔符）；非 scoped 的 at>0 也是版本分隔符。
  return at > 0 ? pkg.slice(0, at) : pkg;
}
