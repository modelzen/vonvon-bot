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
import { attachExisting } from './attach.js';
import type { DaemonManagerDependencies } from './daemon-manager.js';

export async function prepareDesktopRoot(selected: DataRoot): Promise<string> {
  if (selected.kind === 'fresh') await mkdir(selected.path, { recursive: true, mode: 0o700 });
  const info = await lstat(selected.path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Vonvon data folder must be a physical directory.');
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
}

export function createDaemonDependencies(runtime: DesktopDaemonRuntime): DaemonManagerDependencies & { ownerRunning(previous: { pid: number; startedAt: string }): Promise<boolean> } {
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  async function launch(command: 'start' | 'run', port: number, bot?: string): Promise<number | undefined> {
    const distribution = classifyDistribution(join(runtime.resources, 'daemon'));
    if (!runtime.packaged || distribution.kind !== 'bundled') {
      throw new Error('The packaged Vonvon daemon is unavailable. Build and open the desktop application.');
    }
    const env = daemonEnvironment(runtime.root, runtime.home);
    const log = await open(join(runtime.root, 'daemon.log'), 'a', 0o600);
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        const detached = command === 'run';
        const args = [distribution.cliPath, 'daemon', command, '--port', String(port)];
        if (bot !== undefined) args.push('--bot', bot);
        const child = spawn(runtime.executable, args, {
          env, detached, stdio: ['ignore', log.fd, log.fd],
        });
        child.once('error', reject);
        if (detached) child.once('spawn', () => { child.unref(); resolve(child.pid); });
        else child.once('exit', (code, signal) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`The registered daemon could not start (${signal ?? code}). Check ${join(runtime.root, 'daemon.log')}.`));
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
      if (!lock.listen) throw new Error(`Daemon PID ${lock.pid} has not published its listener. Leave it running and try again.`);
      try { await verifyPidLockOwner(runtime.root, lock); }
      catch (cause) {
        throw new Error(`Cannot authenticate daemon PID ${lock.pid} with desktop protocol ${PROTOCOL_VERSION}. Leave it running and check app/daemon compatibility and the local credential.`, { cause });
      }
      return { pid: lock.pid, startedAt: lock.startedAt, listen: lock.listen, ...(lock.version === undefined ? {} : { version: lock.version }) };
    },
    async readRegistration() {
      const platform = process.platform;
      // The app ships for macOS only; Linux stays so the Linux CI job reads a real definition through this mapping.
      if (platform !== 'darwin' && platform !== 'linux') throw new Error(`Unsupported desktop platform: ${platform}.`);
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
    async startManaged(port) { await launch('start', port); },
    async startBundled(port) { await launch('run', port); },
    async startSelectedBot(port, bot) {
      const pid = await launch('run', port, bot);
      if (pid === undefined || !Number.isInteger(pid) || pid < 1) {
        throw new Error('The selected Bot daemon did not provide a process ID. Its startup cannot be confirmed.');
      }
      return pid;
    },
    async checkProtocol(expected) {
      const attached = await attachExisting(runtime.root);
      try {
        if (attached.identity.pid !== expected.pid || attached.identity.startedAt !== expected.startedAt || attached.identity.listen !== expected.listen) {
          throw new Error('The daemon owner changed during desktop startup.');
        }
        return PROTOCOL_VERSION;
      } finally { await attached.dispose(); }
    },
    pause,
  };
}
