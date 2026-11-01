import { homedir } from 'node:os';
import { currentWindowsSid, serviceTarget } from './identity';
import { readRegistration, type Registration } from './registration';
import type { HostEndpoint } from '../host/discovery';
import type { StaleOwner } from '../server/pid-lock';

/**
 * Reads this user's service registration; platforms without a supported service manager have none. With
 * `unansweredAsAbsent`, a Windows `schtasks` that gives no answer reads as no task (`daemon start`: the pid lock still
 * keeps a second daemon off the data root); without it, as unrecognized, so a task's own daemon fails and is retried.
 */
export async function readStartupRegistration(root: string, options: { unansweredAsAbsent?: boolean } = {}): Promise<Registration> {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return readRegistration({ target: serviceTarget({ platform: 'darwin', home, root }), requestedRoot: root });
    case 'linux':
      return readRegistration({ target: serviceTarget({ platform: 'linux', home, root, xdgConfigHome: process.env.XDG_CONFIG_HOME }), requestedRoot: root });
    case 'win32': {
      // Without the SID there is no task name to look up: start detached, as before I4a.
      let sid: string;
      try { sid = await currentWindowsSid(); } catch { return { kind: 'absent' }; }
      return readRegistration({ target: serviceTarget({ platform: 'win32', sid, root }), requestedRoot: root, ...(options.unansweredAsAbsent ? { unansweredAsAbsent: true } : {}) });
    }
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
    case 'win32':
      return (await import('./windows')).createWindowsService({ root }).start(input);
    default:
      throw new Error(`Service startup is unavailable on ${process.platform}.`);
  }
}
