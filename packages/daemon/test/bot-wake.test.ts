import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { BOT_TRIGGER_MAX, BOT_WAKE_CAP, countBotWakes, wakeTables, wakeTriggerText, type WakeTables } from '../src/bot/bot-wake';
import type { RosterBot } from '../src/bot/bot-roster';
import { fetchChatContext, fetchThreadContext, type ContextMessage } from '../src/bot/context-weave';
import { BOT_WAKE_NOTE } from '../src/bot/session-title';

// s27a-0, all new on main.
const ME = { openId: 'ou_me', appId: 'cli_me' };
const roster = new Map<string, RosterBot>([
  ['ou_x', { appId: 'cli_x', name: 'X' }],
  ['ou_c', { appId: 'cli_c', name: 'C' }],
  ['ou_me', { appId: 'cli_me', name: '我' }],
]);
const T = wakeTables(roster);

let clock = 1000;
const user = (id: string, extra: Partial<ContextMessage> = {}): ContextMessage =>
  ({ messageId: id, senderName: '张三', text: '说一句', from: 'user', senderId: 'ou_zhang', createTime: clock++, ...extra });
/** Another bot's message: from its app, listed with its open_bot_id in this reader's namespace. */
const bot = (id: string, app: string, extra: Partial<ContextMessage> = {}): ContextMessage => ({
  messageId: id, senderName: app, text: '', from: app === 'cli_me' ? 'self' : 'bot', createTime: clock++,
  senderAppId: app, msgType: 'text', ...extra,
  ...(extra.senderId === undefined && T.byAppId.get(app) ? { senderId: T.byAppId.get(app)!.openId } : {}),
});
const atBot = (id: string, app: string, to: string[], extra: Partial<ContextMessage> = {}) => bot(id, app, { mentionIds: to, ...extra });
const count = (msgs: ContextMessage[], triggerId = msgs.at(-1)!.messageId, complete = true, tables: WakeTables = T) =>
  countBotWakes(msgs, { messageId: triggerId, createTime: msgs.at(-1)?.createTime ?? 0 }, ME, tables, complete);

