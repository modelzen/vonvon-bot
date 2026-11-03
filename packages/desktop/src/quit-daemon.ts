import type { VonvonClient } from '@vonvon/client/browser';
import { StartHostRefusal, type Registration, type VerifiedDaemon } from './daemon-manager.js';

export interface QuitDaemonDependencies {
  readVerifiedDaemon(): Promise<VerifiedDaemon | null>;
  requestStop(owner: VerifiedDaemon): Promise<void>;
  ownerRunning(owner: VerifiedDaemon): Promise<boolean>;
  /** A previously started service helper can still publish a successor between owners. */
  handoffPending?(): boolean;
  pause(ms: number): Promise<void>;
  /** 7.4：另外注册成后台服务、又不是桌面端自带的那台，退出只断开。拿不准就是 false（照旧停）。 */
  keep?(owner: VerifiedDaemon): Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
}

/** Explicit desktop Quit stops the current root's authenticated daemon, including a replacement, unless `keep` says it
 * is a server installed and registered on its own (devices 7.4). Each owner read is judged again, so one that appears
 * during a handoff follows the same rule. */
export async function stopDaemonForQuit(dependencies: QuitDaemonDependencies): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const deadline = now() + (dependencies.timeoutMs ?? 60_000);
  const timeout = (): StartHostRefusal => new StartHostRefusal('后台服务还没有完全停止，Vonvon Bot 尚未退出。请稍后重试，详情在 daemon.log。');
  for (;;) {
    if (now() >= deadline) throw timeout();
    if (dependencies.handoffPending?.()) {
      await dependencies.pause(100);
      continue;
    }
    const owner = await dependencies.readVerifiedDaemon();
    if (dependencies.handoffPending?.()) {
      await dependencies.pause(100);
      continue;
    }
    if (!owner) return;
    if (await dependencies.keep?.(owner)) return;
    await dependencies.requestStop(owner);
    // A stop acknowledgement is not proof of exit: the daemon drains its Bots and
    // provider processes before releasing its lock and exiting.
    while (await dependencies.ownerRunning(owner)) {
      if (now() >= deadline) throw timeout();
      await dependencies.pause(100);
    }
    // A completed handoff or an external start may have installed a new owner.
    // Authenticate it afresh rather than stopping the desktop's stale attachment.
  }
}

export interface KeepOnQuitDependencies {
  readRegistration(): Promise<Registration>;
  /** An authenticated connection to the running daemon of this root (`attachExisting`). */
  attach(): Promise<{ identity: { pid: number; startedAt: string }; client: Pick<VonvonClient, 'admin'>; dispose(): Promise<void> }>;
}

/**
 * devices 7.4: a server installed and registered on its own, and not the one this app carries, stays when the app quits.
 * All three must hold: the registered service is not the desktop's, the daemon that answers is the owner just read (pid
 * and start), and its install is not `bundled` (a stopped service may have left the app to start its own). Anything
 * unsure, another protocol included, is false: quitting stops the daemon as before.
 */
export async function daemonKeptOnQuit(owner: VerifiedDaemon, dependencies: KeepOnQuitDependencies): Promise<boolean> {
  try {
    const registration = await dependencies.readRegistration();
    if (registration.kind !== 'ours' || !registration.definition || registration.definition.kind === 'desktop') return false;
    const attached = await dependencies.attach();
    try {
      if (attached.identity.pid !== owner.pid || attached.identity.startedAt !== owner.startedAt) return false;
      const reply = await attached.client.admin({ type: 'daemonStatus' });
      return reply.kind === 'daemonStatus' && reply.status.distribution !== undefined && reply.status.distribution.kind !== 'bundled';
    } finally { await attached.dispose(); }
  } catch { return false; }
}
