import { log } from '../core/logger';
import { GenericACPAgentClient } from './providers/generic-acp-agent';
import type { Logger } from './paseo/logger';
import { SessionBackend, providerHistoryReaders } from './paseo/session-backend';
import type { AgentClient, AgentSessionConfig } from './paseo/agent-sdk-types';
import type { BackendProbe, StartThreadOptions } from './types';

export interface ACPProviderDependencies {
  command: [string, ...string[]];
  env?: Record<string, string>;
  client?: AgentClient;
  logger?: Logger;
}

export function providerLogger(provider: string, bindings: Record<string, unknown> = {}): Logger {
  const write = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', first: unknown, second?: string): void => {
    if (provider === 'custom-acp') {
      if (level === 'error') log.fail('agent', 'custom-acp.provider', { level });
      else if (level === 'warn') log.warn('agent', 'custom-acp.provider', { level });
      else log.info('agent', 'custom-acp.provider', { level });
      return;
    }
    const fields = typeof first === 'object' && first !== null ? first as Record<string, unknown> : {};
    const message = second ?? (typeof first === 'string' ? first : 'provider event');
    const payload = { ...bindings, ...fields, message };
    if (level === 'error') log.fail('agent', fields.err ?? message, payload);
    else if (level === 'warn') log.warn('agent', `${provider}.provider`, payload);
    else log.info('agent', `${provider}.provider`, { ...payload, level });
  };
  return {
    child: (childBindings) => providerLogger(provider, { ...bindings, ...childBindings }),
    trace: write.bind(null, 'trace'), debug: write.bind(null, 'debug'), info: write.bind(null, 'info'),
    warn: write.bind(null, 'warn'), error: write.bind(null, 'error'),
  };
}

export function acpConfigFor(client: AgentClient, options: StartThreadOptions): AgentSessionConfig {
  return { provider: client.provider, cwd: options.cwd, featureValues: { auto_accept: true } };
}

export function createACPCompatibleBackend(client: AgentClient, id: string, displayName: string, installHint: string): SessionBackend {
  const configFor = (options: StartThreadOptions) => acpConfigFor(client, options);
  return new SessionBackend(client, {
    id, displayName,
    capabilities: { goal: true, steer: false, compact: false, resume: true, approvals: false },
    supportedModes: ['full'], configFor,
    doctor: async (): Promise<BackendProbe> => {
      try {
        const ok = await client.isAvailable();
        return { ok, version: null, depState: ok ? 'installed' : 'external-missing',
          ...(ok ? {} : { hint: installHint }) };
      } catch (error) {
        return { ok: false, version: null, depState: 'external-missing',
          hint: error instanceof Error ? error.message : installHint };
      }
    },
    ...providerHistoryReaders(client, configFor),
  });
}

export function createACPBackend(dependencies: ACPProviderDependencies): SessionBackend {
  const client = dependencies.client ?? new GenericACPAgentClient({
    command: dependencies.command,
    env: dependencies.env,
    logger: dependencies.logger ?? providerLogger('custom-acp'),
    providerId: 'custom-acp',
    label: '自定义 ACP',
  });
  return createACPCompatibleBackend(client, 'custom-acp', '自定义 ACP', '自定义 ACP 命令不可用');
}
