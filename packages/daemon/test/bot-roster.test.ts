import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBotRoster, ROSTER_RETRY_MS, ROSTER_TTL_MS } from '../src/bot/bot-roster';
import { setDiagnosticsSink } from '../src/bot/diagnostics';

// s27a0, all new on main; `refresh` and my app_id are s27a-0.
const APP = 'cli_me';
const body = (bots: object[]) => ({ code: 0, data: { bots, has_more: false } });
const B8 = { app_id: 'cli_8', member_id: 'ou_b8', name: 'Bot 8', tenant_key: 't' };

function roster(request: ReturnType<typeof vi.fn>, stop = <T>(p: Promise<T>, _f: T) => p) {
  return createBotRoster({ rawClient: { request, appId: APP }, botIdentity: { openId: 'ou_me', name: '我' } } as never, { stop });
}

afterEach(() => { vi.useRealTimers(); setDiagnosticsSink(undefined); });

describe('bot roster', () => {
  it('reads the bots bucket with the chat id in the path, keyed by this app\'s open_id, me included', async () => {
    const request = vi.fn(async () => body([B8, { member_id: 7 }]));
    const r = roster(request);
    expect(r.peek('oc_1/x')).toBeUndefined();
    await r.load('oc_1/x');
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/open-apis/im/v1/chats/oc_1%2Fx/members/list',
      params: { member_types: 'bot', member_id_type: 'open_id', page_size: 100 } });
    expect([...r.peek('oc_1/x')!]).toEqual([['ou_b8', { appId: 'cli_8', name: 'Bot 8' }], ['ou_me', { appId: APP, name: '我' }]]);
  });

  it('takes a success without the bots bucket for a failed read; an empty bucket is a read', async () => {
    const r = roster(vi.fn(async () => ({ code: 0, data: { items: [{ member_id: 'ou_b8' }] } })));
    await r.load('oc_1');
    expect(r.peek('oc_1')).toBeUndefined();
    const empty = roster(vi.fn(async () => body([])));
    await empty.load('oc_1');
    expect([...empty.peek('oc_1')!.keys()]).toEqual(['ou_me']);
  });

  it('trusts a list ten minutes, shares one read, and keeps the old list when a re-read fails', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(body([B8])).mockRejectedValue(new Error('offline'));
    const r = roster(request);
    await Promise.all([r.load('oc_1'), r.load('oc_1')]);
    await vi.advanceTimersByTimeAsync(ROSTER_TTL_MS - 1);
    await r.load('oc_1');
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await r.load('oc_1');
    expect(request).toHaveBeenCalledTimes(2);
    expect(r.peek('oc_1')?.has('ou_b8')).toBe(true); // stale, not dropped
    await vi.advanceTimersByTimeAsync(ROSTER_RETRY_MS - 1);
    await r.load('oc_1');
    expect(request).toHaveBeenCalledTimes(2); // a failure is not retried on every frame
  });

  it('gives up after three seconds, and shutdown does not wait at all', async () => {
    vi.useFakeTimers();
    const r = roster(vi.fn(() => new Promise(() => {})));
    const read = r.load('oc_1');
    await vi.advanceTimersByTimeAsync(3_000);
    await read;
    expect(r.peek('oc_1')).toBeUndefined();
    let stop!: () => void;
    const stopping = new Promise<void>((resolve) => { stop = resolve; });
    const cut = roster(vi.fn(() => new Promise(() => {})), (p, fallback) => Promise.race([p, stopping.then(() => fallback)]));
    const pending = cut.load('oc_1');
    stop();
    await pending; // settles with the request still hanging
    expect(cut.peek('oc_1')).toBeUndefined();
  });

  it('refresh reads past the cache every time, returns what it read, and refreshes the cache', async () => {
    const B7 = { app_id: 'cli_7', member_id: 'ou_b7', name: 'Bot 7' };
    const request = vi.fn().mockResolvedValueOnce(body([B8])).mockResolvedValueOnce(body([B8, B7])).mockResolvedValueOnce(body([B7]));
    const r = roster(request);
    await r.load('oc_1');
    const fresh = await r.refresh('oc_1');
    expect(request).toHaveBeenCalledTimes(2);
    expect([...fresh!.keys()]).toEqual(['ou_b8', 'ou_b7', 'ou_me']);
    expect(r.peek('oc_1')).toBe(fresh);
    expect([...(await r.refresh('oc_1'))!.keys()]).toEqual(['ou_b7', 'ou_me']);
    expect(request).toHaveBeenCalledTimes(3);
    await r.load('oc_1'); // fresh again: no read
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('refresh shares a read in flight, and gives undefined, not the old list, when that read fails', async () => {
    let fail!: (e: Error) => void;
    const request = vi.fn().mockResolvedValueOnce(body([B8])).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    vi.useFakeTimers();
    const r = roster(request);
    await r.load('oc_1');
    await vi.advanceTimersByTimeAsync(ROSTER_TTL_MS);
    const loading = r.load('oc_1');
    const fresh = r.refresh('oc_1');
    expect(request).toHaveBeenCalledTimes(2);
    fail(new Error('offline'));
    expect(await fresh).toBeUndefined();
    await loading;
    expect(r.peek('oc_1')?.has('ou_b8')).toBe(true); // the guard keeps the old list
    // A read that never answers or is cut by shutdown is a failure too.
    const cut = roster(vi.fn(() => new Promise(() => {})), (_p, fallback) => Promise.resolve(fallback));
    expect(await cut.refresh('oc_1')).toBeUndefined();
  });

  it('reports a missing scope, from a thrown error or a returned code', async () => {
    const events: unknown[] = [];
    setDiagnosticsSink((e) => events.push(e));
    const denied = { code: 99991672, msg: 'scopes: [im:chat:readonly]' };
    const r = roster(vi.fn().mockRejectedValueOnce({ response: { data: denied } }).mockResolvedValueOnce({ code: 230002 }));
    await r.load('oc_1');
    await r.load('oc_2');
    expect(events).toEqual([{ kind: 'scopeDenied', denial: { scope: 'im:chat:readonly', where: 'chat-info', at: expect.any(Number) } }]);
    expect(r.peek('oc_2')).toBeUndefined();
  });
});
