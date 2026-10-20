import { describe, expect, it, vi } from 'vitest';
import { bareText, nameCalled, smartSalience, type SalienceDeps } from '../src/bot/salience';
import type { RecentLine } from '../src/bot/recent-lines';
import { receive } from './helpers/lark-events';

const BOT = { openId: 'ou_bot', name: '小码' };
const line = (from: RecentLine['from'], extra: Partial<RecentLine> = {}): RecentLine => ({ id: 'om_q', at: 1, from, name: '张三', text: '问题', ...extra });
async function msg(text: string, o: { at?: boolean; mentions?: { key: string; openId: string; name: string }[]; thread?: string; parent?: string; root?: string; all?: boolean } = {}) {
  const mentions = (o.mentions ?? []).map(({ key, openId, name }) => ({ key, id: { open_id: openId }, name }));
  if (o.at) mentions.push({ key: '@_user_1', id: { open_id: BOT.openId }, name: BOT.name });
  if (o.all) mentions.push({ key: '@_all', id: { open_id: 'all' }, name: '所有人' });
  return receive({
    message_id: 'om_m', create_time: '1000', chat_id: 'oc_demo', chat_type: 'group', message_type: 'text',
    content: JSON.stringify({ text: o.at ? `@_user_1 ${text}` : text }), mentions,
    ...(o.thread ? { thread_id: o.thread } : {}), ...(o.parent ? { parent_id: o.parent } : {}), ...(o.root ? { root_id: o.root } : {}),
  }, { bot: BOT });
}
function deps(over: Partial<SalienceDeps> = {}) {
  return { botName: BOT.name, quoted: vi.fn<SalienceDeps['quoted']>(() => undefined), lookup: vi.fn<SalienceDeps['lookup']>(async () => undefined), rootFrom: vi.fn<SalienceDeps['rootFrom']>(async () => undefined), ...over };
}

describe('smart salience (s25e)', () => {
  it('1: at-me needs no lookup, even when quoting someone else', async () => {
    const d = deps({ quoted: () => line('user') });
    for (const parent of [undefined, 'om_q']) expect(await smartSalience(await msg('看下', { at: true, parent }), d)).toEqual({ kind: 'at-me' });
    expect(d.lookup).not.toHaveBeenCalled();
    expect(d.rootFrom).not.toHaveBeenCalled();
  });
  it('2: trusts a quoted line in the ring without fetching it', async () => {
    for (const from of ['self', 'user'] as const) {
      const d = deps({ quoted: () => line(from) });
      expect(await smartSalience(await msg('这个呢', { parent: 'om_q' }), d)).toEqual(from === 'self' ? { kind: 'quote-me', by: 'quote' } : { kind: 'plain' });
      expect(d.lookup).not.toHaveBeenCalled();
    }
  });
  it('3: fetches missing quotes and recognizes a name when none is found', async () => {
    for (const from of ['self', 'user', undefined] as const) {
      const lookup = vi.fn<SalienceDeps['lookup']>(async () => from ? { from } : undefined);
      expect(await smartSalience(await msg('这个呢', { parent: 'om_q' }), deps({ lookup }))).toEqual(from === 'self' ? { kind: 'quote-me', by: 'quote' } : { kind: 'plain' });
      expect(lookup).toHaveBeenCalledWith('om_q');
    }
    expect(await smartSalience(await msg('小码 看下', { parent: 'om_missing' }), deps())).toEqual({ kind: 'name' });
  });
  it('4: recognizes topic roots, while replies to specific messages use their quotes', async () => {
    const o = { thread: 'omt_t', root: 'om_r', parent: 'om_r' };
    for (const from of ['self', 'other', undefined] as const) {
      const rootFrom = vi.fn<SalienceDeps['rootFrom']>(async () => from);
      expect(await smartSalience(await msg('继续', o), deps({ rootFrom }))).toEqual(from === 'self' ? { kind: 'quote-me', by: 'root' } : { kind: 'plain' });
      expect(rootFrom).toHaveBeenCalledWith('oc_demo', 'omt_t', 'om_r');
    }
    const d = deps();
    expect(await smartSalience(await msg('继续', { ...o, parent: 'om_x' }), d)).toEqual({ kind: 'plain' });
    expect(d.lookup).toHaveBeenCalledWith('om_x');
    expect(d.rootFrom).not.toHaveBeenCalled();
    expect(await smartSalience(await msg('帖子', { ...o, parent: 'om_m', root: 'om_m' }), d)).toEqual({ kind: 'plain' });
    expect(d.rootFrom).not.toHaveBeenCalled();
  });
  it('5: recognizes full and partial non-ASCII names, excluding short and common names', () => {
    const cases: [string, string | undefined, ReturnType<typeof nameCalled>][] = [
      ['小码 看下 128', '小码', 'full'], ['小码 看下', '小码助手', 'partial'], ['小码助手看下', '小码助手', 'full'],
      ['码 看下', '码', 'none'], ['助手 看下', '助手', 'none'], ['机器人来', '机器人', 'none'],
      ['没叫', '小码', 'none'], ['x', undefined, 'none'], ['x', '  ', 'none'],
    ];
    for (const [text, name, expected] of cases) expect(nameCalled(text, name)).toBe(expected);
  });
  it('6: ASCII names require word boundaries, three characters and a non-common name', () => {
    const cases: [string, string, ReturnType<typeof nameCalled>][] = [
      ['cody look', 'Cody', 'full'], ['Cody, look', 'Cody', 'full'], ['encodyx', 'Cody', 'none'], ['cody_1', 'Cody', 'none'],
      ['ai 看下', 'AI', 'none'], ['abc', 'ab', 'none'], ['run the Test', 'Test', 'none'], ['cod', 'Cody', 'none'],
    ];
    for (const [text, name, expected] of cases) expect(nameCalled(text, name)).toBe(expected);
  });
  it('7: strips mention names, keeps typed names, and uses content without raw', async () => {
    const m = await msg('@_user_2 小码 看下', { mentions: [{ key: '@_user_2', openId: 'ou_x', name: '小审' }] });
    expect(bareText(m)).not.toContain('小审');
    expect(bareText(m)).toContain('小码');
    expect(await smartSalience(m, deps())).toEqual({ kind: 'name' });
    const other = await msg('@_user_2 看下', { mentions: [{ key: '@_user_2', openId: 'ou_x', name: '小码' }] });
    expect(await smartSalience(other, deps())).toEqual({ kind: 'plain' });
    expect(await smartSalience(await msg('@_all 开会', { all: true }), deps())).toEqual({ kind: 'plain' });
    expect(bareText({ ...m, raw: undefined })).toBe(m.content);
  });
  it('8: prioritizes quotes and at-me over names and absorbs lookup failures', async () => {
    expect(await smartSalience(await msg('小码 看下', { parent: 'om_q' }), deps({ quoted: () => line('self') }))).toEqual({ kind: 'quote-me', by: 'quote' });
    expect(await smartSalience(await msg('小码 看下', { at: true }), deps())).toEqual({ kind: 'at-me' });
    expect(await smartSalience(await msg('看下', { parent: 'om_q' }), deps({ lookup: vi.fn().mockRejectedValue(new Error('offline')) }))).toEqual({ kind: 'plain' });
  });
});
