import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { permissionOptions } from './fixtures/claude-permission-v3';
import { claudeSessionConfigFor } from '../src/agent/paseo/session-backend';
import type { Logger } from '../src/agent/paseo/logger';
import { ClaudeAgentClient } from '../src/agent/providers/claude/agent';
import type { ClaudeQueryInput } from '../src/agent/providers/claude/query';
import type { PermissionMode } from '../src/agent/types';

const logger: Logger = {
  child: () => logger,
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

function fakeQuery(): Query {
  const events = [
    { type: 'system', subtype: 'init', session_id: 'permission-test', permissionMode: 'bypassPermissions', model: 'opus' },
    { type: 'result', subtype: 'success', usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 }, total_cost_usd: 0 },
  ];
  let index = 0;
  return {
    next: vi.fn(async () => index < events.length ? { done: false, value: events[index++] } : { done: true, value: undefined }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: 'opus', displayName: 'Opus' }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() { return this; },
  } as unknown as Query;
}

describe('Claude permission parity with V3', () => {
  for (const mode of [undefined, 'qa', 'write', 'full'] as const satisfies readonly (PermissionMode | undefined)[]) {
    for (const network of [undefined, false, true] as const) {
      it(`${mode ?? 'undefined'} / network ${String(network)}`, async () => {
        const cwd = '/tmp/permission-matrix';
        const config = claudeSessionConfigFor({ cwd, mode, network });
        let captured: Options | undefined;
        const client = new ClaudeAgentClient({
          logger, resolveBinary: async () => '/mock/claude',
          queryFactory: ({ options }: ClaudeQueryInput) => { captured = options; return fakeQuery(); },
        });
        const session = await client.createSession(config);
        try { await session.run('permission test'); }
        finally { await session.close(); }
        const expected = permissionOptions(mode, network, cwd);
        expect(config.modeId).toBe('bypassPermissions');
        expect(captured).toBeDefined();
        expect({
          permissionMode: captured?.permissionMode,
          allowDangerouslySkipPermissions: captured?.allowDangerouslySkipPermissions,
          sandbox: captured?.sandbox,
          disallowedTools: captured?.disallowedTools,
        }).toEqual(expected);
      });
    }
  }
});
