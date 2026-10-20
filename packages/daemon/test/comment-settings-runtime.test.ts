import { afterAll, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { AgentBackend, AgentEvent, AgentRun, AskRequest } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { getSession } from '../src/bot/session-store';
import { loadConfig, saveConfig } from '../src/config/store';
import { createOrchestrator } from '../src/bot/handle-message';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'comment-settings-runtime-'));
  return { paths: { appDir, configFile: join(appDir, 'config.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') } };
});
const fixture = vi.hoisted(() => ({ backends: new Map<string, unknown>(), replies: 0, posted: vi.fn<(reply: string) => void>() }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id = 'codex-appserver') => fixture.backends.get(id) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/bot/comments', async original => ({
  ...await original<object>(),
  resolveComment: async () => ({ target: { fileType: 'docx', fileToken: 'fixture-doc' }, ctx: { question: 'fixture question', isWhole: true, targetReplyId: undefined } }),
  postCommentReply: async (_channel: unknown, _target: unknown, _event: unknown, reply: string) => { fixture.replies++; fixture.posted(reply); },
}));
function backend(id: string, ask?: { request: AskRequest; respond?: AgentRun['respondToAsk']; events?: () => AsyncIterable<AgentEvent>; turnId?: () => string | undefined }) {
  let next = 0;
  const threads: ReturnType<typeof thread>[] = [];
  function thread(sessionId: string) {
    return { sessionId, isAlive: () => true, close: vi.fn(async () => {}), abort: vi.fn(async () => {}), runStreamed: vi.fn(() => ({ turnId: ask?.turnId ?? (() => 'turn'), respondToAsk: ask?.respond, events: ask?.events?.() ?? (async function* (): AsyncGenerator<AgentEvent> { if (ask) yield { type: 'ask', request: ask.request }; yield { type: 'done', turnId: 'turn' }; })() })) };
  }
  const result = {
    id, displayName: id,
    listModels: async () => ['one', 'two'].map(model => ({ id: model, displayName: model, description: '', supportedEfforts: ['low', 'high'], defaultEffort: 'low', isDefault: model === 'one', hidden: false })),
    startThread: vi.fn(async () => { const t = thread(`${id}-${++next}`); threads.push(t); return t; }),
    resumeThread: vi.fn(async (input: { sessionId: string }) => { const t = thread(input.sessionId); threads.push(t); return t; }),
  };
  fixture.backends.set(id, result as unknown as AgentBackend);
  return { ...result, threads };
}
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
it('the next comment applies model changes to the same native session and backend changes to a new session', async () => {
  const codex = backend('codex-appserver'); const claude = backend('claude-agent');
  const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, comments: { backend: 'codex-appserver', model: 'one', effort: 'low' } } };
  const orchestrator = createOrchestrator({} as never, cfg, paths.appDir);
  const event = (replyId: string) => ({ fileType: 'docx', fileToken: 'fixture-doc', commentId: 'comment', replyId, mentionedBot: true, operator: { openId: 'ou_owner' } });
  try {
    await orchestrator.onComment(event('one') as never);
    const original = await getSession('doc:fixture-doc:comment');
    expect(original).toMatchObject({ backend: 'codex-appserver', model: 'one', effort: 'low' });
    cfg.preferences!.comments = { backend: 'codex-appserver', model: 'two', effort: 'high' };
    await orchestrator.onComment(event('two') as never);
    expect(codex.threads[0]!.close).toHaveBeenCalledOnce();
    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: original!.sessionId, model: 'two', effort: 'high' }));
    expect(await getSession('doc:fixture-doc:comment')).toMatchObject({ sessionId: original!.sessionId, model: 'two', effort: 'high' });
    cfg.preferences!.comments = { backend: 'claude-agent', model: 'one', effort: 'low' };
    await orchestrator.onComment(event('three') as never);
    expect(claude.startThread).toHaveBeenCalledOnce();
    expect(await getSession('doc:fixture-doc:comment')).toMatchObject({ backend: 'claude-agent', model: 'one' });
    expect(fixture.replies).toBe(3);
  } finally { await orchestrator.shutdown(); }
});

it('cloud comment asks resolve unavailable immediately with zero card or notification traffic', async () => {
  const respond = vi.fn<NonNullable<AgentRun['respondToAsk']>>(() => new Promise(() => {}));
  backend('codex-appserver', { request: { id: 'comment-permission', kind: 'permission', permissionMode: 'full', title: '允许吗', detail: 'need approval', acceptedConsequence: 'continue', declinedConsequence: 'deny' }, respond });
  const network = vi.fn(() => { throw new Error('unexpected network'); });
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, comments: { backend: 'codex-appserver' } } };
  const orchestrator = createOrchestrator({ send: network, rawClient: { cardkit: { v1: { card: { create: network } } } } } as never, cfg, paths.appDir);
  try {
    await orchestrator.onComment({ fileType: 'docx', fileToken: 'ask-fixture-doc', commentId: 'ask-comment', replyId: 'ask', mentionedBot: true, operator: { openId: 'ou_owner' } } as never);
    expect(respond).toHaveBeenCalledExactlyOnceWith('comment-permission', { kind: 'unanswered', reason: 'unavailable' });
    expect(network).not.toHaveBeenCalled();
  } finally { await orchestrator.shutdown(); }
});

