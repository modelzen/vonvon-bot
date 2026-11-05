import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostIpcCaller, createHostIpcResponder, HOST_IPC_REQ, HOST_IPC_TIMEOUT_MS, type HostApi } from '../src/admin/ipc';
import { createSessionTokens, SESSION_TOKEN_RE } from '../src/host/session-tokens';

/** devices-4a 4.2: bot → host over the child's IPC, wired back to back as the supervisor and a bot child do. */
describe('host IPC', () => {
  afterEach(() => { vi.useRealTimers(); });
  const wired = (appId = 'cli_x') => {
    const tokens = createSessionTokens();
    const feishuRead = vi.fn<HostApi['feishuRead']>(async () => ({ ok: true, result: { text: '正文' } }));
    const api: HostApi = {
      issueSessionToken: async input => { if (input.appId !== appId) throw new Error('not this process\'s bot'); return tokens.issue(input); },
      revokeSessionToken: async sessionId => { tokens.revoke(sessionId); },
      feishuRead,
    };
    let caller: ReturnType<typeof createHostIpcCaller>;
    const responder = createHostIpcResponder(api, msg => queueMicrotask(() => caller.onMessage(msg)));
    caller = createHostIpcCaller(msg => queueMicrotask(() => responder.onMessage(msg)));
    return { caller, tokens, responder, feishuRead };
  };

  it('issues a token for the bot\'s own session and revokes it', async () => {
    const { caller, tokens } = wired();
    const token = await caller.issueSessionToken({ appId: 'cli_x', place: 'group', chatId: 'oc_y', sessionId: 'ses_0123456789abcdef' });
    expect(token).toMatch(SESSION_TOKEN_RE);
    expect(tokens.resolve(token)).toMatchObject({ appId: 'cli_x', place: 'group', chatId: 'oc_y' });
    await caller.revokeSessionToken('ses_0123456789abcdef');
    expect(tokens.resolve(token)).toBeUndefined();
  });

  it('refuses another bot\'s session and a malformed request', async () => {
    const { caller, tokens, responder } = wired();
    await expect(caller.issueSessionToken({ appId: 'cli_other', place: 'dm', chatId: 'oc_dm', sessionId: 'ses_0123456789abcdef' })).rejects.toThrow('not this process\'s bot');
    await expect(caller.issueSessionToken({ appId: 'cli_x', place: 'dm', sessionId: 'ses_short' })).rejects.toThrow();
    expect(tokens.size()).toBe(0);
    // what is not a host request is not answered at all
    const send = vi.fn();
    const other = createHostIpcResponder({ issueSessionToken: vi.fn(), revokeSessionToken: vi.fn(), feishuRead: vi.fn() }, send);
    other.onMessage({ fcb: 'fcb.admin.req', id: 1, op: { kind: 'issueSessionToken' } });
    other.onMessage({ fcb: HOST_IPC_REQ, id: 'x', op: {} });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(responder).toBeDefined();
  });

  it('carries a private chat\'s read and its answer; what the host does not know is refused (dm-agent 7.3)', async () => {
    const { caller, feishuRead } = wired();
    const session = 'ses_0123456789abcdef';
    expect(await caller.feishuRead('Bot B', { sessionId: session, tool: 'feishu_doc', args: { doc: 'dox' } })).toEqual({ ok: true, result: { text: '正文' } });
    expect(feishuRead).toHaveBeenCalledWith('Bot B', { sessionId: session, tool: 'feishu_doc', args: { doc: 'dox' } });
    feishuRead.mockResolvedValueOnce({ ok: false, kind: 'not-shared', message: '这篇文档还没分享给 Bot。' });
    expect(await caller.feishuRead(undefined, { sessionId: session, tool: 'feishu_doc', args: {} })).toEqual({ ok: false, kind: 'not-shared', message: '这篇文档还没分享给 Bot。' });
    expect(feishuRead).toHaveBeenLastCalledWith(undefined, { sessionId: session, tool: 'feishu_doc', args: {} });
    feishuRead.mockClear();
    await expect(caller.feishuRead(undefined, { sessionId: 'not-a-session', tool: 'feishu_doc', args: {} })).rejects.toThrow();
    // `only` is the host's to set, not something a process asks for
    await expect(caller.feishuRead(undefined, { sessionId: session, tool: 'feishu_doc', args: {}, only: 'oc_x' } as never)).rejects.toThrow();
    expect(feishuRead).not.toHaveBeenCalled();
  });

  it('gives up on a host that does not answer', async () => {
    vi.useFakeTimers();
    const caller = createHostIpcCaller(() => undefined);
    const pending = caller.issueSessionToken({ appId: 'cli_x', place: 'comment', sessionId: 'ses_0123456789abcdef' });
    const settled = expect(pending).rejects.toThrow(`vonvon 主进程 ${HOST_IPC_TIMEOUT_MS}ms 未响应`);
    await vi.advanceTimersByTimeAsync(HOST_IPC_TIMEOUT_MS);
    await settled;
  });
});