describe('countBotWakes: the boundary', () => {
  it('counts from the last person\'s message, the trigger included', () => {
    const msgs = [atBot('o1', 'cli_x', ['ou_me']), atBot('o2', 'cli_me', ['ou_x']), user('u'), atBot('b1', 'cli_x', ['ou_me']),
      atBot('b2', 'cli_me', ['ou_x']), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(msgs)).toMatchObject({ kind: 'ok', n: 3, listed: true, counted: { mentioned: 3, replied: 0 } });
    const twoPeople = [user('u1'), atBot('b0', 'cli_x', ['ou_me']), user('u2'), atBot('b1', 'cli_me', ['ou_x']), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(twoPeople).n).toBe(2);
  });

  it('with no person read: from the start when the list was read whole; else only a count past the cap stands', () => {
    const six = Array.from({ length: 6 }, (_, i) => atBot(`b${i}`, i % 2 ? 'cli_me' : 'cli_x', [i % 2 ? 'ou_x' : 'ou_me']));
    expect(count(six, 'b5', true)).toMatchObject({ kind: 'ok', n: 6 });
    expect(count(six, 'b5', false)).toMatchObject({ kind: 'failed', n: 6 });
    const seven = [...six, atBot('b6', 'cli_x', ['ou_me'])];
    expect(count(seven, 'b6', false)).toMatchObject({ kind: 'ok', n: BOT_WAKE_CAP + 1 });
    // A person found makes the count good even when the pull stopped early (stopWhen).
    expect(count([user('u'), atBot('t', 'cli_x', ['ou_me'])], 't', false)).toMatchObject({ kind: 'ok', n: 1 });
  });

  it('a person\'s message sent after the trigger is not the boundary (H3)', () => {
    const msgs = [user('u'), atBot('b1', 'cli_x', ['ou_me']), atBot('t', 'cli_me', ['ou_x'])];
    const later = user('later');
    expect(countBotWakes([...msgs, later], { messageId: 't', createTime: msgs.at(-1)!.createTime }, ME, T, true).n).toBe(2);
  });

  it('a trigger with no time bounds nothing, so the count fails (E4)', () => {
    const msgs = [user('u'), atBot('b1', 'cli_x', ['ou_me']), atBot('t', 'cli_me', ['ou_x'])];
    const later = user('later'); // sent after the trigger: with no time to bound it, it would end the count
    expect(countBotWakes([...msgs, later], { messageId: 't', createTime: 0 }, ME, T, true)).toMatchObject({ kind: 'failed' });
    expect(countBotWakes(msgs, { messageId: 't', createTime: Number.NaN }, ME, T, true)).toMatchObject({ kind: 'failed' });
    expect(countBotWakes(msgs, { messageId: 't', createTime: msgs.at(-1)!.createTime }, ME, T, true)).toMatchObject({ kind: 'ok', n: 2 });
  });

  it('a person\'s message with an empty text (a bare @) is still the boundary', () => {
    const msgs = [atBot('o1', 'cli_x', ['ou_me']), user('u', { text: '' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(msgs).n).toBe(1);
  });
});

describe('countBotWakes: (a) an @ to a bot of the list', () => {
  it('counts an @ to another bot of the list; an @ to its own sender, to someone not in the list, or none, does not', () => {
    const msgs = [user('u'),
      atBot('self-at', 'cli_x', ['ou_x']), // @ itself
      atBot('self-at-no-id', 'cli_c', ['ou_c'], { senderId: undefined }), // its open_bot_id missing: known by its app_id
      atBot('person', 'cli_x', ['ou_zhang']),
      bot('plain', 'cli_c', { text: '没 @ 谁' }),
      atBot('t', 'cli_x', ['ou_me'])];
    expect(count(msgs)).toMatchObject({ n: 1, counted: { mentioned: 1 } });
  });

  it('counts a message that @-s two bots once; counts my own @ to another bot; counts a post the same as a text', () => {
    const msgs = [user('u'), atBot('two', 'cli_x', ['ou_me', 'ou_c']), atBot('mine', 'cli_me', ['ou_x']),
      atBot('post', 'cli_c', ['ou_x'], { msgType: 'post' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(msgs)).toMatchObject({ n: 4, counted: { mentioned: 4 } });
  });

  it('a card shows no @ in the list (s27 probe): it counts only as the trigger or by (b)', () => {
    const msgs = [user('u'), bot('card', 'cli_x', { msgType: 'interactive' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(msgs).n).toBe(1);
  });

  it('a bot of the list that never spoke counts when @-ed; one more bot in the list changes nothing else', () => {
    const msgs = [user('u'), atBot('quiet', 'cli_x', ['ou_c']), bot('plain', 'cli_me', { text: '好' }), atBot('t', 'cli_x', ['ou_me'])];
    const more = wakeTables(new Map([...roster, ['ou_new', { appId: 'cli_new', name: '新来的' }]]));
    expect(count(msgs).n).toBe(2);
    expect(count(msgs, 't', true, more).n).toBe(2);
  });
});

describe('countBotWakes: (b) a reply from another app', () => {
  it('counts a card another app replied to, not one its own app replied to', () => {
    const msgs = [user('u'),
      bot('xc1', 'cli_x', { msgType: 'interactive' }), bot('mc1', 'cli_me', { msgType: 'interactive', parentId: 'xc1', rootId: 'xc1' }),
      bot('xc2', 'cli_x', { msgType: 'interactive' }), bot('xc3', 'cli_x', { msgType: 'interactive', parentId: 'xc2', rootId: 'xc2' }),
      bot('t', 'cli_x', { msgType: 'interactive' })];
    expect(count(msgs)).toMatchObject({ n: 2, counted: { mentioned: 0, replied: 1 } }); // xc1, and the trigger
  });

  it('a message posted straight into a topic replies to nothing; a reply to the topic\'s first message in the main area does', () => {
    const inTopic = [user('u'), bot('root', 'cli_x', { threadId: 'omt_1' }),
      bot('r', 'cli_me', { threadId: 'omt_1', parentId: 'root', rootId: 'root' }), atBot('t', 'cli_x', ['ou_me'], { threadId: 'omt_1' })];
    expect(count(inTopic).n).toBe(1);
    const quoted = [user('u'), bot('p', 'cli_x'), bot('r', 'cli_me', { parentId: 'p', rootId: 'p' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(quoted).n).toBe(2);
  });

  it('counts P when my answer quoting it got a topic opened under it later (L1: parent = root = P, P in no topic)', () => {
    const msgs = [user('u'), bot('p', 'cli_x', { msgType: 'interactive' }),
      bot('r', 'cli_me', { msgType: 'interactive', threadId: 'omt_r', parentId: 'p', rootId: 'p' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(msgs)).toMatchObject({ n: 2, counted: { replied: 1 } });
  });

  it('does not count a reply to a message before the boundary, nor an (a) and a (b) of one message twice', () => {
    const before = [bot('old', 'cli_x'), user('u'), bot('r', 'cli_me', { parentId: 'old', rootId: 'old' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(before).n).toBe(1);
    const both = [user('u'), atBot('p', 'cli_x', ['ou_me']), bot('r', 'cli_me', { parentId: 'p', rootId: 'p' }), atBot('t', 'cli_x', ['ou_me'])];
    expect(count(both)).toMatchObject({ n: 2, counted: { mentioned: 2, replied: 0 } });
  });
});

describe('countBotWakes: the trigger', () => {
  it('counts a listed trigger with no @ to see (another bot\'s card), and adds one for a trigger not listed yet', () => {
    const card = [user('u'), bot('t', 'cli_x', { msgType: 'interactive' })];
    expect(count(card)).toMatchObject({ n: 1, listed: true, trigger: expect.objectContaining({ messageId: 't' }) });
    const early = [user('u'), atBot('b1', 'cli_x', ['ou_me'])];
    const r = count(early, 'om_not_yet');
    expect(r).toMatchObject({ n: 2, listed: false });
    expect(r.trigger).toBeUndefined();
  });
});

describe('countBotWakes: every reader counts the same (H2)', () => {
  // One chat as two readers list it: B (the bot X @-s) and C (a third bot). Each list has the reader's own open_ids in
  // `mentions[].id` and `open_bot_id`; `sender.id` is the app_id, the same for both (s27 probe).
  const NS = {
    b: { me: { openId: 'ou_b_b', appId: 'cli_b', name: 'B' }, x: 'ou_b_x', c: 'ou_b_c', person: 'ou_b_p' },
    c: { me: { openId: 'ou_c_c', appId: 'cli_c', name: 'C' }, x: 'ou_c_x', b: 'ou_c_b', person: 'ou_c_p' },
  } as const;
  type Reader = keyof typeof NS;
  const ids = (r: Reader) => r === 'b'
    ? { x: NS.b.x, b: NS.b.me.openId, c: NS.b.c, person: NS.b.person }
    : { x: NS.c.x, b: NS.c.b, c: NS.c.me.openId, person: NS.c.person };
  const sender = (app: string, openId: string, name: string) => ({ id: app, id_type: 'app_id', sender_type: 'app', sender_name: name, open_bot_id: openId });
  const text = (atKeys: string) => ({ content: JSON.stringify({ text: atKeys }) });
  /** Newest first, as the list returns them. */
  function raw(r: Reader, xBareAts = 0): object[] {
    const id = ids(r);
    const atB = [{ key: '@_user_1', id: id.b, id_type: 'open_id', name: 'B' }];
    const card = { content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '卡片回答' }] } }) };
    const items: object[] = [
      { message_id: 'om_t', msg_type: 'text', create_time: '9000', sender: sender('cli_x', id.x, 'X'), body: text('@_user_1'), mentions: atB },
      ...Array.from({ length: xBareAts }, (_, i) => ({ message_id: `om_bare${i}`, msg_type: 'text', create_time: String(8900 - i),
        sender: sender('cli_x', id.x, 'X'), body: text('@_user_1'), mentions: atB })),
      { message_id: 'om_bc2', msg_type: 'interactive', create_time: '8000', parent_id: 'om_xc', root_id: 'om_xc', sender: sender('cli_b', id.b, 'B'), body: card },
      { message_id: 'om_xc', msg_type: 'interactive', create_time: '7000', sender: sender('cli_x', id.x, 'X'), body: card },
      { message_id: 'om_bc1', msg_type: 'interactive', create_time: '6000', parent_id: 'om_x1', root_id: 'om_x1', sender: sender('cli_b', id.b, 'B'), body: card },
      { message_id: 'om_x1', msg_type: 'post', create_time: '5000', sender: sender('cli_x', id.x, 'X'),
        body: { content: JSON.stringify({ title: '', content: [[{ tag: 'at', user_id: '@_user_1', user_name: 'B' }, { tag: 'text', text: ' 请审一下' }]] }) },
        mentions: atB },
      // A person's bare @ to B: empty text for B, still the boundary.
      { message_id: 'om_p', msg_type: 'text', create_time: '4000', sender: { id: id.person, id_type: 'open_id', sender_type: 'user', sender_name: '张三' },
        body: text('@_user_1'), mentions: atB },
      { message_id: 'om_old', msg_type: 'text', create_time: '3000', sender: sender('cli_x', id.x, 'X'), body: text('@_user_1 更早的'), mentions: atB },
    ];
    return items;
  }
  function channel(r: Reader, items: object[]): LarkChannel {
    const me = NS[r].me;
    return { botIdentity: { openId: me.openId, name: me.name }, rawClient: { appId: me.appId, im: { v1: { message: {
      list: async () => ({ code: 0, data: { items, has_more: false } }),
    } } } } } as unknown as LarkChannel;
  }
  function tables(r: Reader): WakeTables {
    const id = ids(r);
    return wakeTables(new Map<string, RosterBot>([
      [id.x, { appId: 'cli_x', name: 'X' }], [id.b, { appId: 'cli_b', name: 'B' }], [id.c, { appId: 'cli_c', name: 'C' }],
    ]));
  }
  async function countAs(r: Reader, xBareAts = 0) {
    const pull = await fetchChatContext(channel(r, raw(r, xBareAts)), 'oc_chat',
      { before: 9000, keepSelf: true, mentions: true, stopWhen: (m) => m.from === 'user' });
    const me = NS[r].me;
    return { pull, count: countBotWakes(pull.messages, { messageId: 'om_t', createTime: 9000 }, { openId: me.openId, appId: me.appId }, tables(r), pull.complete) };
  }

  it('B, the bot @-ed, and C, a third bot, count the same from their own lists', async () => {
    const b = await countAs('b');
    const c = await countAs('c');
    // om_x1 (a post @ B), om_xc (a card B replied to), the trigger; B's own cards replied to nothing of another app.
    expect(b.count).toMatchObject({ kind: 'ok', n: 3, listed: true, counted: { mentioned: 2, replied: 1 } });
    expect(c.count).toMatchObject({ kind: 'ok', n: 3, listed: true, counted: { mentioned: 2, replied: 1 } });
    expect(b.pull.messages.find((m) => m.messageId === 'om_p')?.text).toBe(''); // kept with `mentions`
  });

  it('X sending five bare @ B in a row makes the next one the 6th, for both', async () => {
    const bare = (r: Reader): object[] => {
      const id = ids(r);
      const atB = [{ key: '@_user_1', id: id.b, id_type: 'open_id', name: 'B' }];
      return [
        ...Array.from({ length: 6 }, (_, i) => ({ message_id: i === 0 ? 'om_t' : `om_bare${i}`, msg_type: 'text', create_time: String(9000 - i),
          sender: sender('cli_x', id.x, 'X'), body: text('@_user_1'), mentions: atB })),
        { message_id: 'om_p', msg_type: 'text', create_time: '4000', sender: { id: id.person, id_type: 'open_id', sender_type: 'user', sender_name: '张三' },
          body: text('@_user_1'), mentions: atB },
        { message_id: 'om_old', msg_type: 'text', create_time: '3000', sender: sender('cli_x', id.x, 'X'), body: text('@_user_1'), mentions: atB },
      ];
    };
    const n = async (r: Reader) => {
      const pull = await fetchChatContext(channel(r, bare(r)), 'oc_chat', { before: 9000, keepSelf: true, mentions: true, stopWhen: (m) => m.from === 'user' });
      return countBotWakes(pull.messages, { messageId: 'om_t', createTime: 9000 }, NS[r].me, tables(r), pull.complete).n;
    };
    expect([await n('b'), await n('c')]).toEqual([6, 6]);
    // With the in-between messages too: 5 bare, om_x1, om_xc and the trigger.
    expect([(await countAs('b', 5)).count.n, (await countAs('c', 5)).count.n]).toEqual([8, 8]);
  });

  it('a topic pull counts the same way', async () => {
    // In a topic, root_id is its first message (the person's, here); a quote reply's parent_id is still what it quotes.
    const items = raw('b').map((it) => ({ ...it, thread_id: 'omt_1', ...('parent_id' in it ? { root_id: 'om_p' } : {}) }));
    const ch = channel('b', items);
    const pull = await fetchThreadContext(ch, 'omt_1', { before: 9000, keepSelf: true, mentions: true, stopWhen: (m) => m.from === 'user' });
    expect(countBotWakes(pull.messages, { messageId: 'om_t', createTime: 9000 }, NS.b.me, tables('b'), pull.complete).n).toBe(3);
  });
});

describe('wakeTriggerText', () => {
  const msg = (content: string, rawContentType = 'text') => ({ content, rawContentType });

  it('takes a text or post as the event has it, a card from the pull, else from the lookup', () => {
    expect(wakeTriggerText(msg('请审一下'), undefined)).toBe('请审一下');
    expect(wakeTriggerText(msg('标题 正文', 'post'), undefined)).toBe('标题 正文');
    expect(wakeTriggerText(msg('[卡片]', 'interactive'), { text: '卡片正文' }, '查到的')).toBe('卡片正文');
    expect(wakeTriggerText(msg('[卡片]', 'interactive'), { text: '  ' }, '查到的')).toBe('查到的');
    expect(wakeTriggerText(msg('[卡片]', 'interactive'), undefined, '查到的')).toBe('查到的');
  });

  it('says so when there is no text, and cuts a long one with a note', () => {
    expect(wakeTriggerText(msg('  '), undefined)).toBe('（对方没有给出文字回答）');
    expect(wakeTriggerText(msg('', 'interactive'), undefined)).toBe('（对方没有给出文字回答）');
    expect(wakeTriggerText(msg('字'.repeat(BOT_TRIGGER_MAX)), undefined)).toBe('字'.repeat(BOT_TRIGGER_MAX));
    const long = wakeTriggerText(msg('字'.repeat(BOT_TRIGGER_MAX + 1)), undefined);
    expect(long).toBe(`${'字'.repeat(BOT_TRIGGER_MAX)}…（已截断，需要时用 vonvon 飞书 skill 查全文）`);
  });

  it('does not cut an emoji in two at the limit (E1)', () => {
    const out = wakeTriggerText(msg(`${'a'.repeat(BOT_TRIGGER_MAX - 1)}😀${'b'.repeat(50)}`), undefined);
    expect(out).toBe(`${'a'.repeat(BOT_TRIGGER_MAX - 1)}…（已截断，需要时用 vonvon 飞书 skill 查全文）`);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    // Ending right after the emoji keeps it whole.
    const whole = wakeTriggerText(msg(`${'a'.repeat(BOT_TRIGGER_MAX - 2)}😀${'b'.repeat(50)}`), undefined);
    expect(whole.startsWith(`${'a'.repeat(BOT_TRIGGER_MAX - 2)}😀…`)).toBe(true);
  });

  it('goes through the quote sanitizer: control characters and runs of blank lines go, lines stay', () => {
    expect(wakeTriggerText(msg('第一行\u0007\n\n\n\n第二行\r\n第三行'), undefined)).toBe('第一行\n\n第二行\n第三行');
  });
});

describe('BOT_WAKE_NOTE', () => {
  it('names the bot without parentheses on one line, with no count', () => {
    const note = BOT_WAKE_NOTE('小P（审查）\n第二行');
    expect(note).toContain('另一个 bot「小P审查 第二行」发的');
    expect(note).toContain('写 @小P审查 第二行；');
    expect(note).not.toMatch(/已互相叫醒|上限|已到上限/);
    expect(note.endsWith('不要把事交回给刚交给你的 bot。）')).toBe(true);
    expect(BOT_WAKE_NOTE('「」')).toContain('另一个 bot「另一个 bot」发的');
  });
});

describe('wakeTables', () => {
  it('looks a bot up by app_id too, leaving out one with no app_id', () => {
    const t = wakeTables(new Map([['ou_a', { appId: 'cli_a', name: 'A' }], ['ou_none', { appId: '', name: '?' }]]));
    expect([...t.byAppId]).toEqual([['cli_a', { openId: 'ou_a', name: 'A' }]]);
    expect(t.byOpenId.size).toBe(2);
  });
});