it('a late comment response rejection cannot interrupt the next run on the reused thread', async () => {
  let rejectOld!: (error: Error) => void;
  let finishNext!: () => void;
  const delivery = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  const next = new Promise<void>(resolve => { finishNext = resolve; });
  let starts = 0;
  const request: AskRequest = { id: 'old-comment', kind: 'confirmation', title: '继续', detail: '继续', acceptedConsequence: '继续', declinedConsequence: '停止' };
  const provider = backend('codex-appserver', { request, respond: () => delivery, events: () => (async function* (): AsyncGenerator<AgentEvent> {
    const index = starts++;
    if (index === 0) yield { type: 'ask', request };
    else { yield { type: 'turn_started', turnId: 'next' }; await next; }
    yield { type: 'done', turnId: 'done' };
  })() });
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, comments: { backend: 'codex-appserver' } } };
  const orchestrator = createOrchestrator({} as never, cfg, paths.appDir);
  const event = { fileType: 'docx', fileToken: 'late-doc', commentId: 'late-comment', mentionedBot: true, operator: { openId: 'ou_owner' } };
  try {
    await orchestrator.onComment({ ...event, replyId: 'first' } as never);
    const second = orchestrator.onComment({ ...event, replyId: 'second' } as never);
    await vi.waitFor(() => expect(starts).toBe(2));
    rejectOld(new Error('old response failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(provider.threads[0]!.abort).not.toHaveBeenCalled();
    finishNext(); await second;
  } finally { finishNext(); await orchestrator.shutdown(); }
});

it('a missing comment response port recycles the origin even before a turn id exists', async () => {
  const request: AskRequest = { id: 'broken-comment', kind: 'confirmation', title: '继续', detail: '继续', acceptedConsequence: '继续', declinedConsequence: '停止' };
  const provider = backend('codex-appserver', { request, turnId: () => undefined, events: () => (async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'ask', request }; await new Promise<void>(() => {});
  })() });
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, comments: { backend: 'codex-appserver' } } };
  const orchestrator = createOrchestrator({} as never, cfg, paths.appDir);
  try {
    await orchestrator.onComment({ fileType: 'docx', fileToken: 'broken-doc', commentId: 'broken-comment', replyId: 'one', mentionedBot: true, operator: { openId: 'ou_owner' } } as never);
    expect(provider.threads[0]!.close).toHaveBeenCalled();
  } finally { await orchestrator.shutdown(); }
});

it('s36d2: with no comment backend a comment runs on the bot default backend and its model, still with no tier', async () => {
  const codex = backend('codex-appserver'); const claude = backend('claude-agent');
  const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, defaults: { backend: 'claude-agent', model: { kind: 'catalog', id: 'two', effort: 'high' } } } };
  const orchestrator = createOrchestrator({} as never, cfg, paths.appDir);
  try {
    await orchestrator.onComment({ fileType: 'docx', fileToken: 'fixture-doc', commentId: 'inherit', replyId: 'one', mentionedBot: true, operator: { openId: 'ou_owner' } } as never);
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(claude.startThread).toHaveBeenCalledOnce();
    const started = (claude.startThread.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(started).toMatchObject({ model: 'two', effort: 'high' });
    expect(started).not.toHaveProperty('mode');
    expect(await getSession('doc:fixture-doc:inherit')).toMatchObject({ backend: 'claude-agent', model: 'two', effort: 'high' });
  } finally { await orchestrator.shutdown(); }
});

it('s36d2: saving a comment model from the DM card leaves an inherited backend unset, and writes one chosen away from it', async () => {
  backend('codex-appserver'); backend('claude-agent');
  const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
  await saveConfig(cfg);
  const orchestrator = createOrchestrator({ send: async () => ({}) } as never, cfg, paths.appDir);
  const submit = (b: string, model: string) => orchestrator.dispatcher.handle({ messageId: `om_${b}_${model}`, chatId: 'oc_dm', operator: { openId: 'ou_owner' },
    action: { tag: 'button', value: { a: 'dm.comment.submit', b } }, raw: { action: { form_value: { model, effort: 'high' } } } } as never);
  try {
    await submit('codex-appserver', 'two');
    await vi.waitFor(() => expect(cfg.preferences?.comments).toEqual({ model: 'two', effort: 'high' }));
    expect((await loadConfig()).preferences?.comments).not.toHaveProperty('backend');
    await submit('claude-agent', 'one');
    await vi.waitFor(() => expect(cfg.preferences?.comments).toEqual({ backend: 'claude-agent', model: 'one', effort: 'high' }));
  } finally { await orchestrator.shutdown(); }
});

it('redacts a split token in a cloud comment reply through the orchestrator', async () => {
  const token = `vvs1_${'b'.repeat(43)}`;
  backend('codex-appserver', {
    request: { id: 'unused', kind: 'confirmation', title: '', detail: '', acceptedConsequence: '', declinedConsequence: '' },
    events: () => (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', itemId: 'answer', delta: `prefix ${token.slice(0, 19)}` };
      yield { type: 'text_delta', itemId: 'answer', delta: `${token.slice(19)} suffix` };
      yield { type: 'done', turnId: 'turn' };
    })(),
  });
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, comments: { backend: 'codex-appserver' } } };
  const orchestrator = createOrchestrator({} as never, cfg, paths.appDir);
  try {
    await orchestrator.onComment({ fileType: 'docx', fileToken: 'redact-doc', commentId: 'redact-comment', replyId: 'one', mentionedBot: true, operator: { openId: 'ou_owner' } } as never);
    expect(fixture.posted).toHaveBeenLastCalledWith('prefix [已隐藏的 vonvon 令牌] suffix');
    expect(fixture.posted.mock.calls.at(-1)?.[0]).not.toContain(token);
  } finally { await orchestrator.shutdown(); }
});
