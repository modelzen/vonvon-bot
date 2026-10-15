import { spawn as spawnProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_BUSY_MESSAGE } from '@vonvon/protocol';
import { RpcError } from '../server/errors';
import { liveServiceActionRecord, readServiceActionRecord, writeServiceActionRecord } from '../service/action-report';

export type ServiceActionKind = 'install' | 'uninstall';
/** The helper this daemon started, from the reservation until it exits. */
export type RunningServiceAction = { action: ServiceActionKind; startedAt: number; pid?: number };
export interface ServiceActionLauncher {
  /** Refuses, or holds the one slot: `start` spawns the helper once the reply is out, `cancel` frees an unused slot. */
  reserve(action: ServiceActionKind): { start(): void; cancel(): void };
  current(): RunningServiceAction | undefined;
}

export const LINUX_SERVICE_REFUSAL = 'Linux 上请在终端运行 vonvon service install 或 vonvon service uninstall。';

/**
 * Runs `vonvon service install|uninstall --keep-running` beside the daemon (D1): install drains this very daemon and
 * uninstall boots out the service's, so the work cannot run in-process. The helper is detached (its own session, so
 * launchd's bootout of this job should not take it along; Mac check A8) and writes `service-action.json` itself.
 */
export function createServiceActionLauncher(options: {
  root: string; platform?: NodeJS.Platform; spawn?: typeof spawnProcess; onSettled?: () => void;
  execPath?: string; cliEntry?: string; now?: () => number;
}): ServiceActionLauncher {
  const { root, platform = process.platform, spawn = spawnProcess, now = Date.now } = options;
  let slot: RunningServiceAction | undefined;
  return {
    current: () => slot && { ...slot },
    reserve(action) {
      // Linux would need the helper moved out of the unit's cgroup, and linger first (s20a); the terminal works today.
      if (platform !== 'darwin') throw new RpcError('unsupported', LINUX_SERVICE_REFUSAL);
      if (slot || liveServiceActionRecord(root, now())?.phase === 'running') throw new RpcError('busy', SERVICE_BUSY_MESSAGE);
      const cliEntry = options.cliEntry ?? process.argv[1];
      if (!cliEntry) throw new Error('Cannot locate the daemon CLI entry.');
      const reserved: RunningServiceAction = { action, startedAt: now() };
      slot = reserved;
      let used = false;
      let settled = false;
      let failing = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (slot === reserved) slot = undefined;
        options.onSettled?.();
      };
      // Node may or may not emit exit after a spawn error; the slot stays until the failure is on disk.
      const failed = (detail: string, begun = false): void => {
        if (settled || failing) return;
        failing = true;
        void writeServiceActionRecord(root, { pid: process.pid, action, phase: 'done', ok: false, kind: begun ? `${action}_incomplete` : `${action}_refused`, reason: 'other', detail, startedAt: reserved.startedAt, finishedAt: now() })
          .catch(() => undefined).finally(settle);
      };
      const notStarted = (error: unknown): void => failed(`Could not start vonvon service ${action}: ${error instanceof Error ? error.message : String(error)}`);
      // A helper that fails before writing its result (it lost the service mutex, or crashed) would let the switch flip
      // back without a word. Its own running record means the transaction began; another helper's live run shows itself.
      const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (failing) return;
        const record = readServiceActionRecord(root);
        const own = record !== null && record.pid === reserved.pid;
        if (code === 0 || (own ? record.phase === 'done' : liveServiceActionRecord(root, now())?.phase === 'running')) { settle(); return; }
        failed(`vonvon service ${action} exited with ${code === null ? signal : `code ${code}`} before writing its result; see daemon.log`, own);
      };
      return {
        cancel() {
          if (used) return;
          used = true;
          if (slot === reserved) slot = undefined;
        },
        start() {
          if (used) return;
          used = true;
          const env: NodeJS.ProcessEnv = { ...process.env, VONVON_HOME: root };
          delete env.VONVON_SERVICE;
          try {
            const log = openSync(join(root, 'daemon.log'), 'a', 0o600);
            let child;
            try { child = spawn(options.execPath ?? process.execPath, [cliEntry, 'service', action, '--keep-running'], { detached: true, stdio: ['ignore', log, log], env }); }
            finally { closeSync(log); }
            reserved.pid = child.pid;
            // The helper outlives this daemon on purpose: install and uninstall both stop it.
            child.unref();
            child.once('error', notStarted);
            child.once('exit', exited);
          } catch (error) { notStarted(error); }
        },
      };
    },
  };
}
