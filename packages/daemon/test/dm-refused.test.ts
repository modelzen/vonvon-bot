import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { botPaths, paths } from '../src/config/paths';
import { createDmRefusal, DM_REFUSED_MAX, DM_REFUSED_MESSAGE, DM_REFUSED_REPLY_MS, DM_REFUSED_TTL_MS, readRefused } from '../src/bot/dm-refused';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'dm-refused-'));
  return { botPaths: (id: string) => ({ dir: join(appDir, 'bots', id) }), paths: { appDir } };
});
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

const appId = 'cli_fixture';
const file = () => join(botPaths(appId).dir, 'dm-refused.json');
beforeEach(async () => { await rm(paths.appDir, { recursive: true, force: true }); await mkdir(botPaths(appId).dir, { recursive: true }); });
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

function fixture(opts: { names?: Record<string, string>; sendFails?: boolean } = {}) {
  let now = 1_000_000;
  const send = vi.fn(async () => { if (opts.sendFails) throw new Error('send failed'); return {}; });
  const create = vi.fn(async () => ({ code: 0 }));
  const channel = { send, rawClient: { im: { v1: { message: { create } } } } } as unknown as LarkChannel;
  const lookupName = vi.fn(async (openId: string) => opts.names?.[openId]);
  const refuse = createDmRefusal({ channel, appId, now: () => now, lookupName });
  return { refuse, send, create, lookupName, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('turning a person away (dm-agent 3.5)', () => {
  it('replies in the chat, quoting the message, and records the person with the name Feishu gave', async () => {
    const t = fixture({ names: { ou_a: '张三' } });
    await t.refuse({ openId: 'ou_a', chatId: 'oc_p2p', replyTo: 'om_1' });
    expect(t.send).toHaveBeenCalledExactlyOnceWith('oc_p2p', { markdown: DM_REFUSED_MESSAGE }, { replyTo: 'om_1' });
    expect(DM_REFUSED_MESSAGE).toContain('「私聊 → 沟通方式 → 回应谁」');
    expect(t.lookupName).toHaveBeenCalledWith('ou_a', 'oc_p2p');
    expect(readRefused(appId, t.now())).toEqual([{ openId: 'ou_a', name: '张三', at: t.now() }]);
  });

  it('writes the file with the owner only', async () => {
    const t = fixture({ names: { ou_a: '张三' } });
    await t.refuse({ openId: 'ou_a', chatId: 'oc_p2p' });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ v: 1, people: [{ openId: 'ou_a' }] });
  });

  it('replies to the same person once in ten minutes, but keeps noting that they came', async () => {
    const t = fixture({ names: { ou_a: '张三' } });
    await t.refuse({ openId: 'ou_a', chatId: 'oc_p2p' });
    t.advance(DM_REFUSED_REPLY_MS - 1);
    await t.refuse({ openId: 'ou_a', chatId: 'oc_p2p' });
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(readRefused(appId, t.now())[0]?.at).toBe(t.now());
    expect(t.lookupName).toHaveBeenCalledTimes(1); // the name is kept, not asked for again
    t.advance(1);
    await t.refuse({ openId: 'ou_a', chatId: 'oc_p2p' });
    expect(t.send).toHaveBeenCalledTimes(2);
    await t.refuse({ openId: 'ou_b', chatId: 'oc_other' });
    expect(t.send).toHaveBeenCalledTimes(3);
  });

  it('does not record someone Feishu gives no name for, and does not ask again for ten minutes', async () => {
    const t = fixture();
    await t.refuse({ openId: 'ou_nameless', chatId: 'oc_p2p' });
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(readRefused(appId, t.now())).toEqual([]);
    t.advance(DM_REFUSED_REPLY_MS + 1);
    await t.refuse({ openId: 'ou_nameless', chatId: 'oc_p2p' });
    expect(t.lookupName).toHaveBeenCalledTimes(2);
    await t.refuse({ openId: 'ou_nameless', chatId: 'oc_p2p' });
    expect(t.lookupName).toHaveBeenCalledTimes(2);
  });

  it('answers the bot menu through the open id, where there is no chat', async () => {
    const t = fixture({ names: { ou_a: '张三' } });
    await t.refuse({ openId: 'ou_a' });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.create).toHaveBeenCalledWith({ params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_a', msg_type: 'text', content: JSON.stringify({ text: DM_REFUSED_MESSAGE }) } });
  });

  it('tries the reply again on the next message when it could not be sent, and still records', async () => {
    const t = fixture({ names: { ou_a: '张三' }, sendFails: true });
    await expect(t.refuse({ openId: 'ou_a', chatId: 'oc_p2p' })).resolves.toBeUndefined();
    await t.refuse({ openId: 'ou_a', chatId: 'oc_p2p' });
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(readRefused(appId, t.now())).toHaveLength(1);
  });

  it('keeps 20 people, the latest, and two turned away together are both written', async () => {
    const names = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`ou_${i}`, `人${i}`]));
    const t = fixture({ names });
    for (let i = 0; i < 20; i++) { t.advance(10); await t.refuse({ openId: `ou_${i}`, chatId: `oc_${i}` }); }
    expect(readRefused(appId, t.now())).toHaveLength(DM_REFUSED_MAX);
    t.advance(10);
    await Promise.all([t.refuse({ openId: 'ou_20', chatId: 'oc_20' }), t.refuse({ openId: 'ou_21', chatId: 'oc_21' })]);
    const kept = readRefused(appId, t.now()).map(person => person.openId);
    expect(kept).toHaveLength(DM_REFUSED_MAX);
    expect(kept).toEqual(expect.arrayContaining(['ou_20', 'ou_21']));
    expect(kept).not.toContain('ou_0');
    expect(kept).not.toContain('ou_1');
  });

  it('forgets after 30 days and reads a damaged file as nobody', async () => {
    await writeFile(file(), JSON.stringify({ v: 1, people: [{ openId: 'ou_a', name: '甲', at: 1000 }, { openId: 'ou_b', name: '乙', at: 1000 + DM_REFUSED_TTL_MS - 1 }] }));
    expect(readRefused(appId, 1000 + DM_REFUSED_TTL_MS).map(person => person.openId)).toEqual(['ou_b']);
    await writeFile(file(), '{not json');
    expect(readRefused(appId)).toEqual([]);
    await rm(file());
    expect(readRefused(appId)).toEqual([]);
  });
});
