import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { createNameBook } from '../src/bot/names';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

const SCOPE_DENIED = Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [contact:user.base:readonly]' } },
});

/** A channel whose three lookups are spies; each answers from its own table. */
function channel(opts: {
  message?: Record<string, string | undefined>;
  contact?: Record<string, string> | Error;
  members?: Record<string, string> | Error;
  slow?: Promise<void>;
} = {}) {
  const get = vi.fn(async ({ path }: { path: { message_id: string } }) => {
    await opts.slow;
    const sender = opts.message?.[path.message_id];
    return { code: 0, data: { items: [{ message_id: path.message_id, sender: { id: 'ou_a', sender_type: 'user', ...(sender ? { sender_name: sender } : {}) } }] } };
  });
  const batch = vi.fn(async ({ params }: { params: { user_ids: string[] } }) => {
    if (opts.contact instanceof Error) throw opts.contact;
    const table = opts.contact ?? {};
    return { code: 0, data: { items: params.user_ids.filter((id) => table[id]).map((id) => ({ open_id: id, name: table[id] })) } };
  });
  const members = vi.fn(async () => {
    if (opts.members instanceof Error) throw opts.members;
    return { code: 0, data: { items: Object.entries(opts.members ?? {}).map(([member_id, name]) => ({ member_id, name })) } };
  });
  const ch = { rawClient: { im: { v1: { message: { get }, chatMembers: { get: members } } }, contact: { v3: { user: { batch } } } } };
  return { ch: ch as unknown as LarkChannel, get, batch, members };
}

const msg = (messageId: string, senderId = 'ou_a') => ({ messageId, senderId, chatId: 'oc_chat' });

describe('NameBook', () => {
  it('takes the name from the trigger message with_sender_name, then serves it from the cache', async () => {
    const c = channel({ message: { om_1: '张三' } });
    const book = createNameBook(c.ch);
    expect(await book.senderName(msg('om_1'))).toBe('张三');
    expect(c.get).toHaveBeenCalledWith({ path: { message_id: 'om_1' }, params: { with_sender_name: true } });
    expect(await book.senderName(msg('om_2'))).toBe('张三');
    expect(c.get).toHaveBeenCalledTimes(1);
    expect(c.batch).not.toHaveBeenCalled();
  });

  it('falls back to contact, then to the chat member list', async () => {
    const c = channel({ contact: { ou_a: '通讯录张三' } });
    expect(await createNameBook(c.ch).senderName(msg('om_1'))).toBe('通讯录张三');
    expect(c.members).not.toHaveBeenCalled();

    const m = channel({ members: { ou_a: '群里的张三', ou_b: '李四' } });
    const book = createNameBook(m.ch);
    expect(await book.senderName(msg('om_1'))).toBe('群里的张三');
    // The member list filled everyone at once.
    expect(book.peek('ou_b')).toBe('李四');
  });

  it('remembers a missing contact scope and stops calling contact', async () => {
    const c = channel({ contact: SCOPE_DENIED, members: { ou_a: '张三', ou_b: '李四' } });
    const book = createNameBook(c.ch);
    expect(await book.senderName(msg('om_1'))).toBe('张三');
    expect(await book.senderName(msg('om_2', 'ou_c'))).toBeUndefined();
    expect(c.batch).toHaveBeenCalledTimes(1);
    expect(c.members).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when every step fails, and does not retry until the miss expires', async () => {
    let clock = 0;
    const c = channel({ contact: new Error('socket hang up'), members: new Error('socket hang up') });
    c.get.mockRejectedValue(new Error('timeout'));
    const book = createNameBook(c.ch, { now: () => clock });
    expect(await book.senderName(msg('om_1'))).toBeUndefined();
    expect(await book.senderName(msg('om_2'))).toBeUndefined();
    expect(c.get).toHaveBeenCalledTimes(1);
    clock += 11 * 60_000;
    await book.senderName(msg('om_3'));
    expect(c.get).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent turns from the same sender', async () => {
    const c = channel({ message: { om_1: '张三', om_2: '张三' } });
    const book = createNameBook(c.ch);
    expect(await Promise.all([book.senderName(msg('om_1')), book.senderName(msg('om_2'))])).toEqual(['张三', '张三']);
    expect(c.get).toHaveBeenCalledTimes(1);
  });

  it('gives up at the deadline without failing, and keeps the late answer', async () => {
    let release!: () => void;
    const c = channel({ message: { om_1: '张三' }, slow: new Promise<void>((r) => { release = r; }) });
    const book = createNameBook(c.ch, { deadlineMs: 10 });
    expect(await book.senderName(msg('om_1'))).toBeUndefined();
    release();
    await vi.waitFor(() => expect(book.peek('ou_a')).toBe('张三'));
  });

  it('learns names from @mentions, and keeps each bot apart (open_id is per app)', async () => {
    const a = createNameBook(channel().ch);
    const b = createNameBook(channel({ members: new Error('no') }).ch);
    a.learnMentions([{ key: '@_user_1', openId: 'ou_a', name: '张三' }, { key: '@_user_2', name: '没有 id' }]);
    expect(await a.senderName(msg('om_1'))).toBe('张三');
    expect(b.peek('ou_a')).toBeUndefined();
  });

  it('a failed lookup does not overwrite a name learned meanwhile', async () => {
    let release!: () => void;
    const c = channel({ slow: new Promise<void>((r) => { release = r; }), contact: new Error('x'), members: new Error('x') });
    const book = createNameBook(c.ch);
    const pending = book.senderName(msg('om_1'));
    book.remember('ou_a', '从历史学到的');
    release();
    expect(await pending).toBe('从历史学到的');
  });
});
