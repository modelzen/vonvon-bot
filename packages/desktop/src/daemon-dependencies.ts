import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION } from '@vonvon/protocol';
import type { DataRoot } from '../../daemon/src/config/data-root.js';
import { readRunningPidLock } from '../../daemon/src/server/pid-lock.js';
import { verifyPidLockOwner } from '../../daemon/src/server/owner-verification.js';
import { classifyDistribution } from '../../daemon/src/service/distribution.js';
import { resolveServiceRoot, serviceTarget, WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE } from '../../daemon/src/service/identity.js';
import { readRegistration, type WindowsRunObservation } from '../../daemon/src/service/registration.js';
import { attachExisting } from './attach.js';
import type { DaemonManagerDependencies } from './daemon-manager.js';

export async function prepareDesktopRoot(selected: DataRoot): Promise<string> {
  if (selected.kind === 'legacy') throw new Error('Migrate the legacy data folder before opening Vonvon Bot.');
  if (selected.kind === 'fresh') await mkdir(selected.path, { recursive: true, mode: 0o700 });
  const info = await lstat(selected.path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Vonvon data folder must be a physical directory.');
  return realpath(selected.path);
}

interface DesktopDaemonRuntime {
  root: string;
  home: string;
  executable: string;
  resources: string;
  packaged: boolean;
}

export function parseWindowsRunQuery(output: string): WindowsRunObservation {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines[0] !== WINDOWS_RUN_KEY.replace('HKCU', 'HKEY_CURRENT_USER')) {
    return { kind: 'unavailable', reason: 'Unrecognized registry query output.' };
  }
  for (const line of lines.slice(1)) {
    const match = /^(.*?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line);
    if (!match) return { kind: 'unavailable', reason: 'Unrecognized registry value.' };
    if (match[1] !== WINDOWS_RUN_VALUE) continue;
    if (match[2] !== 'REG_SZ' && match[2] !== 'REG_EXPAND_SZ') return { kind: 'unavailable', reason: 'Unsupported registry value type.' };
    return { kind: 'value', type: match[2], value: match[3] ?? '' };
  }
  return { kind: 'absent' };
}

async function observeWindowsRun(): Promise<WindowsRunObservation> {
  try {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) return { kind: 'unavailable', reason: 'SystemRoot is unavailable.' };
    const result = await promisify(execFile)(join(systemRoot, 'System32', 'reg.exe'), ['query', WINDOWS_RUN_KEY], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024,
    });
    return parseWindowsRunQuery(result.stdout);
  } catch {
    return { kind: 'unavailable', reason: 'The Windows Run key could not be read.' };
  }
}

export function createDaemonDependencies(runtime: DesktopDaemonRuntime): DaemonManagerDependencies {
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  async function launch(command: 'start' | 'run', port: number): Promise<void> {
    const distribution = classifyDistribution(join(runtime.resources, 'daemon'));
    if (!runtime.packaged || distribution.kind !== 'bundled') {
      throw new Error('The packaged Vonvon daemon is unavailable. Build and open the desktop application.');
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VONVON_HOME: runtime.root };
    delete env.VONVON_SERVICE;
    const log = await open(join(runtime.root, 'daemon.log'), 'a', 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const detached = command === 'run';
        const child = spawn(runtime.executable, [distribution.cliPath, 'daemon', command, '--port', String(port)], {
          env, detached, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        });
        child.once('error', reject);
        if (detached) child.once('spawn', () => { child.unref(); resolve(); });
        else child.once('exit', (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`The registered daemon could not start (${signal ?? code}). Check ${join(runtime.root, 'daemon.log')}.`));
        });
      });
    } finally { await log.close(); }
  }

  return {
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
      return { pid: lock.pid, startedAt: lock.startedAt, listen: lock.listen };
    },
    async readRegistration() {
      const platform = process.platform;
      if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') throw new Error(`Unsupported desktop platform: ${platform}.`);
      const target = platform === 'win32'
        ? serviceTarget({ platform, root: await resolveServiceRoot(runtime.root) })
        : platform === 'darwin' ? serviceTarget({ platform, home: runtime.home })
          : serviceTarget({ platform, home: runtime.home, xdgConfigHome: process.env.XDG_CONFIG_HOME });
      const registration = target.platform === 'win32'
        ? await readRegistration({ target, requestedRoot: runtime.root, windowsRun: await observeWindowsRun() })
        : await readRegistration({ target, requestedRoot: runtime.root });
      switch (registration.kind) {
        case 'absent': return { kind: 'absent' };
        case 'ours': return { kind: 'ours' };
        case 'other-root': return { kind: 'other-root', root: registration.recordedRoot };
        case 'unrecognized': return { kind: 'unrecognized', file: registration.location };
      }
    },
    startManaged: port => launch('start', port),
    startBundled: port => launch('run', port),
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
