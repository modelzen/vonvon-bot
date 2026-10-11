import { log } from '../core/logger';
import type { AgentClient } from './paseo/agent-sdk-types';
import type { Logger } from './paseo/logger';
import { checkProviderLaunchAvailable, resolveProviderLaunch } from './paseo/provider-launch-config';
import { execCommand } from './paseo/runtime/utils/spawn';
import { SessionBackend, providerHistoryReaders } from './paseo/session-backend';
import { OpenCodeV2AgentClient } from './providers/opencode/v2/agent';
import type { BackendProbe, ResumeThreadOptions, StartThreadOptions } from './types';

export interface OpenCodeProviderDependencies {
  client?: AgentClient;
  logger?: Logger;
  versionOutput?: () => Promise<string>;
}

function daemonLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', first: unknown, second?: string): void => {
    const fields = typeof first === 'object' && first !== null ? first as Record<string, unknown> : {};
    const message = second ?? (typeof first === 'string' ? first : 'provider event');
    const payload = { ...bindings, ...fields, message };
    if (level === 'error') log.fail('agent', fields.err ?? message, payload);
    else if (level === 'warn') log.warn('agent', 'opencode.provider', payload);
    else log.info('agent', 'opencode.provider', { ...payload, level });
  };
  return {
    child: (childBindings) => daemonLogger({ ...bindings, ...childBindings }),
    trace: write.bind(null, 'trace'), debug: write.bind(null, 'debug'), info: write.bind(null, 'info'),
    warn: write.bind(null, 'warn'), error: write.bind(null, 'error'),
  };
}

function parseVersion(output: string): string | null {
  const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/i.exec(output.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return `${major}.${minor}.${patch}`;
}

export function isSupportedOpenCodeVersion(output: string): boolean {
  const version = parseVersion(output);
  if (!version) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major! > 2 || (major === 2 && (minor! > 0 || (minor === 0 && patch! >= 10)));
}

async function probeVersion(dependencies: OpenCodeProviderDependencies): Promise<BackendProbe> {
  const hint = 'OpenCode 需要 2.0.10 或更新版本；请升级 opencode 并加入 PATH';
  try {
    let output: string;
    let location = 'opencode';
    if (dependencies.versionOutput) output = await dependencies.versionOutput();
    else {
      const launch = await resolveProviderLaunch({ defaultBinary: 'opencode' });
      const availability = await checkProviderLaunchAvailable(launch);
      if (!availability.available) return { ok: false, version: null, depState: 'external-missing', hint };
      location = availability.resolvedPath ?? launch.command;
      const result = await execCommand(location, [...launch.args, '--version'], { timeout: 5_000 });
      output = result.stdout.trim() || result.stderr.trim();
    }
    const version = parseVersion(output);
    const ok = isSupportedOpenCodeVersion(output);
    return { ok, version, location, depState: ok ? 'installed' : 'external-missing', ...(ok ? {} : { hint }) };
  } catch {
    return { ok: false, version: null, depState: 'external-missing', hint };
  }
}

export function createOpenCodeBackend(dependencies: OpenCodeProviderDependencies = {}): SessionBackend {
  const client = dependencies.client ?? new OpenCodeV2AgentClient({ logger: dependencies.logger ?? daemonLogger() });
  const probe = () => probeVersion(dependencies);
  const configFor = (options: StartThreadOptions) => ({ provider: 'opencode' as const, cwd: options.cwd,
    featureValues: { auto_accept: true } });
  return new class extends SessionBackend {
    override async isAvailable(): Promise<boolean> { return (await probe()).ok; }
    override async startThread(options: StartThreadOptions) {
      if (!dependencies.client && !(await probe()).ok) throw new Error('OpenCode 需要 2.0.10 或更新版本');
      return super.startThread(options);
    }
    override async resumeThread(options: ResumeThreadOptions) {
      if (!dependencies.client && !(await probe()).ok) throw new Error('OpenCode 需要 2.0.10 或更新版本');
      return super.resumeThread(options);
    }
  }(client, {
    id: 'opencode-server', displayName: 'OpenCode',
    capabilities: { goal: true, steer: true, compact: true, resume: true, approvals: false },
    supportedModes: ['full'],
    configFor,
    doctor: probe,
    ...providerHistoryReaders(client, configFor),
  });
}
