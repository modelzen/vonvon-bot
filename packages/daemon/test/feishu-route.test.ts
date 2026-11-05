import { rmSync } from 'node:fs';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hostFeishuApi, hostFeishuRead, routeFeishuApi, routeFeishuRead, type FeishuRouteDeps, type RoutedApi, type RouteBot } from '../src/admin/feishu-route';
import { createAdminIpcResponder, ADMIN_IPC_REQ, ADMIN_IPC_RES, type AdminIpcOp } from '../src/admin/ipc';
import { AdminWriteError } from '../src/admin/ops';
import { createCommandTools } from '../src/agent/entry/command-tools';
import { createFeishuCalls, createFeishuReads, FEISHU_API, feishuToolNames, feishuToolSpecs } from '../src/agent/entry/feishu-tools';
import { createAgentEntries, type AgentPlace } from '../src/agent/entry/registry';
import { toolReplyText } from '../src/agent/entry/tools';
import type { AgentThread } from '../src/agent/types';
import { runFeishuRead } from '../src/cli/commands/feishu';
import { createFeishuReader, type FeishuReadReply } from '../src/feishu-read/reader';
import { createSessionTokens } from '../src/host/session-tokens';
import { commandRpc } from '../src/server/rpc/command';
import { CommandError } from '../src/cli/command-error';
import { setCliContext, type Daemon } from '../src/cli/daemon-client';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'feishu-route-'));
  return { paths: { appDir, mediaDir: join(appDir, 'media'), inboundDir: join(appDir, 'inbound') } };
});
const { paths } = await import('../src/config/paths');
afterAll(() => { rmSync(paths.appDir, { recursive: true, force: true }); });

const A: RouteBot = { id: 'cli_a', label: 'Bot A', name: 'a' };
const B: RouteBot = { id: 'cli_b', label: 'Bot B', name: 'b' };
const C: RouteBot = { id: 'cli_c', label: 'Bot C', name: 'c' };
const GROUP = 'oc_group', DM = 'oc_dm';
const SESSION = 'ses_0123456789abcdef';

/** A host with these Bots: who is bound to what, who runs, and what a read answers. */
function host(options: { bots?: readonly RouteBot[]; chats?: Record<string, readonly string[]>; stopped?: readonly string[]; answer?: (botId: string) => unknown } = {}) {
  const stopped = new Set(options.stopped ?? []);
  const execute = vi.fn<FeishuRouteDeps['execute']>(async botId => stopped.has(botId) ? undefined : options.answer ? options.answer(botId) : { ok: true, result: { from: botId } });
  const deps: FeishuRouteDeps = { bots: async () => options.bots ?? [A, B, C], chats: async botId => options.chats?.[botId] ?? [], running: async botId => !stopped.has(botId), execute };
  return { deps, execute };
}
const read = (args: Record<string, unknown> = { chat: GROUP }) => ({ tool: 'feishu_messages', args });
const notShared: FeishuReadReply = { ok: false, kind: 'not-shared', message: '这篇文档还没分享给 Bot。' };

describe('which Bot reads (dm-agent 7.3)', () => {
  it('a chat goes to the current Bot when it is bound there, first of all', async () => {
    const h = host({ chats: { cli_a: [GROUP], cli_b: [GROUP] } });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, read())).toEqual({ ok: true, result: { from: 'cli_a' } });
    // and whichever the list starts with
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_b' }, read())).toEqual({ ok: true, result: { from: 'cli_b' } });
  });
  it('else to the first Bot bound to it', async () => {
    const h = host({ chats: { cli_b: [GROUP], cli_c: [GROUP] } });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, read())).toEqual({ ok: true, result: { from: 'cli_b' } });
  });
  it('a stopped Bot does not stand in the way of a running one', async () => {
    const h = host({ chats: { cli_b: [GROUP], cli_c: [GROUP] }, stopped: ['cli_b'] });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, read())).toEqual({ ok: true, result: { from: 'cli_c' } });
  });
  it('says the Bot is not running when the only one bound is stopped', async () => {
    const h = host({ chats: { cli_b: [GROUP] }, stopped: ['cli_b'] });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, read())).toEqual({ ok: false, kind: 'other', message: 'Bot Bot B 没在运行。' });
  });
  it('a chat nobody is bound to is tried by the current Bot, which may still be in it', async () => {
    const h = host();
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, read())).toEqual({ ok: true, result: { from: 'cli_a' } });
  });
  it('without a chat or a Bot it is the current Bot', async () => {
    const h = host({ chats: { cli_b: [GROUP] } });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, { tool: 'feishu_doc', args: { doc: 'dox' } })).toEqual({ ok: true, result: { from: 'cli_a' } });
  });
  it('`bot` wins, by id, its name or its registered name, and goes as it is', async () => {
    const h = host({ chats: { cli_a: [GROUP] } });
    for (const bot of ['cli_b', 'Bot B', 'b']) expect(await routeFeishuRead(h.deps, { prefer: 'cli_a', bot }, read())).toEqual({ ok: true, result: { from: 'cli_b' } });
  });
  it('an unknown name lists the Bots, and two Bots of a name ask for the id', async () => {
    const h = host({ bots: [A, B, { ...C, label: 'Bot B' }] });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a', bot: 'Bot Z' }, read())).toMatchObject({ ok: false, message: expect.stringContaining('Bot A（cli_a）') });
    expect(await routeFeishuRead(h.deps, { prefer: 'cli_a', bot: 'Bot B' }, read())).toMatchObject({ ok: false, message: expect.stringContaining('cli_b、cli_c') });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('a terminal has no current Bot: a chat goes to who is bound to it, nothing else is guessed', async () => {
    const h = host({ chats: { cli_c: [GROUP] } });
    expect(await routeFeishuRead(h.deps, {}, read())).toEqual({ ok: true, result: { from: 'cli_c' } });
    expect(await routeFeishuRead(h.deps, {}, read({ chat: 'oc_other' }))).toMatchObject({ ok: false, message: expect.stringContaining('没有 Bot 绑定') });
    expect(await routeFeishuRead(h.deps, {}, { tool: 'feishu_doc', args: {} })).toMatchObject({ ok: false, message: expect.stringContaining('--bot') });
  });
  it('keeps a read to the chat it was given', async () => {
    const h = host();
    await routeFeishuRead(h.deps, { bot: 'cli_a', only: GROUP }, read({}));
    expect(h.execute).toHaveBeenCalledWith('cli_a', { tool: 'feishu_messages', args: {}, only: GROUP });
  });
  it('a Bot gone in the middle, or an answer of the wrong shape, is a refusal and not a throw', async () => {
    const gone = host({ answer: () => { throw new Error('Bot 进程已退出'); } });
    expect(await routeFeishuRead(gone.deps, { prefer: 'cli_a' }, read())).toMatchObject({ ok: false, kind: 'no-answer', message: expect.stringContaining('Bot 进程已退出') });
    const odd = host({ answer: () => ({ ok: 'maybe' }) });
    expect(await routeFeishuRead(odd.deps, { prefer: 'cli_a' }, read())).toMatchObject({ ok: false, kind: 'no-answer' });
  });
});

