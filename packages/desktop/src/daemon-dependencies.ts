import { spawn } from 'node:child_process';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import type { DataRoot } from '../../daemon/src/config/data-root.js';
import { isPidLockOwnerRunning, readRunningPidLock } from '../../daemon/src/server/pid-lock.js';
import { verifyPidLockOwner } from '../../daemon/src/server/owner-verification.js';
import { classifyDistribution } from '../../daemon/src/service/distribution.js';
import { withToolDirectories } from '../../daemon/src/platform/tool-path.js';
import { serviceTarget } from '../../daemon/src/service/identity.js';
import { isIrreplaceableDefinition, readRegistration } from '../../daemon/src/service/registration.js';
import { attachExisting, AttachError } from './attach.js';
import type { DaemonManagerDependencies } from './daemon-manager.js';

export async function prepareDesktopRoot(selected: DataRoot): Promise<string> {
  if (selected.kind === 'fresh') await mkdir(selected.path, { recursive: true, mode: 0o700 });
  const info = await lstat(selected.path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Vonvon 数据目录必须是真实目录，不能是符号链接。');
  return realpath(selected.path);
}

/** The environment of every bundled `vonvon` the app starts: the daemon, `daemon stop` and the service helper. */
export function daemonEnvironment(root: string, home: string): NodeJS.ProcessEnv {
  // Opened from Finder, the app's PATH lacks Homebrew, so the daemon would not find Codex.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VONVON_HOME: root, PATH: withToolDirectories(process.env.PATH, home) };
  // A service's own variable: what the app starts is never the service's job.
  delete env.VONVON_SERVICE;
  return env;
}

interface DesktopDaemonRuntime {
  root: string;
  home: string;
  executable: string;
  resources: string;
  packaged: boolean;
  allowRegisteredService?: boolean;
}

export function createDaemonDependencies(runtime: DesktopDaemonRuntime): DaemonManagerDependencies & { ownerRunning(previous: { pid: number; startedAt: string }): Promise<boolean> } {
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  async function launch(command: 'start' | 'run', port: number, bot?: string): Promise<number | undefined> {
    const distribution = classifyDistribution(join(runtime.resources, 'daemon'));
    if (!runtime.packaged || distribution.kind !== 'bundled') {
      throw new Error('应用里打包的 Vonvon 后台服务不可用。请先构建并打开桌面应用。');
    }
    const env = daemonEnvironment(runtime.root, runtime.home);
    const log = await open(join(runtime.root, 'daemon.log'), 'a', 0o600);
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        const detached = command === 'run';
        const args = [distribution.cliPath, 'daemon', command, '--port', String(port)];
        if (bot !== undefined) args.push('--bot', bot);
        const child = spawn(runtime.executable, args, {
          env, detached, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        });
        child.once('error', reject);
        if (detached) child.once('spawn', () => { child.unref(); resolve(child.pid); });
        else child.once('exit', (code, signal) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`已注册的后台服务没能启动（${signal ?? code}）。请查看 ${join(runtime.root, 'daemon.log')}。`));
        });
      });
    } finally { await log.close(); }
  }

  return {
    /** The old process still counts as running after releasing its PID lock, until it exits. */
    async ownerRunning(previous) {
      return isPidLockOwnerRunning({ pid: previous.pid, startedAt: previous.startedAt, listen: null });
    },
    async readVerifiedDaemon() {
      let lock = await readRunningPidLock(runtime.root);
      for (let attempt = 0; lock && !lock.listen && attempt < 500; attempt++) {
        await pause(50);
        lock = await readRunningPidLock(runtime.root);
      }
      if (!lock) return null;
      if (!lock.listen) throw new Error(`后台服务（PID ${lock.pid}）还没有公布监听地址。先别关它，稍后再试。`);
      try { await verifyPidLockOwner(runtime.root, lock); }
      catch (cause) {
        throw new Error(`无法确认正在运行的后台服务（PID ${lock.pid}）属于这个数据目录。先别关它，检查本机凭据；详情在 daemon.log。`, { cause });
      }
      return { pid: lock.pid, startedAt: lock.startedAt, listen: lock.listen, ...(lock.version === undefined ? {} : { version: lock.version }) };
    },
    async readRegistration() {
      if (runtime.allowRegisteredService === false) return { kind: 'absent' };
      const platform = process.platform;
      // Windows runs the bundled daemon directly, without a registered service.
      if (platform === 'win32') return { kind: 'absent' };
      if (platform !== 'darwin' && platform !== 'linux') throw new Error(`桌面端不支持这个系统：${platform}。`);
      const target = platform === 'darwin' ? serviceTarget({ platform, home: runtime.home, root: runtime.root })
        : serviceTarget({ platform, home: runtime.home, root: runtime.root, xdgConfigHome: process.env.XDG_CONFIG_HOME });
      const registration = await readRegistration({ target, requestedRoot: runtime.root });
      switch (registration.kind) {
        case 'absent': return { kind: 'absent' };
        case 'ours': {
          const { definition: { port, distribution: { kind, executable, entry } } } = registration;
          return { kind: 'ours', definition: { kind, executable, entry, port } };
        }
        case 'other-root': return { kind: 'other-root', root: registration.recordedRoot };
        case 'unrecognized': return { kind: 'unrecognized', file: registration.location, replaceable: !isIrreplaceableDefinition(registration.reason) };
      }
    },
    async startManaged(port) {
      if (runtime.allowRegisteredService === false) throw new Error('预览版不启动登录服务。');
      await launch('start', port);
    },
    async startBundled(port) { await launch('run', port); },
    async startSelectedBot(port, bot) {
      const pid = await launch('run', port, bot);
      if (pid === undefined || !Number.isInteger(pid) || pid < 1) {
        throw new Error('选定 Bot 的后台没有返回进程号，无法确认它是否启动成功。');
      }
      return pid;
    },
    async checkProtocol(expected) {
      let attached;
      // Another protocol is an answer here, not a failure: the manager says which versions differ (daemon-manager.ts).
      try { attached = await attachExisting(runtime.root); }
      catch (error) {
        if (error instanceof AttachError && error.reason === 'protocol' && error.serverProtocol !== undefined) return error.serverProtocol;
        throw error;
      }
      try {
        if (attached.identity.pid !== expected.pid || attached.identity.startedAt !== expected.startedAt || attached.identity.listen !== expected.listen) {
          throw new Error('桌面启动期间，后台的所有者变了。');
        }
        return PROTOCOL_VERSION;
      } finally { await attached.dispose(); }
    },
    pause,
  };
}
