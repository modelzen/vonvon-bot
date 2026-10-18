import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../src/core/logger';
import { fetchTopicLastBot, scanTopic } from '../src/bot/context-weave';

/** Who sent an item: the asker (ou_a), another person, this bot, another bot, anonymous, a system notice. */
const SENDERS = {
  asker: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' },
  other: { id: 'ou_b', id_type: 'open_id', sender_type: 'user' },
  self: { id: 'cli_me', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_bot' },
  bot: { id: 'cli_x', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_x' },
  anonymous: { id: '', sender_type: 'anonymous' },
  system: undefined,
} as const;
type Who = keyof typeof SENDERS;
const item = (who: Who, extra: object = {}) => ({ message_id: `om_${who}`, msg_type: who === 'system' ? 'system' : 'text', sender: SENDERS[who], ...extra });

/** Serves `pages` newest first, one per call; a page that is 'fail' answers a non-zero code, 'hang' never answers. */
function channel(pages: Array<Array<ReturnType<typeof item>> | 'fail' | 'hang'>, more = false) {
  const list = vi.fn(async ({ params }: { params: { page_token?: string } }) => {
    const at = Number(params.page_token ?? 0);
    const page = pages[at]!;
    if (page === 'fail') return { code: 230002, msg: 'Bot is not in the chat' };
    if (page === 'hang') return new Promise(() => undefined);
    const next = at + 1 < pages.length || more;
    return { code: 0, data: { items: page, has_more: next, page_token: next ? String(at + 1) : undefined } };
  });
  const ch = { botIdentity: { openId: 'ou_bot' }, rawClient: { appId: 'cli_me', im: { v1: { message: { list } } } } } as unknown as LarkChannel;
  return { ch, list };
}

beforeEach(() => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  vi.spyOn(log, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('fetchTopicLastBot (rule mode, unchanged by s25b)', () => {
  it('stops at the first bot, a deleted one too', async () => {
    const c = channel([[item('other'), item('self', { deleted: true }), item('bot')], [item('bot')]]);
    expect(await fetchTopicLastBot(c.ch, 'omt_t', 3000)).toBe('self');
    expect(c.list).toHaveBeenCalledTimes(1);
  });

  it('a later page that fails before any bot: unknown; three full pages without one: none', async () => {
    expect(await fetchTopicLastBot(channel([[item('asker')], 'fail']).ch, 'omt_t', 3000)).toBeUndefined();
    const full = channel([[item('asker')], [item('other')], [item('asker')]], true);
    expect(await fetchTopicLastBot(full.ch, 'omt_t', 3000)).toBe('none');
    expect(full.list).toHaveBeenCalledTimes(3);
  });
});

describe('scanTopic (s25b)', () => {
  const scan = async (c: ReturnType<typeof channel>, deadlineMs = 3000) => {
    const s = scanTopic(c.ch, 'omt_t', 'ou_a', deadlineMs);
    return { lastBot: await s.lastBot, solo: await s.solo, calls: c.list.mock.calls.length };
  };

  it('this bot spoke last and only the asker talks: solo, read to the start or three whole pages (M2)', async () => {
    expect(await scan(channel([[item('asker'), item('self')], [item('asker'), item('system'), item('other', { deleted: true })]])))
      .toEqual({ lastBot: 'self', solo: true, calls: 2 });
    expect(await scan(channel([[item('asker'), item('self')], [item('asker')], [item('asker')]], true)))
      .toEqual({ lastBot: 'self', solo: true, calls: 3 });
  });

  it('another bot further back keeps the first one met; it does not end solo (M3)', async () => {
    expect(await scan(channel([[item('self'), item('asker'), item('bot')], [item('asker')]]))).toEqual({ lastBot: 'self', solo: true, calls: 2 });
  });

  it('someone else, or anyone not a person known by open_id, ends solo; the walk stops once the last bot is known', async () => {
    expect(await scan(channel([[item('self')], [item('other')], [item('asker')]]))).toEqual({ lastBot: 'self', solo: false, calls: 2 });
    expect(await scan(channel([[item('anonymous'), item('asker')], [item('self')], [item('asker')]]))).toEqual({ lastBot: 'self', solo: false, calls: 2 });
    expect(await scan(channel([[item('self'), item('asker', { sender: { ...SENDERS.asker, id_type: 'user_id' } })]]))).toMatchObject({ solo: false });
  });

  it('another bot spoke last: its topic, not solo, read no further', async () => {
    expect(await scan(channel([[item('asker'), item('bot'), item('self')], [item('asker')]]))).toEqual({ lastBot: 'bot', solo: false, calls: 1 });
  });

  it('this bot never spoke here: none, not solo', async () => {
    expect(await scan(channel([[item('asker')]]))).toEqual({ lastBot: 'none', solo: false, calls: 1 });
  });

  it('a later page that fails keeps the last bot read but is not solo; before any bot, it is unknown (M3)', async () => {
    expect(await scan(channel([[item('self')], 'fail']))).toEqual({ lastBot: 'self', solo: false, calls: 2 });
    expect(await scan(channel([[item('asker')], 'fail']))).toEqual({ lastBot: undefined, solo: false, calls: 2 });
    expect(await scan(channel(['fail']))).toEqual({ lastBot: undefined, solo: false, calls: 1 });
  });

  it('the last bot is known as soon as it is read: 三条底线 does not wait for the rest of the walk (M1)', async () => {
    vi.useFakeTimers();
    try {
      const s = scanTopic(channel([[item('self'), item('asker')], 'hang']).ch, 'omt_t', 'ou_a', 3000);
      let solo: boolean | undefined;
      void s.solo.then((v) => { solo = v; });
      expect(await s.lastBot).toBe('self');
      expect(solo).toBeUndefined();
      // One deadline for all pages: the hung page ends it, not solo.
      await vi.advanceTimersByTimeAsync(3000);
      expect(solo).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