describe('what the session\'s Bot could not read (dm-agent 7.3)', () => {
  const doc = { tool: 'feishu_doc', args: { doc: 'dox' } };
  it('lists the other Bots, and which of them are stopped', async () => {
    const h = host({ answer: () => notShared, stopped: [] });
    const reply = await routeFeishuRead(h.deps, { prefer: 'cli_a' }, doc);
    expect(reply).toMatchObject({ ok: false, kind: 'not-shared' });
    const { message } = reply as { message: string };
    expect(message).toContain('这篇文档还没分享给 Bot。');
    expect(message).toContain('Bot B（cli_b）、Bot C（cli_c）');
    expect(message).not.toContain('Bot A（cli_a）');
    expect(message).toContain('bot 参数');
    const stopped = host({ answer: botId => botId === 'cli_a' ? notShared : undefined, stopped: ['cli_c'] });
    expect(await routeFeishuRead(stopped.deps, { prefer: 'cli_a' }, doc)).toMatchObject({ message: expect.stringContaining('Bot C（cli_c），没在运行') });
  });
  it('for a missing scope and a group it is not in too', async () => {
    for (const kind of ['scope', 'not-in-chat'] as const) {
      const h = host({ answer: () => ({ ok: false, kind, message: '不行。' }) });
      expect(await routeFeishuRead(h.deps, { prefer: 'cli_a' }, doc)).toMatchObject({ message: expect.stringContaining('还有别的 Bot') });
    }
  });
  it('not when a Bot was named, nor for what another Bot could not change, nor with no other Bot', async () => {
    const named = host({ answer: () => notShared });
    expect(await routeFeishuRead(named.deps, { prefer: 'cli_a', bot: 'cli_b' }, doc)).toEqual(notShared);
    const missing = host({ answer: () => ({ ok: false, kind: 'not-found', message: '找不到。' }) });
    expect(await routeFeishuRead(missing.deps, { prefer: 'cli_a' }, doc)).toEqual({ ok: false, kind: 'not-found', message: '找不到。' });
    const alone = host({ bots: [A], answer: () => notShared });
    expect(await routeFeishuRead(alone.deps, { prefer: 'cli_a' }, doc)).toEqual(notShared);
  });
  it('not for a group\'s read, kept to its own Bot', async () => {
    const h = host({ answer: () => notShared });
    expect(await routeFeishuRead(h.deps, { bot: 'cli_a', only: GROUP }, doc)).toEqual(notShared);
  });
});

describe('the host\'s check of a session\'s read (dm-agent 7.3)', () => {
  const tokensWith = (place: 'dm' | 'group' | 'comment', appId = 'cli_a') => {
    const tokens = createSessionTokens();
    tokens.issue({ appId, place, ...(place === 'comment' ? {} : { chatId: DM }), sessionId: SESSION });
    return tokens;
  };
  const ask = async (tokens: ReturnType<typeof createSessionTokens>, bot?: string) => {
    const reads = vi.fn(async () => ({ ok: true as const, result: 'read' }));
    return { reply: await hostFeishuRead({ appId: 'cli_a', tokens, read: reads }, bot, { sessionId: SESSION, tool: 'feishu_doc', args: {} }), reads };
  };
  it('a private chat\'s session of this process goes on, as the current Bot', async () => {
    const { reply, reads } = await ask(tokensWith('dm'), 'Bot B');
    expect(reply).toEqual({ ok: true, result: 'read' });
    expect(reads).toHaveBeenCalledWith({ prefer: 'cli_a', bot: 'Bot B' }, { tool: 'feishu_doc', args: {} });
  });
  it.each(['group', 'comment'] as const)('a %s session does not, whatever its process sends', async place => {
    const { reply, reads } = await ask(tokensWith(place), 'Bot B');
    expect(reply).toMatchObject({ ok: false });
    expect(reads).not.toHaveBeenCalled();
  });
  it('a call let through keeps the session alive, as its command line would; one refused does not', async () => {
    let at = 0;
    const tokens = createSessionTokens({ now: () => at, idleMs: 100 });
    tokens.issue({ appId: 'cli_other', place: 'dm', chatId: DM, sessionId: SESSION });
    at = 60;
    await hostFeishuRead({ appId: 'cli_a', tokens, read: vi.fn() }, undefined, { sessionId: SESSION, tool: 'feishu_doc', args: {} });
    expect(tokens.session(SESSION)?.lastUsedAt).toBe(0);
    await hostFeishuApi({ appId: 'cli_other', tokens, api: async () => ({ ok: true, result: 'sent' }) }, 'Bot B', { sessionId: SESSION, request: { method: 'GET', path: '/open-apis/calendar/v4/calendars' } });
    at = 120;
    expect(await hostFeishuRead({ appId: 'cli_other', tokens, read: async () => ({ ok: true, result: 'read' }) }, undefined, { sessionId: SESSION, tool: 'feishu_doc', args: {} })).toEqual({ ok: true, result: 'read' });
  });
  it('nor another process\'s session, nor one whose token went', async () => {
    const other = await ask(tokensWith('dm', 'cli_other'));
    expect(other.reads).not.toHaveBeenCalled();
    const revoked = tokensWith('dm');
    revoked.revoke(SESSION);
    const gone = await ask(revoked);
    expect(gone.reply).toMatchObject({ ok: false });
    expect(gone.reads).not.toHaveBeenCalled();
  });
});

