import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { createBotRoster, ROSTER_TTL_MS } from '../src/bot/bot-roster';
import { readResponseRoster, responseMemberLabel } from '../src/bot/response-members';
import { buildAddAllowedCard } from '../src/card/dm-cards';

const bot = { member_id: 'ou_bot_peer', name: '同名', app_id: 'cli_peer' };
function fixture() {
  const get = vi.fn().mockResolvedValue({ code: 0, data: { items: [{ member_id: 'ou_person', name: '同名' }], has_more: false } });
  const request = vi.fn().mockResolvedValue({ code: 0, data: { bots: [bot], has_more: false } });
  const channel = { botIdentity: { openId: 'ou_self', name: 'Self' }, rawClient: { appId: 'cli_fixture', request, im: { v1: { chatMembers: { get } } } } } as unknown as LarkChannel;
  const roster = createBotRoster(channel, { stop: p => p });
  return { channel, roster, get, request, read: () => readResponseRoster(channel, roster, 'oc_fixture') };
}
afterEach(() => vi.useRealTimers());

it('merges people and bots by this app open_id, with distinguishable same-name labels', async () => {
  const f = fixture();
  const result = await f.read();
  expect(result).toMatchObject({ state: 'complete', otherBots: true });
  expect(result.entries.map(responseMemberLabel)).toEqual(['同名 · Bot · …t_peer', 'Self · Bot · …u_self', '同名 · …person']);
  const card = JSON.stringify(buildAddAllowedCard('fixture', result));
  expect(card).toContain('ou_bot_peer');
  expect(card).toContain('同名 · Bot');
  expect(card).not.toContain('未完整读取');
});
it('deduplicates by ID, preferring the bot source', async () => {
  const f = fixture();
  f.get.mockResolvedValue({ code: 0, data: { items: [{ member_id: bot.member_id, name: 'same' }], has_more: false } });
  expect((await f.read()).entries.filter(m => m.openId === bot.member_id)).toEqual([{ openId: bot.member_id, name: bot.name, kind: 'bot' }]);
});
it.each(['people', 'bots', 'both'])('keeps a readable partial roster or unavailable status on %s failure', async failed => {
  const f = fixture();
  if (failed !== 'bots') f.get.mockRejectedValue(new Error('denied'));
  if (failed !== 'people') f.request.mockResolvedValue({ code: 99991672 });
  const result = await f.read();
  expect(result.state).toBe(failed === 'both' ? 'unavailable' : 'partial');
  expect(result.otherBots).toBe(failed === 'people');
  expect(JSON.stringify(buildAddAllowedCard('fixture', result))).toContain('已有响应名单不受影响');
});
it('marks either source having more pages as partial', async () => {
  const f = fixture();
  f.get.mockResolvedValue({ code: 0, data: { items: [], has_more: true } });
  expect((await f.read()).state).toBe('partial');
  f.get.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  f.request.mockResolvedValue({ code: 0, data: { bots: [bot], has_more: true } });
  const other = createBotRoster(f.channel, { stop: p => p });
  expect((await readResponseRoster(f.channel, other, 'oc_other')).state).toBe('partial');
});
it('does not offer stale bots after refresh fails, while outgoing guards keep their snapshot', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.read();
  await vi.advanceTimersByTimeAsync(ROSTER_TTL_MS);
  f.request.mockRejectedValue(new Error('offline'));
  const result = await f.read();
  expect(result.state).toBe('partial');
  expect(result.entries.every(m => m.kind === 'person')).toBe(true);
  expect(result.otherBots).toBe(false);
  expect(f.roster.peek('oc_fixture')?.has(bot.member_id)).toBe(true);
});
it('times out a hanging human read without losing the bots', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.get.mockImplementation(() => new Promise(() => {}));
  const pending = f.read(); await vi.advanceTimersByTimeAsync(3_000);
  expect(await pending).toMatchObject({ state: 'partial', otherBots: true });
});
it('bounds the DM menu and retains manual fallback', async () => {
  const result = await fixture().read();
  result.entries.push(...Array.from({ length: 60 }, (_, i) => ({ openId: `ou_fixture_${i}`, name: `Fixture ${i}`, kind: 'person' as const })));
  const card = JSON.stringify(buildAddAllowedCard('fixture', result));
  expect(card).toContain('仅列前 50');
  expect(card).toContain('ou_bot_peer');
  expect(card).toContain('open_id');
  expect(card).not.toContain('Fixture 59');
});
