import type { HostFacts, InstallProbe, Os, ProviderId } from '../model';

/** Resolve only after the owned child is terminal and reaped; reject on spawn error or timeout. */
export type HostCommandRunner = (
  executable: string,
  argv: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ exitCode: number | null }>;

type InstallCallback = () => Promise<InstallProbe | undefined> | InstallProbe | undefined;

export interface HostProbeOptions {
  os: Os;
  runCommand: HostCommandRunner;
  installProbes?: Partial<Record<ProviderId, InstallCallback>>;
  windowsReadiness?: () => Promise<boolean | undefined> | boolean | undefined;
}

const COMMAND_TIMEOUT_MS = 5_000;

function copyFacts(facts: HostFacts): HostFacts {
  const installed: HostFacts['installed'] = {};
  if (facts.installed.codex) installed.codex = { ...facts.installed.codex };
  if (facts.installed.claude) installed.claude = { ...facts.installed.claude };
  return {
    os: facts.os,
    commandSandbox: facts.commandSandbox,
    ...(facts.windowsSandboxReady === undefined ? {} : { windowsSandboxReady: facts.windowsSandboxReady }),
    installed,
  };
}

export class HostProbe {
  private current: Promise<HostFacts> | undefined;

  constructor(private readonly options: HostProbeOptions) {}

  boot(): Promise<HostFacts> {
    this.current ??= this.probe();
    return this.current.then(copyFacts);
  }

  refreshForDoctor(): Promise<HostFacts> {
    const prior = this.current;
    const next = prior
      ? prior.then(() => this.probe(), () => this.probe())
      : this.probe();
    this.current = next;
    return next.then(copyFacts);
  }

  private async probe(): Promise<HostFacts> {
    const [commandSandbox, windowsSandboxReady, installed] = await Promise.all([
      this.probeCommandSandbox(),
      this.probeWindowsReadiness(),
      this.probeInstallations(),
    ]);
    return {
      os: this.options.os,
      commandSandbox,
      ...(windowsSandboxReady === undefined ? {} : { windowsSandboxReady }),
      installed,
    };
  }

  private async probeCommandSandbox(): Promise<HostFacts['commandSandbox']> {
    let executable: string;
    let argv: readonly string[];
    let available: HostFacts['commandSandbox'];
    switch (this.options.os) {
      case 'darwin':
        executable = 'sandbox-exec';
        argv = ['-p', '(version 1) (allow default)', '/usr/bin/true'];
        available = 'seatbelt';
        break;
      case 'linux':
        executable = 'bwrap';
        argv = ['--unshare-user', 'true'];
        available = 'bwrap';
        break;
      case 'win32':
        return 'none';
      default: {
        const exhaustive: never = this.options.os;
        return exhaustive;
      }
    }
    try {
      const result = await this.options.runCommand(executable, argv, { timeoutMs: COMMAND_TIMEOUT_MS });
      return result.exitCode === 0 ? available : 'none';
    } catch {
      return 'none';
    }
  }

  private async probeWindowsReadiness(): Promise<boolean | undefined> {
    if (this.options.os !== 'win32' || !this.options.windowsReadiness) return undefined;
    try {
      return await this.options.windowsReadiness();
    } catch {
      return undefined;
    }
  }

  private async probeInstallations(): Promise<HostFacts['installed']> {
    const callbacks = this.options.installProbes;
    const entries: readonly [ProviderId, InstallCallback | undefined][] = [
      ['codex', callbacks?.codex],
      ['claude', callbacks?.claude],
    ];
    const results = await Promise.all(entries.map(async ([id, callback]) => {
      if (!callback) return undefined;
      try {
        const result = await callback();
        return result === undefined ? undefined : { id, result: { ...result } };
      } catch {
        return undefined;
      }
    }));
    const installed: HostFacts['installed'] = {};
    for (const entry of results) {
      if (entry) installed[entry.id] = entry.result;
    }
    return installed;
  }
}
