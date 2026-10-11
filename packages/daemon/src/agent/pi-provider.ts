import { isAbsolute } from 'node:path';
import { log } from '../core/logger';
import type { AgentClient, AgentSession } from './paseo/agent-sdk-types';
import type { Logger } from './paseo/logger';
import { SessionBackend, providerHistoryReaders } from './paseo/session-backend';
import { PiRpcAgentClient } from './providers/pi/agent';
import type { BackendProbe, StartThreadOptions } from './types';

export interface PiProviderDependencies {
  client?: AgentClient;
  logger?: Logger;
}

function daemonLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', first: unknown, second?: string): void => {
    const fields = typeof first === 'object' && first !== null ? first as Record<string, unknown> : {};
    const message = second ?? (typeof first === 'string' ? first : 'provider event');
    const payload = { ...bindings, ...fields, message };
    if (level === 'error') log.fail('agent', fields.err ?? message, payload);
    else if (level === 'warn') log.warn('agent', 'pi.provider', payload);
    else log.info('agent', 'pi.provider', { ...payload, level });
  };
  return {
    child: (childBindings) => daemonLogger({ ...bindings, ...childBindings }),
    trace: write.bind(null, 'trace'), debug: write.bind(null, 'debug'), info: write.bind(null, 'info'),
    warn: write.bind(null, 'warn'), error: write.bind(null, 'error'),
  };
}

function assertPiSessionFile(sessionId: string): void {
  if (!isAbsolute(sessionId) || !sessionId.endsWith('.jsonl')) throw new Error('无效的 Pi 会话');
}

async function sessionWithFileId(session: AgentSession): Promise<AgentSession> {
  const sessionFile = session.describePersistence()?.nativeHandle;
  if (!sessionFile || !isAbsolute(sessionFile) || !sessionFile.endsWith('.jsonl')) {
    await session.close().catch(() => undefined);
    throw new Error('Pi 未返回会话文件，无法恢复');
  }
  return new Proxy(session, {
    get(target, property) {
      if (property === 'id') return sessionFile;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function fileIdClient(client: AgentClient): AgentClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'createSession') {
        const create: AgentClient['createSession'] = async (...args) =>
          sessionWithFileId(await target.createSession(...args));
        return create;
      }
      if (property === 'resumeSession') {
        const resume: AgentClient['resumeSession'] = async (handle, ...args) => {
          assertPiSessionFile(handle.sessionId);
          return sessionWithFileId(await target.resumeSession(
            { ...handle, nativeHandle: handle.nativeHandle ?? handle.sessionId }, ...args));
        };
        return resume;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createPiBackend(dependencies: PiProviderDependencies = {}): SessionBackend {
  const client = fileIdClient(dependencies.client ?? new PiRpcAgentClient({ logger: dependencies.logger ?? daemonLogger() }));
  const configFor = (options: StartThreadOptions) => ({ provider: 'pi' as const, cwd: options.cwd });
  return new SessionBackend(client, {
    id: 'pi-rpc', displayName: 'Pi',
    capabilities: { goal: true, steer: true, compact: true, resume: true, approvals: false },
    supportedModes: ['full'],
    configFor,
    doctor: async (): Promise<BackendProbe> => {
      try {
        const ok = await client.isAvailable();
        return { ok, version: null, location: 'pi', depState: ok ? 'installed' : 'external-missing',
          ...(ok ? {} : { hint: 'Pi CLI 未安装；请安装 pi 命令并加入 PATH' }) };
      } catch (error) {
        return { ok: false, version: null, depState: 'external-missing',
          hint: error instanceof Error ? error.message : 'Pi CLI 不可用' };
      }
    },
    ...providerHistoryReaders(client, configFor),
  });
}
