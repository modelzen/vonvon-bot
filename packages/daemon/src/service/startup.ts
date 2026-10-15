import { homedir } from 'node:os';
import { serviceTarget } from './identity';
import { readRegistration, type Registration } from './registration';
import type { HostEndpoint } from '../host/discovery';
import type { StaleOwner } from '../server/pid-lock';

/** Reads this user's service registration; platforms without a supported service manager have none. */
export async function readStartupRegistration(root: string): Promise<Registration> {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return readRegistration({ target: serviceTarget({ platform: 'darwin', home }), requestedRoot: root });
    case 'linux':
      return readRegistration({ target: serviceTarget({ platform: 'linux', home, xdgConfigHome: process.env.XDG_CONFIG_HOME }), requestedRoot: root });
    default:
      return { kind: 'absent' };
  }
}

export async function startRegisteredDaemon(root: string, port: number, staleOwner?: StaleOwner): Promise<HostEndpoint> {
  const input = { ...(port === 0 ? {} : { port }), ...(staleOwner ? { staleOwner } : {}) };
  switch (process.platform) {
    case 'darwin':
      return (await import('./launchd')).createLaunchdService({ root }).start(input);
    case 'linux':
      return (await import('./systemd')).createSystemdService({ root }).start(input);
    default:
      throw new Error(`Service startup is unavailable on ${process.platform}.`);
  }
}
