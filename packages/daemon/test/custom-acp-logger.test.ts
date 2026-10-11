import { afterEach, expect, it, vi } from 'vitest';
import { log } from '../src/core/logger';
import { providerLogger } from '../src/agent/acp-provider';

afterEach(() => vi.restoreAllMocks());

it('keeps custom-agent payloads and child bindings out of persistent logs', () => {
  const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
  const logger = providerLogger('custom-acp').child({ argv: ['agent', 'private-token'] });
  logger.trace({ rawEvent: { text: 'private-token' } }, 'private-token');
  logger.info('private-token');
  logger.warn({ args: ['private-token'] }, 'private-token');
  logger.error({ err: new Error('private-token') }, 'private-token');
  expect(info.mock.calls).toEqual([
    ['agent', 'custom-acp.provider', { level: 'trace' }],
    ['agent', 'custom-acp.provider', { level: 'info' }],
  ]);
  expect(warn.mock.calls).toEqual([['agent', 'custom-acp.provider', { level: 'warn' }]]);
  expect(fail.mock.calls).toEqual([['agent', 'custom-acp.provider', { level: 'error' }]]);
});
