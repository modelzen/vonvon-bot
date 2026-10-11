import { expect, it, vi } from 'vitest';
import { collaborationRequestSchema, collaborationReplySchema } from '@vonvon/protocol';
import { AdminWriteError } from '../src/admin/ops';
import type { AdminBot } from '../src/admin/service';
import { fakeService, socketClient, startFixture } from './server-fixture';

const bot: AdminBot = { appId: 'cli_owner', name: 'Owner', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };
const target = { agentId: bot.appId, projectName: 'demo', groupId: 'oc_demo' };
const project = { name: 'demo', chatId: 'oc_demo', cwd: '/fixture', kind: 'single', backend: 'codex-appserver', enabled: true, revision: 'revision' };
const history = { sessions: [{ threadId: 'oc_demo', chatId: 'oc_demo', sessionId: 'old', summary: 'previous', backend: 'codex-appserver', cwd: '/fixture', createdAt: 1, updatedAt: 2, detached: true }], threads: [{ sessionId: 'past', preview: 'history', name: 'Past', createdAt: 1, updatedAt: 2 }], backend: 'codex-appserver', threadsError: 'history unavailable' };
const context = { threadId: 'oc_demo', usage: { used: 20, window: 100 }, run: { id: 'run', goal: false, canStop: true, canEndGoal: false, canRemind: true, reminderRequested: false } };
const cases = [
  { request: { action: 'project', ...target }, raw: { project }, reply: { kind: 'project', project } },
  { request: { action: 'history', ...target }, raw: history, reply: { kind: 'history', ...history } },
  { request: { action: 'context', ...target, threadId: 'oc_demo' }, raw: context, reply: { kind: 'context', ...context } },
  { request: { action: 'shareUsage', ...target, sections: ['stats'] }, raw: { messageId: 'om_share' }, reply: { kind: 'applied', messageId: 'om_share' } },
  { request: { action: 'createProject', agentId: bot.appId, name: 'demo', folder: { kind: 'default' }, tool: 'codex', conversation: 'shared' }, raw: { ok: true, project }, reply: { kind: 'applied', project } },
  { request: { action: 'editProject', ...target, expectedRevision: 'revision', enabled: false }, raw: { ok: true, project }, reply: { kind: 'applied', project } },
  { request: { action: 'removeProject', ...target, expectedRevision: 'revision' }, raw: { ok: true, groupEffect: 'failed', warning: 'permission denied', message: 'unbound' }, reply: { kind: 'applied', groupEffect: 'failed', warning: 'permission denied', message: 'unbound' } },
  ...['clear', 'compact', 'startGoal', 'stop', 'endGoal', 'reminder', 'resume'].map(action => ({
    request: { action, ...target, ...(action === 'resume' ? { sessionId: 'past', backend: 'codex-appserver' } : { threadId: 'oc_demo' }), ...(action === 'startGoal' ? { objective: 'Finish' } : {}), ...(['stop', 'endGoal', 'reminder'].includes(action) ? { runId: 'run' } : {}), ...(action === 'reminder' ? { requested: true } : {}) },
    raw: { ok: true, threadId: 'oc_demo' }, reply: { kind: 'applied', threadId: 'oc_demo' },
  })),
];