const message = (id: string, words: string, chat = GROUP) => ({ message_id: id, chat_id: chat, msg_type: 'text', create_time: '1700000000000',
  sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user', sender_name: '张三' }, body: { content: JSON.stringify({ text: words }) } });
function feishuChannel(items = [message('om_1', '你好')]) {
  const client = { appId: 'cli_b', request: vi.fn(async () => ({ code: 99991672, msg: 'One of the following scopes is required: [docs:document.content:read]' })),
    im: { v1: { message: { list: vi.fn(async () => ({ code: 0, data: { items } })), get: vi.fn(async () => ({ code: 0, data: { items } })) } } }, wiki: { v2: { space: { getNode: vi.fn(async () => ({ code: 131005, msg: 'not found' })) } } } };
  return { client, channel: { rawClient: client, botIdentity: { openId: 'ou_me', name: 'Bot B' } } as unknown as LarkChannel };
}

describe('the tools in each place (dm-agent 7.3)', () => {
  function session(place: AgentPlace, options: { admin?: (openId: string) => boolean; turn?: Partial<Parameters<ReturnType<typeof createAgentEntries>['openTurn']>[1]>; route?: boolean } = {}) {
    const c = feishuChannel();
    const route = vi.fn(async (_bot: string | undefined, _request: { sessionId: string; tool: string; args: Record<string, unknown> }): Promise<FeishuReadReply> => ({ ok: true, result: { from: 'host' } }));
    const list = createCommandTools({ appId: 'cli_a', groups: async () => ({ groups: [] }), members: async () => ({ members: [] }), feishu: createFeishuReader({ channel: c.channel, app: { id: 'cli_a', tenant: 'feishu' } }),
      ...(options.route === false ? {} : { route }) });
    const entries = createAgentEntries({ appId: 'cli_a', isAdmin: options.admin ?? (() => true), tools: list });
    const thread = { sessionId: 's', isAlive: () => true } as unknown as AgentThread;
    const entry = entries.issue(place);
    entry.attach(thread);
    const turn = entries.openTurn(thread, { requesterOpenId: 'ou_admin', requesterKind: 'user', triggerMessageId: 'om_t', retry: false, wake: false, initiative: false, ...options.turn });
    return { ...c, route, entry, entries, thread, turn, call: (name: string, args: unknown) => entry.call(name, args), inputOf: (name: string) => entry.tools().find(tool => tool.name === name)?.input.shape as Record<string, unknown> };
  }
  const P2P: AgentPlace = { kind: 'p2p', chatId: DM };
  const IN_GROUP: AgentPlace = { kind: 'group', chatId: GROUP };

  it('a private chat\'s take `bot`; a group\'s and a comment\'s do not, and refuse it', async () => {
    expect(session(P2P).inputOf('feishu_doc')).toHaveProperty('bot');
    expect(session(P2P).inputOf('feishu_messages')).toHaveProperty('bot');
    for (const place of [IN_GROUP, { kind: 'doc', docId: 'd' } as AgentPlace]) {
      const s = session(place);
      expect(s.inputOf('feishu_doc')).not.toHaveProperty('bot');
      expect(await s.entry.call('feishu_doc', { doc: 'dox', bot: 'Bot B' }, { toolUseId: 'tu' })).toMatchObject({ ok: false });
      expect(s.route).not.toHaveBeenCalled();
    }
    expect(await session(IN_GROUP).call('feishu_messages', { bot: 'Bot B' })).toMatchObject({ ok: false, code: 'bad-args' });
  });
  it('Codex is offered the same: `bot` only with `acrossBots`', () => {
    const schema = (specs: ReturnType<typeof feishuToolSpecs>, name: string) => specs.find(spec => spec.name === name)?.inputSchema as { properties: Record<string, unknown> };
    expect(schema(feishuToolSpecs({ acrossBots: true }), 'feishu_doc').properties).toHaveProperty('bot');
    expect(schema(feishuToolSpecs({}), 'feishu_doc').properties).not.toHaveProperty('bot');
    expect(schema(feishuToolSpecs({ documentsOnly: true }), 'feishu_doc').properties).not.toHaveProperty('bot');
  });
  it('editing a document takes no `bot`: only reads go to another Bot', () => {
    expect(session(P2P).inputOf('feishu_doc_edit')).not.toHaveProperty('bot');
  });
  it('a private chat\'s read goes through the host with its session, on the Bot it named', async () => {
    const s = session(P2P);
    expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toEqual({ ok: true, result: { from: 'host' } });
    expect(s.route).toHaveBeenCalledWith('Bot B', { sessionId: s.entry.sessionId, tool: 'feishu_doc', args: { doc: 'dox' } });
    expect(s.client.request).not.toHaveBeenCalled();
  });
  it('the chat left out is this private chat, of this Bot only: another Bot has to be told which', async () => {
    const s = session(P2P);
    await s.call('feishu_messages', {});
    expect(s.route).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ args: { chat: DM } }));
    await s.call('feishu_messages', { bot: 'Bot B' });
    expect(s.route).toHaveBeenLastCalledWith('Bot B', expect.objectContaining({ args: {} }));
    await s.call('feishu_messages', { chat: GROUP });
    expect(s.route).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ args: { chat: GROUP } }));
  });
  it('a refusal reads as the Bot\'s sentence', async () => {
    const s = session(P2P);
    s.route.mockResolvedValueOnce({ ok: false, kind: 'other', message: 'Bot Bot B 没在运行。' });
    const reply = await s.call('feishu_chat', { chat: GROUP });
    expect(reply).toMatchObject({ ok: false, code: 'refused' });
    expect(toolReplyText(reply)).toBe('Bot Bot B 没在运行。');
  });
  it('a group reads in its own process, kept to its group, and never asks the host', async () => {
    const s = session(IN_GROUP);
    expect(await s.call('feishu_messages', {})).toMatchObject({ ok: true, result: { messages: [{ text: '你好' }] } });
    expect(await s.call('feishu_messages', { chat: 'oc_other' })).toMatchObject({ ok: false, message: expect.stringContaining('读不了别的群') });
    expect(s.route).not.toHaveBeenCalled();
  });
  it('without a host a private chat reads as its own Bot, and another Bot is not running', async () => {
    const s = session(P2P, { route: false });
    expect(await s.call('feishu_messages', { chat: GROUP })).toMatchObject({ ok: true, result: { messages: [{ text: '你好' }] } });
    expect(await s.call('feishu_messages', { chat: GROUP, bot: 'Bot B' })).toMatchObject({ ok: false, message: 'Bot Bot B 没在运行。' });
  });

  describe('nobody gets to another Bot', () => {
    it('someone who is no administrator', async () => {
      const s = session(P2P, { admin: () => false });
      expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused' });
      expect(s.route).not.toHaveBeenCalled();
    });
    it('a turn that ended', async () => {
      const s = session(P2P);
      s.turn.close();
      expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused' });
      expect(s.route).not.toHaveBeenCalled();
    });
    it('an administrator removed since the turn began', async () => {
      let admin = true;
      const s = session(P2P, { admin: () => admin });
      admin = false;
      expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused' });
      expect(s.route).not.toHaveBeenCalled();
    });
    it('a turn nobody typed, a wake or a retry', async () => {
      const s = session(P2P, { turn: { wake: true } });
      expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused' });
      expect(s.route).not.toHaveBeenCalled();
    });
    it('an administrator removed while the read was on its way: the result does not come back', async () => {
      let admin = true;
      const s = session(P2P, { admin: () => admin });
      s.route.mockImplementationOnce(async () => { admin = false; return { ok: true, result: { from: 'host' } }; });
      expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused' });
    });
    it('a private chat\'s task runs as its creator, an administrator', async () => {
      const s = session(P2P, { turn: { scheduled: { taskId: 't', runId: 'r' } } });
      expect(await s.call('feishu_doc', { doc: 'dox', bot: 'Bot B' })).toEqual({ ok: true, result: { from: 'host' } });
    });
  });
});

