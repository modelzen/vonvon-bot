import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppPreferences, AppConfig } from '../src/config/schema';
import { createFirstHello, FIRST_HELLO_RETRY_MS, firstHelloText } from '../src/bot/first-hello';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

const owner = 'ou_creator';
const newBot = (): AppConfig => ({ accounts: { app: { id: 'cli_fixture', secret: 'x', tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: owner, admins: [owner], firstHelloPending: true } } });

function fixture(cfg: AppConfig = newBot(), opts: { missingScopes?: string[]; botName?: string } = {}) {
  let now = 1_000_000;
  const create = vi.fn(async (_request: unknown): Promise<{ code?: number }> => ({ code: 0 }));
  const validate = vi.fn(async () => ({ ok: true, botName: opts.botName ?? '小助手', missingScopes: opts.missingScopes ?? [] }));
  const write = vi.fn(async (mutate: (preferences: AppPreferences) => void | Promise<void>) => {
    const next = structuredClone(cfg.preferences ?? {});
    await mutate(next);
    cfg.preferences = next;
    return next;
  });
  const channel = { rawClient: { im: { v1: { message: { create } } } } } as unknown as Pick<LarkChannel, 'rawClient'>;
  const start = () => createFirstHello({ cfg, appSecret: 'secret', channel, write, validate, now: () => now });
  return { cfg, create, validate, write, start, advance: (ms: number) => { now += ms; } };
}
const pending = (cfg: AppConfig) => cfg.preferences?.access?.firstHelloPending;

describe('the first hello (dm-agent 第一次见面)', () => {
  // Codex 审查任务 350 必败: told during the wait, it did nothing, and the client had stopped asking
  it('tries once more when the wait is over, told too soon', async () => {
    vi.useFakeTimers();
    try {
      const scopes = { missingScopes: ['im:message'] };
      const t = fixture(newBot(), scopes);
      const hello = t.start();
      await hello.attempt();
      expect(t.create).not.toHaveBeenCalled();
      t.advance(FIRST_HELLO_RETRY_MS / 3);
      scopes.missingScopes = [];
      await hello.attempt();
      await hello.attempt();
      expect(t.validate).toHaveBeenCalledTimes(1);
      t.advance(FIRST_HELLO_RETRY_MS);
      await vi.advanceTimersByTimeAsync(FIRST_HELLO_RETRY_MS);
      expect(t.validate).toHaveBeenCalledTimes(2);
      expect(t.create).toHaveBeenCalledTimes(1);
      expect(pending(t.cfg)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('does not come back after it stopped', async () => {
    vi.useFakeTimers();
    try {
      const t = fixture(newBot(), { missingScopes: ['im:message'] });
      const hello = t.start();
      await hello.attempt();
      await hello.attempt();
      hello.stop();
      t.advance(FIRST_HELLO_RETRY_MS);
      await vi.advanceTimersByTimeAsync(FIRST_HELLO_RETRY_MS);
      expect(t.validate).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('tells a new bot\'s creator once, in the fixed words with the bot\'s name, and takes the mark off', async () => {
    const t = fixture();
    const hello = t.start();
    await hello.attempt();
    expect(t.create).toHaveBeenCalledExactlyOnceWith({ params: { receive_id_type: 'open_id' },
      data: { receive_id: owner, msg_type: 'text', content: JSON.stringify({ text: firstHelloText('小助手') }), uuid: 'first-hello-cli_fixture' } });
    expect(firstHelloText('小助手').split('\n')).toHaveLength(5);
    expect(firstHelloText('小助手')).toContain('你好，我是小助手，有事私聊找我就行。');
    expect(pending(t.cfg)).toBeUndefined();
    t.advance(FIRST_HELLO_RETRY_MS);
    await hello.attempt();
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('does not greet again after a restart', async () => {
    const t = fixture();
    await t.start().attempt();
    await t.start().attempt();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.validate).toHaveBeenCalledTimes(1);
  });

  it('leaves an old bot, and one whose credentials were only refreshed, alone', async () => {
    const t = fixture({ accounts: newBot().accounts, preferences: { access: { ownerOpenId: owner, admins: [owner], adminsVersion: 2 } } });
    await t.start().attempt();
    expect(t.validate).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
  });

  it('keeps the mark while Feishu answers with an error code, and tries again later', async () => {
    const t = fixture();
    t.create.mockResolvedValueOnce({ code: 230013 });
    const hello = t.start();
    await hello.attempt();
    expect(pending(t.cfg)).toBe(true);
    t.advance(FIRST_HELLO_RETRY_MS);
    await hello.attempt();
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(pending(t.cfg)).toBeUndefined();
  });

  it('keeps the mark quietly when the send is rejected, also for the next process', async () => {
    const t = fixture();
    t.create.mockRejectedValueOnce(new Error('HTTP 400'));
    await expect(t.start().attempt()).resolves.toBeUndefined();
    expect(pending(t.cfg)).toBe(true);
    await t.start().attempt();
    expect(pending(t.cfg)).toBeUndefined();
  });

  it('waits for the required scopes even when the bot could already send', async () => {
    const t = fixture(newBot(), { missingScopes: ['im:message.p2p_msg:readonly'] });
    await t.start().attempt();
    expect(t.create).not.toHaveBeenCalled();
    expect(pending(t.cfg)).toBe(true);
  });

  it('waits when the scopes or the bot\'s name could not be read', async () => {
    const t = fixture();
    t.validate.mockResolvedValueOnce({ ok: true, botName: '小助手', missingScopes: undefined as unknown as string[] });
    await t.start().attempt();
    t.validate.mockResolvedValueOnce({ ok: true, botName: undefined as unknown as string, missingScopes: [] });
    await t.start().attempt();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('asks Feishu at most once a minute, whoever calls, and one at a time', async () => {
    const t = fixture();
    t.create.mockResolvedValue({ code: 230013 });
    const hello = t.start();
    await Promise.all([hello.attempt(), hello.attempt()]);
    t.advance(FIRST_HELLO_RETRY_MS - 1);
    await hello.attempt();
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('does not send twice when the mark could not be taken off', async () => {
    const t = fixture();
    t.write.mockRejectedValueOnce(new Error('disk full'));
    const hello = t.start();
    await hello.attempt();
    expect(pending(t.cfg)).toBe(true);
    t.advance(FIRST_HELLO_RETRY_MS);
    await hello.attempt();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(pending(t.cfg)).toBeUndefined();
  });

  it('does not invite a creator who was taken off the list', async () => {
    const cfg = newBot();
    cfg.preferences!.access!.admins = ['ou_other'];
    const t = fixture(cfg);
    await t.start().attempt();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('starts nothing once the bot is stopping', async () => {
    const t = fixture();
    const hello = t.start();
    hello.stop();
    await hello.attempt();
    expect(t.validate).not.toHaveBeenCalled();
  });
});
