import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { log, shortenFeishuId, TEST_LOGS_DIR, withTrace } from '../src/core/logger';

afterEach(() => vi.restoreAllMocks());

it('cuts a Feishu id to its last 6 characters and keeps a tier suffix', () => {
  expect(shortenFeishuId('oc_0123456789abcdef')).toBe('abcdef');
  expect(shortenFeishuId('om_x100b4d2f9e81a2b3')).toBe('81a2b3');
  expect(shortenFeishuId('omt_1a2b3c4d5e6f7a8b#admin')).toBe('6f7a8b#admin');
  expect(shortenFeishuId('ou_aaaaaaaaaabbbbbb')).toBe('bbbbbb');
  // Not wholly one id: text, an app id, a pending key, an error message.
  for (const value of ['hello world', 'cli_a1b2c3d4e5f6g7h8', 'pending:om_x100b4d2f9e81a2b3', 'boom oc_0123456789abcdef', 'oc_demo']) {
    expect(shortenFeishuId(value)).toBe(value);
  }
});

it('writes the trace context and top-level id fields short, on stdout and in the file', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const marker = `ids-${Date.now()}`;
  await withTrace({ chatId: 'oc_0123456789abcdef', msgId: 'om_x100b4d2f9e81a2b3' }, async () => {
    log.warn('test', 'ids', { marker, sessionKey: 'omt_1a2b3c4d5e6f7a8b#guest', nested: { chatId: 'oc_0123456789abcdef' } });
  });
  expect(warn.mock.calls[0]?.[0]).toContain('c=abcdef');
  expect(warn.mock.calls[0]?.[0]).toContain('sessionKey=6f7a8b#guest');
  let line: Record<string, unknown> | undefined;
  for (let i = 0; i < 40 && !line; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const text = readdirSync(TEST_LOGS_DIR).filter(file => file.endsWith('.log')).map(file => readFileSync(join(TEST_LOGS_DIR, file), 'utf8')).join('');
    const found = text.split('\n').find(row => row.includes(marker));
    if (found) line = JSON.parse(found) as Record<string, unknown>;
  }
  expect(line).toMatchObject({ chatId: 'abcdef', msgId: '81a2b3', sessionKey: '6f7a8b#guest', nested: { chatId: 'oc_0123456789abcdef' } });
});
