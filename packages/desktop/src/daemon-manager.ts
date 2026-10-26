import { PROTOCOL_VERSION } from '@vonvon/protocol';

export class StartHostRefusal extends Error {}

export interface VerifiedDaemon {
  pid: number;
  listen: string;
  startedAt: string;
  /** The daemon's package version from its lock, for the startup repair. */
  version?: string;
}

/** What an installed definition starts; the startup repair checks it still exists. */
export interface RegisteredDaemon {
  kind: 'npm' | 'desktop';
  executable: string;
  entry: string;
  port: number;
}

export type Registration =
  | { kind: 'absent' }
  | { kind: 'ours'; definition?: RegisteredDaemon }
  | { kind: 'other-root'; root: string }
  /** `replaceable`: an older format of ours, which install rewrites; a symlink or directory it refuses. */
  | { kind: 'unrecognized'; file: string; replaceable?: boolean };

export interface DaemonManagerDependencies {
  /** Must verify the lock against the authenticated daemon owner, not only its PID. */
  readVerifiedDaemon(): Promise<VerifiedDaemon | null>;
  /** Must classify the installed definition for the selected realpath data root. */
  readRegistration(): Promise<Registration>;
  /** Runs the distribution's `vonvon daemon start`; it must retain its port refusal. */
  startManaged(requestedPort: number): Promise<void>;
  /** Launches the bundled entry with Electron's Node mode. */
  startBundled(requestedPort: number): Promise<void>;
  startSelectedBot(requestedPort: number, bot: string): Promise<number>;
  /** Authenticated handshake; returns the server's protocol version. */
  checkProtocol(daemon: VerifiedDaemon): Promise<number>;
  pause(ms: number): Promise<void>;
}

export interface DaemonManagerOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

const localListen = /^127\.0\.0\.1:(\d{1,5})$/;

function checkPort(daemon: VerifiedDaemon, requestedPort: number): void {
  const match = localListen.exec(daemon.listen);
  const port = Number(match?.[1]);
  if (!match || port < 1 || port > 65535) {
    throw new Error(`后台服务（PID ${daemon.pid}）公布的本机监听地址不对：${daemon.listen}。`);
  }
  if (requestedPort !== 0 && port !== requestedPort) {
    throw new Error(`后台服务（PID ${daemon.pid}）已经在 ${daemon.listen} 运行，不是要求的端口 ${requestedPort}。`);
  }
}

export function createDaemonManager(dependencies: DaemonManagerDependencies, options: DaemonManagerOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 501;
  const intervalMs = options.intervalMs ?? 50;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error('等待后台就绪的设置不合法。');
  }

  async function checked(daemon: VerifiedDaemon, requestedPort: number): Promise<VerifiedDaemon> {
    checkPort(daemon, requestedPort);
    const version = await dependencies.checkProtocol(daemon);
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`后台服务（PID ${daemon.pid}）的协议版本是 ${version}，桌面端要求 ${PROTOCOL_VERSION}。先别关它，把应用和后台更新到互相兼容的版本。`);
    }
    return daemon;
  }

  return {
    async ensureReady(requestedPort = 0, bot?: string): Promise<VerifiedDaemon> {
      if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        throw new Error(`要求的端口不合法：${requestedPort}。`);
      }
      const existing = await dependencies.readVerifiedDaemon();
      if (existing) {
        if (bot !== undefined) throw new StartHostRefusal('要单独启动选定的 Bot，请先停掉正在运行的后台服务。');
        return checked(existing, requestedPort);
      }

      const registration = await dependencies.readRegistration();
      let selectedPid: number | undefined;
      switch (registration.kind) {
        case 'ours':
          if (bot !== undefined) throw new StartHostRefusal('要单独启动选定的 Bot，请先卸载已注册的后台服务。');
          await dependencies.startManaged(requestedPort);
          break;
        case 'absent':
          if (bot === undefined) await dependencies.startBundled(requestedPort);
          else selectedPid = await dependencies.startSelectedBot(requestedPort, bot);
          break;
        case 'other-root':
          throw new Error(`Vonvon 后台服务属于另一个数据目录：${registration.root}。`);
        case 'unrecognized':
          throw new Error(`Vonvon 后台服务的定义文件无法识别：${registration.file}。`);
        default: {
          const exhaustive: never = registration;
          throw new Error(`未知的后台服务注册状态：${exhaustive}。`);
        }
      }

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ready = await dependencies.readVerifiedDaemon();
        if (ready) {
          if (selectedPid !== undefined && ready.pid !== selectedPid) {
            throw new StartHostRefusal(`另一个后台服务（PID ${ready.pid}）在启动选定的 Bot（PID ${selectedPid}）期间成了当前的后台。桌面端不会替你关它，请自己停掉后再试。`);
          }
          return checked(ready, requestedPort);
        }
        if (attempt + 1 < maxAttempts) await dependencies.pause(intervalMs);
      }
      throw new Error('后台服务启动超时，一直没有就绪。看看数据目录里的 daemon.log，再重新打开 Vonvon Bot。');
    },
  };
}
