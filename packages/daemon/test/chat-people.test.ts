import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatPeople, PEOPLE_MAX_PAGES, PEOPLE_PAGE_SIZE, PEOPLE_READ_MS, PEOPLE_RETRY_MS, PEOPLE_TTL_MS } from '../src/bot/chat-people';
import { setDiagnosticsSink } from '../src/bot/diagnostics';
import { log } from '../src/core/logger';

const person = (id: string) => ({ member_id: `ou_${id}`, name: id });
const page = (items: object[], more = false, token?: string) => ({ code: 0, data: { items, has_more: more, page_token: token } });
function people(get: ReturnType<typeof vi.fn>, stop = <T>(p: Promise<T>, _fallback: T) => p) {
  return createChatPeople({ rawClient: { im: { v1: { chatMembers: { get } } } } } as never, { stop });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setDiagnosticsSink(undefined); });

describe('chat people', () => {
  it('reads the requested chat, keeps only named members, and caches an empty completed list', async () => {
    const get = vi.fn().mockResolvedValueOnce(page([person('张'), { member_id: 'ou_空' }, { name: '缺' }, { member_id: 7, name: '坏' }]))
      .mockResolvedValue(page([]));
    const r = people(get);
    expect(r.peek('oc_群')).toBeUndefined();
    await r.load('oc_群');
    expect(get).toHaveBeenCalledWith({ path: { chat_id: 'oc_群' }, params: { member_id_type: 'open_id', page_size: PEOPLE_PAGE_SIZE } });
    expect(r.peek('oc_群')).toEqual({ people: [{ openId: 'ou_张', name: '张' }], complete: true });
    await r.load('oc_空');
    expect(r.peek('oc_空')).toEqual({ people: [], complete: true });
  });

  it('shares pending reads, trusts complete lists ten minutes, and retries failures after one minute', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValueOnce(page([person('张')])).mockRejectedValue(new Error('offline'));
    const r = people(get);
    await Promise.all([r.load('oc_群'), r.load('oc_群')]);
    await vi.advanceTimersByTimeAsync(PEOPLE_TTL_MS - 1);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await r.load('oc_群');
    expect(r.peek('oc_群')).toEqual({ people: [{ openId: 'ou_张', name: '张' }], complete: false });
    await vi.advanceTimersByTimeAsync(PEOPLE_RETRY_MS - 1);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([() => Promise.reject(new Error('offline')), async () => ({ code: 23 }), async () => ({ code: 0, data: {} }), async () => ({ data: { items: [] } })])(
    'does not cache a list when the first page fails', async (response) => {
      const r = people(vi.fn(response));
      await expect(r.load('oc_群')).resolves.toBeUndefined();
      expect(r.peek('oc_群')).toBeUndefined();
    },
  );

  it('spends at most five seconds total and retains completed pages on timeout', async () => {
    vi.useFakeTimers();
    const first = people(vi.fn(() => new Promise(() => {})));
    const initial = first.load('oc_初');
    await vi.advanceTimersByTimeAsync(PEOPLE_READ_MS);
    await initial;
    expect(first.peek('oc_初')).toBeUndefined();
    const get = vi.fn().mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(page([person('张')], true, 't1')), 3_000)))
      .mockImplementation(() => new Promise(() => {}));
    const r = people(get);
    const pending = r.load('oc_群');
    await vi.advanceTimersByTimeAsync(PEOPLE_READ_MS);
    await pending;
    expect(get).toHaveBeenCalledTimes(2);
    expect(r.peek('oc_群')).toEqual({ people: [{ openId: 'ou_张', name: '张' }], complete: false });
  });

  it('releases shutdown without a failed cache entry and ignores late replies', async () => {
    let stop!: () => void;
    const stopping = new Promise<void>((resolve) => { stop = resolve; });
    let reply!: (value: ReturnType<typeof page>) => void;
    const get = vi.fn(() => new Promise<ReturnType<typeof page>>((resolve) => { reply = resolve; }));
    const r = people(get, (p, fallback) => Promise.race([p, stopping.then(() => fallback)]));
    const pending = r.load('oc_群');
    stop();
    await pending;
    reply(page([person('张')]));
    await Promise.resolve();
    expect(r.peek('oc_群')).toBeUndefined();
  });

  it('reads short pages until has_more ends, with tokens and page order preserved', async () => {
    const info = vi.spyOn(log, 'info');
    const get = vi.fn().mockResolvedValueOnce(page([person('张')], true, 't1'))
      .mockResolvedValueOnce(page([person('李')], true, 't2')).mockResolvedValueOnce(page([person('王')]));
    const r = people(get);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledWith('card', 'chat-people', { chatId: 'oc_群', people: 3, pages: 3 });
    expect(get.mock.calls.map(([request]) => request.params.page_token)).toEqual([undefined, 't1', 't2']);
    expect(r.peek('oc_群')).toEqual({ people: ['张', '李', '王'].map((name) => ({ openId: `ou_${name}`, name })), complete: true });
  });

  it('stops at ten pages and retries incomplete lists after a minute', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, 'info');
    let count = 0;
    const get = vi.fn(async () => { count++; return page([person(String(count))], true, `t${count}`); });
    const r = people(get);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(PEOPLE_MAX_PAGES);
    expect(r.peek('oc_群')?.complete).toBe(false);
    expect(r.peek('oc_群')?.people).toHaveLength(PEOPLE_MAX_PAGES);
    expect(info).toHaveBeenCalledWith('card', 'chat-people', { chatId: 'oc_群', people: PEOPLE_MAX_PAGES, pages: PEOPLE_MAX_PAGES, more: true });
    await vi.advanceTimersByTimeAsync(PEOPLE_RETRY_MS - 1);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(PEOPLE_MAX_PAGES);
  });

  it.each([undefined, 't1'])('stops when pagination has no progress (%s)', async (next) => {
    const get = vi.fn().mockResolvedValueOnce(page([person('张')], true, 't1')).mockResolvedValue(page([person('李')], true, next));
    const r = people(get);
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(2);
    expect(r.peek('oc_群')?.complete).toBe(false);
  });

  it.each([false, true])('keeps old names instead of partial replacements and recovers (old: %s)', async (old) => {
    vi.useFakeTimers();
    const get = vi.fn();
    if (old) get.mockResolvedValueOnce(page([person('旧')]));
    get.mockResolvedValueOnce(page([person('残')], true, 't1')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([person('新')], true, 't1')).mockResolvedValueOnce(page([person('新二')]));
    const r = people(get);
    if (old) { await r.load('oc_群'); await vi.advanceTimersByTimeAsync(PEOPLE_TTL_MS); }
    await r.load('oc_群');
    expect(r.peek('oc_群')).toEqual({ people: [{ openId: old ? 'ou_旧' : 'ou_残', name: old ? '旧' : '残' }], complete: false });
    await r.load('oc_群');
    expect(get).toHaveBeenCalledTimes(old ? 3 : 2);
    await vi.advanceTimersByTimeAsync(PEOPLE_RETRY_MS);
    await r.load('oc_群');
    expect(r.peek('oc_群')).toEqual({ people: [{ openId: 'ou_新', name: '新' }, { openId: 'ou_新二', name: '新二' }], complete: true });
  });

  it.each(['throw', 'code', 'timeout'])('invalidates old uniqueness after %s and keeps failure logs limited', async (kind) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log, 'warn');
    const get = vi.fn().mockResolvedValueOnce(page([person('旧')]));
    if (kind === 'throw') get.mockRejectedValueOnce({ response: { data: { code: 23 } } });
    else if (kind === 'code') get.mockResolvedValueOnce({ code: 99991672 });
    else get.mockImplementationOnce(() => new Promise(() => {}));
    get.mockResolvedValue(page([person('新')]));
    const r = people(get);
    await r.load('oc_保密群尾号');
    await vi.advanceTimersByTimeAsync(PEOPLE_TTL_MS);
    const pending = r.load('oc_保密群尾号');
    await vi.advanceTimersByTimeAsync(PEOPLE_READ_MS);
    await pending;
    expect(r.peek('oc_保密群尾号')).toEqual({ people: [{ openId: 'ou_旧', name: '旧' }], complete: false });
    expect(warn).toHaveBeenCalledWith('card', 'chat-people-failed', { chatId: 'oc_保密群尾号'.slice(-6), reason: kind === 'timeout' ? 'timeout' : kind === 'throw' ? 'code=23' : 'missing-scope' });
    await r.load('oc_保密群尾号');
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PEOPLE_RETRY_MS);
    await r.load('oc_保密群尾号');
    expect(r.peek('oc_保密群尾号')?.complete).toBe(true);
  });

  it('reports missing scopes for returned and thrown denials', async () => {
    const events: unknown[] = [];
    setDiagnosticsSink((event) => events.push(event));
    const denied = { code: 99991672, msg: 'scopes: [im:chat:readonly]' };
    const r = people(vi.fn().mockRejectedValueOnce({ response: { data: denied } }).mockResolvedValueOnce(denied));
    await r.load('oc_一');
    await r.load('oc_二');
    expect(events).toHaveLength(2);
    expect(events).toEqual(Array.from({ length: 2 }, () => ({ kind: 'scopeDenied', denial: { scope: 'im:chat:readonly', where: 'chat-info', at: expect.any(Number) } })));
  });
});


it('rejects a pagination token cycle instead of consuming the remaining pages', async () => {
  const get = vi.fn().mockResolvedValueOnce(page([person('甲')], true, 'a'))
    .mockResolvedValueOnce(page([person('乙')], true, 'b')).mockResolvedValueOnce(page([person('丙')], true, 'a'));
  const r = people(get);
  await r.load('oc_群');
  expect(get).toHaveBeenCalledTimes(3);
  expect(r.peek('oc_群')?.complete).toBe(false);
});
