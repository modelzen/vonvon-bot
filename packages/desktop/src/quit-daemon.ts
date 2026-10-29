import { StartHostRefusal, type VerifiedDaemon } from './daemon-manager.js';

export interface QuitDaemonDependencies {
  readVerifiedDaemon(): Promise<VerifiedDaemon | null>;
  requestStop(owner: VerifiedDaemon): Promise<void>;
  ownerRunning(owner: VerifiedDaemon): Promise<boolean>;
  /** A previously started service helper can still publish a successor between owners. */
  handoffPending?(): boolean;
  pause(ms: number): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/** Explicit desktop Quit stops the current root's authenticated daemon, including a replacement. */
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
