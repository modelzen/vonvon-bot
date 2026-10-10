import { PROTOCOL_VERSION } from '@vonvon/protocol';

export interface VerifiedDaemon {
  pid: number;
  listen: string;
  startedAt: string;
}

export type Registration =
  | { kind: 'absent' }
  | { kind: 'ours' }
  | { kind: 'other-root'; root: string }
  | { kind: 'unrecognized'; file: string };

export interface DaemonManagerDependencies {
  /** Must verify the lock against the authenticated daemon owner, not only its PID. */
  readVerifiedDaemon(): Promise<VerifiedDaemon | null>;
  /** Must classify the installed definition for the selected realpath data root. */
  readRegistration(): Promise<Registration>;
  /** Runs the distribution's `vonvon daemon start`; it must retain its port refusal. */
  startManaged(requestedPort: number): Promise<void>;
  /** Launches the bundled entry with Electron's Node mode. */
  startBundled(requestedPort: number): Promise<void>;
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
    throw new Error(`Daemon PID ${daemon.pid} published an invalid local listener: ${daemon.listen}.`);
  }
  if (requestedPort !== 0 && port !== requestedPort) {
    throw new Error(`Daemon PID ${daemon.pid} already runs at ${daemon.listen}, not requested port ${requestedPort}.`);
  }
}

export function createDaemonManager(dependencies: DaemonManagerDependencies, options: DaemonManagerOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 501;
  const intervalMs = options.intervalMs ?? 50;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error('Invalid daemon readiness wait settings.');
  }

  async function checked(daemon: VerifiedDaemon, requestedPort: number): Promise<VerifiedDaemon> {
    checkPort(daemon, requestedPort);
    const version = await dependencies.checkProtocol(daemon);
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`Daemon PID ${daemon.pid} speaks protocol version ${version}; desktop expects ${PROTOCOL_VERSION}. Leave it running and update the app or daemon to compatible versions.`);
    }
    return daemon;
  }

  return {
    async ensureReady(requestedPort = 0): Promise<VerifiedDaemon> {
      if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        throw new Error(`Invalid requested daemon port: ${requestedPort}.`);
      }
      const existing = await dependencies.readVerifiedDaemon();
      if (existing) return checked(existing, requestedPort);

      const registration = await dependencies.readRegistration();
      switch (registration.kind) {
        case 'ours':
          await dependencies.startManaged(requestedPort);
          break;
        case 'absent':
          await dependencies.startBundled(requestedPort);
          break;
        case 'other-root':
          throw new Error(`Vonvon service belongs to another data root: ${registration.root}.`);
        case 'unrecognized':
          throw new Error(`Vonvon service definition is unrecognized: ${registration.file}.`);
        default: {
          const exhaustive: never = registration;
          throw new Error(`Unknown daemon registration: ${exhaustive}.`);
        }
      }

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ready = await dependencies.readVerifiedDaemon();
        if (ready) return checked(ready, requestedPort);
        if (attempt + 1 < maxAttempts) await dependencies.pause(intervalMs);
      }
      throw new Error('Daemon did not become ready within the startup wait.');
    },
  };
}