describe('feishu_api on another Bot (dm-agent 7.3, 7.6)', () => {
  const CALL = { method: 'POST', path: '/open-apis/bitable/v1/apps/app/records', body: { fields: {} } } as const;
  const LIST = { method: 'GET', path: '/open-apis/calendar/v4/calendars' } as const;
  const P2P: AgentPlace = { kind: 'p2p', chatId: DM };
  const answer = (value: unknown) => ({ data: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json' } });
  /** A session of Bot A. `sends` is its own Feishu client; `routeApi` the way to the host. */
  function session(place: AgentPlace, options: { admin?: (openId: string) => boolean; turn?: Partial<Parameters<ReturnType<typeof createAgentEntries>['openTurn']>[1]> } = {}) {
    const sends = vi.fn(async () => answer({ code: 0, from: 'cli_a' }));
    const channel = { rawClient: { request: sends }, botIdentity: { openId: 'ou_me', name: 'Bot A' } } as unknown as LarkChannel;
    const routeApi = vi.fn(async (_bot: string, _request: RoutedApi): Promise<FeishuReadReply> => ({ ok: true, result: '{"code":0,"from":"cli_b"}' }));
    const list = createCommandTools({ appId: 'cli_a', groups: async () => ({ groups: [] }), members: async () => ({ members: [] }), feishu: createFeishuReader({ channel, app: { id: 'cli_a', tenant: 'feishu' } }), routeApi });
    const entries = createAgentEntries({ appId: 'cli_a', isAdmin: options.admin ?? (() => true), tools: list });
    const thread = { sessionId: 's', isAlive: () => true } as unknown as AgentThread;
    const entry = entries.issue(place);
    entry.attach(thread);
    const turn = entries.openTurn(thread, { requesterOpenId: 'ou_admin', requesterKind: 'user', triggerMessageId: 'om_t', retry: false, wake: false, initiative: false, ...options.turn });
    entry.noteToolUse('tu');
    return { sends, routeApi, turn, entry, listed: () => entry.tools().map(tool => tool.name), call: (args: unknown) => entry.call(FEISHU_API, args, { toolUseId: 'tu' }) };
  }

  it('goes through the host with the session, the Bot it named, and the call without `bot`', async () => {
    const s = session(P2P);
    expect(await s.call({ ...CALL, bot: 'Bot B' })).toEqual({ ok: true, result: '{"code":0,"from":"cli_b"}' });
    expect(s.routeApi).toHaveBeenCalledExactlyOnceWith('Bot B', { sessionId: expect.stringMatching(/^ses_/), request: CALL });
    expect(s.sends).not.toHaveBeenCalled();
  });
  it('without `bot`, or naming its own id, it stays in this process, the guard right before the call', async () => {
    const s = session(P2P);
    for (const bot of [undefined, 'cli_a']) expect(await s.call({ ...LIST, ...(bot ? { bot } : {}) })).toMatchObject({ ok: true });
    expect(s.sends).toHaveBeenCalledTimes(2);
    expect(s.routeApi).not.toHaveBeenCalled();
  });
  it('its own name is the host\'s to tell: another Bot may have it too, and nothing goes out as this one meanwhile', async () => {
    const s = session(P2P);
    s.routeApi.mockResolvedValueOnce({ ok: false, kind: 'other', message: '有几个 Bot 都叫 Bot A，请用 App ID 指定：cli_a、cli_b。' });
    expect(await s.call({ ...CALL, bot: 'Bot A' })).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('都叫 Bot A') });
    expect(s.routeApi).toHaveBeenCalledExactlyOnceWith('Bot A', { sessionId: expect.stringMatching(/^ses_/), request: CALL });
    expect(s.sends).not.toHaveBeenCalled();
  });
  it('says the other Bot\'s words back, and that a host with no way there has no such Bot running', async () => {
    const s = session(P2P);
    s.routeApi.mockResolvedValueOnce({ ok: false, kind: 'other', message: 'Bot Bot B 没在运行。' });
    expect(await s.call({ ...CALL, bot: 'Bot B' })).toEqual({ ok: false, code: 'refused', message: 'Bot Bot B 没在运行。' });
  });
  it('a host that fails after the guard may have let the call through, and says so', async () => {
    const s = session(P2P);
    s.routeApi.mockRejectedValueOnce(new Error('vonvon 主进程 69000ms 未响应'));
    expect(await s.call({ ...CALL, bot: 'Bot B' })).toMatchObject({ ok: false, message: expect.stringContaining('可能已经生效') });
  });
  it('the answer comes back though the turn ended on the way: the call was past its guard', async () => {
    const s = session(P2P);
    s.routeApi.mockImplementationOnce(async () => { s.turn.close(); return { ok: true, result: 'done' }; });
    expect(await s.call({ ...CALL, bot: 'Bot B' })).toEqual({ ok: true, result: 'done' });
  });
  it('is no tool of a group or a comment, and refuses there whatever it is given', async () => {
    for (const place of [{ kind: 'group', chatId: GROUP }, { kind: 'doc', docId: 'd' }] as AgentPlace[]) {
      const s = session(place);
      expect(s.listed()).not.toContain(FEISHU_API);
      expect(await s.call({ ...CALL, bot: 'Bot B' })).toMatchObject({ ok: false });
      expect(s.routeApi).not.toHaveBeenCalled();
    }
  });
  describe('dmTurn stands before it leaves, in feishu_api\'s own words', () => {
    it.each<[string, Parameters<typeof session>[1], string]>([
      ['someone who is no administrator', { admin: () => false }, '只有管理员的私聊能调飞书接口。'],
      ['a turn nobody typed', { turn: { wake: true } }, '这一轮不是管理员发消息或管理员的定时任务触发的，不能调飞书接口。'],
    ])('%s', async (_case, options, words) => {
      const s = session(P2P, options);
      expect(await s.call({ ...CALL, bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused', message: words });
      expect(s.routeApi).not.toHaveBeenCalled();
    });
    it('a turn that ended', async () => {
      const s = session(P2P);
      s.turn.close();
      expect(await s.call({ ...CALL, bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused', message: '发起这次调用的那一轮已经结束了，没有调飞书。请对方重新说一遍。' });
      expect(s.routeApi).not.toHaveBeenCalled();
    });
    it('an administrator removed since the turn began', async () => {
      let admin = true;
      const s = session(P2P, { admin: () => admin });
      admin = false;
      expect(await s.call({ ...CALL, bot: 'Bot B' })).toMatchObject({ ok: false, code: 'refused', message: '只有管理员的私聊能调飞书接口。' });
      expect(s.routeApi).not.toHaveBeenCalled();
    });
    it('a private chat\'s task runs as its creator, an administrator', async () => {
      const s = session(P2P, { turn: { scheduled: { taskId: 't', runId: 'r' } } });
      expect(await s.call({ ...CALL, bot: 'Bot B' })).toMatchObject({ ok: true });
    });
  });

  describe('the host', () => {
    const on = (options: { stopped?: boolean; throws?: boolean; answer?: unknown } = {}) => {
      const execute = vi.fn(async () => {
        if (options.throws) throw new Error('timed out');
        return options.stopped ? undefined : options.answer ?? { ok: true, result: 'called' };
      });
      return { execute, deps: { bots: async () => [A, B, C], execute } };
    };
    it('finds the Bot by id or either name, and runs the call there', async () => {
      for (const bot of ['cli_b', 'Bot B', 'b']) {
        const h = on();
        expect(await routeFeishuApi(h.deps, bot, CALL)).toEqual({ ok: true, result: 'called' });
        expect(h.execute).toHaveBeenCalledExactlyOnceWith('cli_b', CALL);
      }
    });
    it('a Bot not running says so, and an unknown one lists who there is', async () => {
      expect(await routeFeishuApi(on({ stopped: true }).deps, 'Bot B', CALL)).toEqual({ ok: false, kind: 'other', message: 'Bot Bot B 没在运行。' });
      const h = on();
      expect(await routeFeishuApi(h.deps, 'Bot Z', CALL)).toMatchObject({ ok: false, message: expect.stringContaining('Bot A（cli_a）') });
      expect(h.execute).not.toHaveBeenCalled();
    });
    it('a lost answer to a change does not say it did not happen; a GET\'s may', async () => {
      expect(await routeFeishuApi(on({ throws: true }).deps, 'Bot B', CALL)).toEqual({ ok: false, kind: 'no-answer', message: 'Bot Bot B 没有回话，不知道这次调用生效没有。先查一下，再决定要不要重试。' });
      expect(await routeFeishuApi(on({ throws: true }).deps, 'Bot B', LIST)).toEqual({ ok: false, kind: 'no-answer', message: 'Bot Bot B 这次没调成：timed out' });
      expect(await routeFeishuApi(on({ answer: { nonsense: true } }).deps, 'Bot B', CALL)).toMatchObject({ ok: false, kind: 'no-answer' });
    });
    it.each(['group', 'comment'] as const)('a %s session goes no further, whatever its process sends', async place => {
      const tokens = createSessionTokens();
      tokens.issue({ appId: 'cli_a', place, ...(place === 'comment' ? {} : { chatId: GROUP }), sessionId: SESSION });
      const api = vi.fn(async () => ({ ok: true as const, result: 'called' }));
      expect(await hostFeishuApi({ appId: 'cli_a', tokens, api }, 'Bot B', { sessionId: SESSION, request: CALL })).toMatchObject({ ok: false });
      expect(api).not.toHaveBeenCalled();
    });
    it('nor another process\'s session, nor one whose token went; a private chat\'s of this process does', async () => {
      const tokens = createSessionTokens();
      tokens.issue({ appId: 'cli_a', place: 'dm', chatId: DM, sessionId: SESSION });
      const api = vi.fn(async () => ({ ok: true as const, result: 'called' }));
      expect(await hostFeishuApi({ appId: 'cli_other', tokens, api }, 'Bot B', { sessionId: SESSION, request: CALL })).toMatchObject({ ok: false });
      expect(api).not.toHaveBeenCalled();
      expect(await hostFeishuApi({ appId: 'cli_a', tokens, api }, 'Bot B', { sessionId: SESSION, request: CALL })).toEqual({ ok: true, result: 'called' });
      tokens.revoke(SESSION);
      expect(await hostFeishuApi({ appId: 'cli_a', tokens, api }, 'Bot B', { sessionId: SESSION, request: CALL })).toMatchObject({ ok: false });
      expect(api).toHaveBeenCalledTimes(1);
    });
  });

  describe('the Bot that runs it', () => {
    const bot = (send: () => Promise<unknown>) => {
      const spy = vi.fn(send);
      const channel = { rawClient: { request: spy }, botIdentity: { openId: 'ou_b', name: 'Bot B' } } as unknown as LarkChannel;
      return { spy, reader: createFeishuReader({ channel, app: { id: 'cli_b', tenant: 'feishu' } }) };
    };
    it('calls Feishu with its own client and answers with its result', async () => {
      const b = bot(async () => answer({ code: 0, data: { ok: true } }));
      expect(await createFeishuCalls(b.reader)(CALL)).toEqual({ ok: true, result: '{"code":0,"data":{"ok":true}}' });
      expect(b.spy).toHaveBeenCalledOnce();
    });
    it('a missing scope names it and gives its link, not those of whoever asked', async () => {
      const b = bot(async () => answer({ code: 99991672, msg: 'required: [calendar:calendar:readonly]', error: { permission_violations: [{ subject: 'calendar:calendar:readonly' }] } }));
      const reply = await createFeishuCalls(b.reader)(LIST);
      expect(reply).toMatchObject({ ok: false, kind: 'scope' });
      const { message } = reply as { message: string };
      expect(message).toContain('Bot「Bot B」的飞书应用缺权限');
      expect(message).toContain('https://open.feishu.cn/app/cli_b/auth');
      expect(message).not.toContain('cli_a');
      const unnamed = bot(async () => answer({ code: 99991672, msg: '应用缺少权限' }));
      expect(await createFeishuCalls(unnamed.reader)(LIST)).toMatchObject({ ok: false, kind: 'scope', message: expect.stringContaining('Bot「Bot B」的飞书应用缺权限') });
    });
    it('a document not shared names it too', async () => {
      const b = bot(async () => answer({ code: 1069303, msg: 'forbidden' }));
      expect(await createFeishuCalls(b.reader)(CALL)).toMatchObject({ ok: false, kind: 'not-shared', message: expect.stringContaining('「Bot B」') });
    });
    it('checks the path itself: the host only knows its shape', async () => {
      const b = bot(async () => answer({ code: 0 }));
      expect(await createFeishuCalls(b.reader)({ method: 'GET', path: '/open-apis/auth/v3/tenant_access_token' })).toMatchObject({ ok: false, message: expect.stringContaining('/open-apis/auth/') });
      expect(b.spy).not.toHaveBeenCalled();
    });
    it('`command.feishuRead` has no way to it: the table of reads does not have it', async () => {
      const b = bot(async () => answer({ code: 0 }));
      const reads = createFeishuReads({ members: async () => ({ members: [] }), feishu: b.reader });
      expect(await reads({ tool: FEISHU_API, args: { ...CALL } })).toMatchObject({ ok: false, message: expect.stringContaining('没有') });
      expect(b.spy).not.toHaveBeenCalled();
    });
  });
});

describe('a Bot process reading for the host (dm-agent 7.3)', () => {
  const reads = (members = vi.fn(async () => ({ members: [{ openId: 'ou_b', name: '张三' }] }))) => {
    const c = feishuChannel();
    return { ...c, members, run: createFeishuReads({ members, feishu: createFeishuReader({ channel: c.channel, app: { id: 'cli_b', tenant: 'feishu' } }) }) };
  };
  it('answers in its own name: a missing scope gives its own link and says its name, and so through whoever asked', async () => {
    const { run } = reads();
    const reply = await run({ tool: 'feishu_doc', args: { doc: 'dox' } });
    expect(reply).toMatchObject({ ok: false, kind: 'scope' });
    const { message } = reply as { message: string };
    expect(message).toContain('Bot「Bot B」的飞书应用缺权限');
    expect(message).toContain('https://open.feishu.cn/app/cli_b/auth');
    expect(message).not.toContain('cli_a');
  });
  it('takes the arguments its tool takes and no others', async () => {
    const { run, client } = reads();
    expect(await run({ tool: 'feishu_doc', args: { doc: 'dox', bot: 'Bot B' } })).toMatchObject({ ok: false, message: expect.stringContaining('参数不对') });
    expect(await run({ tool: 'feishu_doc_edit', args: { doc: 'dox', action: 'append', content: 'x' } })).toMatchObject({ ok: false, message: expect.stringContaining('没有') });
    expect(await run({ tool: 'feishu_api', args: {} })).toMatchObject({ ok: false, message: expect.stringContaining('没有') });
    expect(client.request).not.toHaveBeenCalled();
  });
  it('keeps to `only`: a group\'s command line reads its group by default, no other, and no message of another', async () => {
    const { run, client } = reads();
    expect(await run({ tool: 'feishu_messages', args: {}, only: GROUP })).toMatchObject({ ok: true });
    expect(client.im.v1.message.list).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ container_id: GROUP }) }));
    client.im.v1.message.list.mockClear();
    expect(await run({ tool: 'feishu_messages', args: { chat: 'oc_other' }, only: GROUP })).toMatchObject({ ok: false, message: expect.stringContaining('读不了别的群') });
    expect(client.im.v1.message.list).not.toHaveBeenCalled();
    expect(await run({ tool: 'feishu_message', args: { messageId: 'om_1' }, only: 'oc_other' })).toMatchObject({ ok: false, message: expect.stringContaining('不在本群') });
    expect(await run({ tool: 'feishu_members', args: { chat: 'oc_other' }, only: GROUP })).toMatchObject({ ok: false, message: expect.stringContaining('读不了别的群') });
  });
  it('asks for a chat when it has none to go on', async () => {
    const { run } = reads();
    expect(await run({ tool: 'feishu_members', args: {} })).toMatchObject({ ok: false, message: '要写 chat：想查哪个群。' });
    expect(await run({ tool: 'feishu_messages', args: {} })).toMatchObject({ ok: false, message: '要写 chat：想读哪个群。' });
  });
  it('a members refusal is an answer too; anything else is the Bot\'s failure', async () => {
    const { run } = reads(vi.fn(async () => { throw new AdminWriteError('机器人不在此群中'); }));
    expect(await run({ tool: 'feishu_members', args: { chat: GROUP } })).toEqual({ ok: false, kind: 'other', message: '机器人不在此群中' });
    const broken = reads(vi.fn(async () => { throw new Error('boom'); }));
    await expect(broken.run({ tool: 'feishu_members', args: { chat: GROUP } })).rejects.toThrow('boom');
  });
  it('comes only over the admin channel: the parent\'s, and only its tag is answered', async () => {
    const execute = vi.fn(async (_op: AdminIpcOp) => ({ ok: true, result: 'read' }));
    const send = vi.fn();
    const respond = createAdminIpcResponder(execute, send);
    respond({ fcb: 'fcb.host.req', id: 1, op: { kind: 'feishuRead', request: { tool: 'feishu_doc', args: {} } } });
    respond({ fcb: 'someone.else', id: 2, op: { kind: 'feishuRead', request: { tool: 'feishu_doc', args: {} } } });
    expect(execute).not.toHaveBeenCalled();
    respond({ fcb: ADMIN_IPC_REQ, id: 3, op: { kind: 'feishuRead', request: { tool: 'feishu_doc', args: {} } } });
    await vi.waitFor(() => { expect(send).toHaveBeenCalledWith({ fcb: ADMIN_IPC_RES, id: 3, ok: true, result: { ok: true, result: 'read' } }); });
  });
});

describe('vonvon feishu (dm-agent 7.3)', () => {
  type Fake = { agents?: { id: string; name: string }[]; reply?: unknown };
  function terminal(fake: Fake = {}) {
    const run = vi.fn(async (_request: unknown) => fake.reply ?? { kind: 'feishuRead', result: { text: '第一行\n第二行', cursor: '12' } });
    const client = { snapshot: async () => ({ agents: fake.agents ?? [{ id: 'cli_a', name: 'Bot A' }, { id: 'cli_b', name: 'Bot B' }] }), run };
    const daemon = (async fn => fn((async (_what: string, call: (c: typeof client) => unknown) => call(client)) as never)) as Daemon;
    let out = '';
    return { run, daemon, io: (json: boolean) => ({ json, write: (text: string) => { out += text; } }), out: () => out };
  }
  it('a document with --bot goes to that Bot, by name, and prints its text with the next page', async () => {
    const t = terminal();
    await runFeishuRead('feishu_doc', { doc: 'dox', cursor: undefined }, { bot: 'Bot B' }, t.io(false), t.daemon);
    expect(t.run).toHaveBeenCalledWith({ type: 'feishuRead', agentId: 'cli_b', tool: 'feishu_doc', args: { doc: 'dox' } });
    expect(t.out()).toBe('第一行\n第二行\n还有下一页：加上 --cursor 12 再运行一次。\n');
  });
  it('--json is what the tool answers', async () => {
    const t = terminal({ reply: { kind: 'feishuRead', result: { messages: [{ id: 'om_1', time: 't', sender: '张三', from: 'user', text: '你好' }] } } });
    await runFeishuRead('feishu_messages', { chat: GROUP }, { bot: 'cli_a' }, t.io(true), t.daemon);
    expect(JSON.parse(t.out())).toEqual({ ok: true, messages: [{ id: 'om_1', time: 't', sender: '张三', from: 'user', text: '你好' }] });
  });
  it('in a terminal a group goes to the Bot bound to it, and anything else wants --bot', async () => {
    setCliContext({ env: {} });
    const t = terminal();
    await runFeishuRead('feishu_messages', { chat: GROUP }, {}, t.io(true), t.daemon);
    expect(t.run).toHaveBeenCalledWith({ type: 'feishuRead', tool: 'feishu_messages', args: { chat: GROUP } });
    await expect(runFeishuRead('feishu_doc', { doc: 'dox' }, {}, t.io(true), t.daemon)).rejects.toThrow('用 --bot 指定');
  });
  it('one Bot needs no --bot', async () => {
    const t = terminal({ agents: [{ id: 'cli_a', name: 'Bot A' }] });
    await runFeishuRead('feishu_doc', { doc: 'dox' }, {}, t.io(true), t.daemon);
    expect(t.run).toHaveBeenCalledWith({ type: 'feishuRead', agentId: 'cli_a', tool: 'feishu_doc', args: { doc: 'dox' } });
  });
  it('in a session the daemon knows the Bot', async () => {
    const { SESSION_ENV } = await import('../src/config/session-env');
    setCliContext({ env: { [SESSION_ENV]: 'token' } });
    try {
      const t = terminal();
      await runFeishuRead('feishu_doc', { doc: 'dox' }, {}, t.io(true), t.daemon);
      expect(t.run).toHaveBeenCalledWith({ type: 'feishuRead', tool: 'feishu_doc', args: { doc: 'dox' } });
    } finally { setCliContext({ env: {} }); }
  });
  it('a refusal comes out in the Bot\'s words, with the exit a refusal has', async () => {
    const t = terminal({ reply: { kind: 'refused', code: 'feishu_read_refused', message: 'Bot「Bot B」的飞书应用缺权限：云文档。开通链接：https://example.invalid' } });
    const failure = await runFeishuRead('feishu_doc', { doc: 'dox' }, { bot: 'cli_b' }, t.io(true), t.daemon).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandError);
    expect((failure as CommandError).kind).toBe('refused');
    expect((failure as CommandError).message).toContain('Bot「Bot B」的飞书应用缺权限');
  });
  it('arguments a read cannot take are the caller\'s mistake, told before any Bot is asked', async () => {
    const feishuRead = vi.fn();
    const asked = commandRpc({ service: { feishuRead } } as unknown as Parameters<typeof commandRpc>[0], { type: 'feishuRead', tool: 'feishu_messages', args: { chat: GROUP, limit: 0 } });
    await expect(asked).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('参数不对') });
    expect(feishuRead).not.toHaveBeenCalled();
  });
  it('a group id has to look like one, before anything is sent', async () => {
    const t = terminal();
    await expect(runFeishuRead('feishu_members', { chat: 'not-a-group' }, {}, t.io(true), t.daemon)).rejects.toThrow('oc_');
    expect(t.run).not.toHaveBeenCalled();
  });
  it('reads what the tool reads: the same request gives the same answer', async () => {
    const c = feishuChannel();
    const members = async () => ({ members: [{ openId: 'ou_b', name: '张三' }] });
    const feishu = createFeishuReader({ channel: c.channel, app: { id: 'cli_b', tenant: 'feishu' } });
    const entries = createAgentEntries({ appId: 'cli_b', isAdmin: () => true, tools: createCommandTools({ appId: 'cli_b', groups: async () => ({ groups: [] }), members, feishu }) });
    const thread = { sessionId: 's', isAlive: () => true } as unknown as AgentThread;
    const entry = entries.issue({ kind: 'p2p', chatId: DM });
    entry.attach(thread);
    entries.openTurn(thread, { requesterOpenId: 'ou_a', requesterKind: 'user', triggerMessageId: 'om_t', retry: false, wake: false, initiative: false });
    const run = createFeishuReads({ members, feishu });
    for (const [tool, args] of [['feishu_messages', { chat: GROUP }], ['feishu_members', { chat: GROUP }], ['feishu_message', { messageId: 'om_1' }]] as const) {
      const viaTool = await entry.call(tool, args);
      const t = terminal({ reply: { kind: 'feishuRead', result: ((await run({ tool, args })) as { result: unknown }).result } });
      await runFeishuRead(tool, args, { bot: 'cli_a' }, t.io(true), t.daemon);
      expect(viaTool).toMatchObject({ ok: true });
      expect(JSON.parse(t.out())).toEqual({ ok: true, ...(viaTool as { result: object }).result });
    }
  });
  it('covers every read tool with a subcommand', async () => {
    const { loadCommands } = await import('./helpers/cli-commands');
    const commands = await loadCommands();
    const reads = commands.filter(command => command.covers.includes('command.feishuRead')).map(command => command.path);
    expect(reads).toEqual(expect.arrayContaining(['feishu members', 'feishu messages', 'feishu message', 'feishu file', 'feishu chat', 'feishu doc', 'feishu sheet', 'feishu base', 'feishu slides', 'feishu mindnote', 'feishu board', 'feishu minutes', 'feishu drive', 'feishu folder', 'feishu wiki', 'feishu comments', 'feishu doc-media', 'feishu search']));
    expect(reads).toHaveLength(feishuToolNames.size);
    for (const path of reads) expect(commands.find(command => command.path === path)?.options).toEqual(expect.arrayContaining(['--bot', '--json']));
  });
});