it('adapts every raw collaboration operation through the WebSocket boundary', async () => {
  const collaboration = vi.fn();
  const fixture = await startFixture(fakeService({ listBots: async () => [bot], collaboration }));
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    for (const [index, test] of cases.entries()) {
      collaboration.mockResolvedValueOnce(test.raw);
      const payload = collaborationRequestSchema.parse(test.request);
      expect(await client.call({ type: 'request', id: `raw-${index}`, method: 'collaboration', payload }), payload.action).toEqual({ type: 'response', id: `raw-${index}`, method: 'collaboration', payload: collaborationReplySchema.parse(test.reply) });
      expect(collaboration.mock.calls.at(-1)?.[0]).toBe(bot.appId);
    }
    collaboration.mockResolvedValueOnce({ ok: true, kind: 'refused', code: 'spoofed', message: 'completed' });
    expect(await client.call({ type: 'request', id: 'authoritative-kind', method: 'collaboration', payload: collaborationRequestSchema.parse({ action: 'compact', ...target, threadId: 'oc_demo' }) })).toEqual({ type: 'response', id: 'authoritative-kind', method: 'collaboration', payload: { kind: 'applied', message: 'completed' } });
    collaboration.mockResolvedValueOnce({ ...context, usage: null, run: null, kind: 'applied' });
    expect(await client.call({ type: 'request', id: 'context-null', method: 'collaboration', payload: collaborationRequestSchema.parse({ action: 'context', ...target, threadId: 'oc_demo' }) })).toMatchObject({ type: 'response', payload: { kind: 'context', usage: null, run: null } });
  } finally { await client.close(); await fixture.close(); }
});

it('rejects malformed raw responses without reporting a successful mutation', async () => {
  const collaboration = vi.fn();
  const fixture = await startFixture(fakeService({ listBots: async () => [bot], collaboration }));
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    let index = 0;
    for (const test of cases) {
      const malformed: unknown[] = [null, {}, { kind: 'applied' }, { ok: false }, { ok: 'true' }];
      if (test.request.action === 'project') malformed.push({ project: { ...project, revision: 123 } });
      else if (test.request.action === 'history') malformed.push({ ...history, sessions: [{}] }, { ...history, threads: [{}] });
      else if (test.request.action === 'context') malformed.push({ ...context, usage: {} }, { ...context, run: {} });
      else if (test.request.action === 'shareUsage') malformed.push({ messageId: '' }, { messageId: 123 });
      else malformed.push({ ok: true, project: {} }, { ok: true, threadId: 123 }, { ok: true, groupEffect: 'unknown' });
      for (const raw of malformed) {
        collaboration.mockResolvedValueOnce(raw);
        expect(await client.call({ type: 'request', id: `bad-${index++}`, method: 'collaboration', payload: collaborationRequestSchema.parse(test.request) }), `${test.request.action}: ${JSON.stringify(raw)}`).toMatchObject({ type: 'error', code: 'operation_failed' });
      }
    }
    collaboration.mockRejectedValueOnce(new AdminWriteError('原任务已经结束，请刷新'));
    expect(await client.call({ type: 'request', id: 'refusal', method: 'collaboration', payload: collaborationRequestSchema.parse({ action: 'stop', ...target, threadId: 'oc_demo', runId: 'stale' }) })).toMatchObject({ type: 'error', code: 'conflict', message: '原任务已经结束，请刷新' });
    expect(await client.call({ type: 'request', id: 'still-open', method: 'snapshot', payload: { type: 'get' } })).toMatchObject({ type: 'response' });
  } finally { await client.close(); await fixture.close(); }
});

it('keeps account usage and browser-local group opening outside the owner adapter', async () => {
  const collaboration = vi.fn();
  const bundle = { profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 1 } };
  const accountUsage = vi.fn(async () => bundle);
  const fixture = await startFixture(fakeService({ collaboration, accountUsage }));
  const client = await socketClient(fixture.api.port, fixture.credential);
  try {
    await client.ready();
    expect(await client.call({ type: 'request', id: 'usage', method: 'collaboration', payload: { action: 'usage', force: true } })).toEqual({ type: 'response', id: 'usage', method: 'collaboration', payload: { kind: 'usage', data: bundle } });
    expect(accountUsage).toHaveBeenCalledWith(true);
    expect(await client.call({ type: 'request', id: 'open', method: 'collaboration', payload: collaborationRequestSchema.parse({ action: 'openGroup', ...target }) })).toMatchObject({ type: 'error', code: 'unsupported' });
    expect(collaboration).not.toHaveBeenCalled();
  } finally { await client.close(); await fixture.close(); }
});
