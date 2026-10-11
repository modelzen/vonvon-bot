import { homedir } from 'node:os';
import { resolveServiceRoot, serviceTarget } from './identity';
import { readRegistration, type Registration } from './registration';
import type { HostEndpoint } from '../host/discovery';
import { readVonvonRunValue } from './win-startup';

export async function readStartupRegistration(root: string): Promise<Registration> {
  const home = homedir();
  switch (process.platform) {
    case 'darwin': {
      const target = serviceTarget({ platform: 'darwin', home });
      if (target.platform !== 'darwin') throw new Error('Invalid launchd target');
      return readRegistration({ target, requestedRoot: root });
    }
    case 'linux': {
      const target = serviceTarget({ platform: 'linux', home, xdgConfigHome: process.env.XDG_CONFIG_HOME });
      if (target.platform !== 'linux') throw new Error('Invalid systemd target');
      return readRegistration({ target, requestedRoot: root });
    }
    case 'win32': {
      const target = serviceTarget({ platform: 'win32', root: await resolveServiceRoot(root) });
      if (target.platform !== 'win32') throw new Error('Invalid Windows target');
      return readRegistration({ target, requestedRoot: root, windowsRun: readVonvonRunValue() });
    }
    default:
      throw new Error(`Service startup registration is unavailable on ${process.platform}.`);
  }
}

export async function startRegisteredDaemon(root: string, port: number): Promise<HostEndpoint> {
  const input = port === 0 ? {} : { port };
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
