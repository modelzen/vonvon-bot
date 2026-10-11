import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentClient } from '../src/agent/paseo/agent-sdk-types';

function historyBackend(messages: SessionMessage[], info: SDKSessionInfo = {
  sessionId: 's1', customTitle: '我的标题', summary: '摘要', firstPrompt: '第一句',
  createdAt: 2_000_000, lastModified: 5_000_000,
}) {
  const createSession = vi.fn();
  const resumeSession = vi.fn();
  const queryFactory = vi.fn();
  const client = { provider: 'claude', createSession, resumeSession } as unknown as AgentClient;
  const listSessions = vi.fn(async () => [info]);
  const getSessionMessages = vi.fn(async () => messages);
  const backend = createClaudeBackend({ client, queryFactory, history: { listSessions, getSessionMessages } });
  return { backend, listSessions, getSessionMessages, createSession, resumeSession, queryFactory };
}
function message(type: SessionMessage['type'], content: unknown): SessionMessage {
  return { type, message: { content }, uuid: 'fixture', session_id: 's1', parent_tool_use_id: null, parent_agent_id: null };
}
function tool(id: string, name: string, input: object = {}): SessionMessage {
  return message('assistant', [{ type: 'tool_use', id, name, input }]);
}
function result(id: string, content: unknown, is_error = false): SessionMessage {
  return message('user', [{ type: 'tool_result', tool_use_id: id, content, is_error }]);
}

describe('Claude public raw session history', () => {
  it('lists native sessions with title precedence and distinct creation and update timestamps', async () => {
    const { backend, listSessions } = historyBackend([]);
    expect(await backend.listThreads('/repo', 5)).toEqual([{
      sessionId: 's1', name: '我的标题', preview: '我的标题', createdAt: 2000, updatedAt: 5000,
    }]);
    expect(listSessions).toHaveBeenCalledWith({ dir: '/repo', limit: 5 });
  });

  it.each([
    [{ sessionId: 's1', summary: 'S', lastModified: 9000 }, 'S', 9],
    [{ sessionId: 's1', summary: '', firstPrompt: 'FP', lastModified: 1000 }, 'FP', 1],
  ] satisfies [SDKSessionInfo, string, number][])('preserves summary and first-prompt fallbacks: %j', async (info, preview, timestamp) => {
    const { backend, listSessions } = historyBackend([], info);
    expect(await backend.listThreads('/repo', 5)).toEqual([{
      sessionId: 's1', preview, createdAt: timestamp, updatedAt: timestamp,
    }]);
    expect(listSessions).toHaveBeenCalledWith({ dir: '/repo', limit: 5 });
  });

  it.each(['Read', 'Grep', 'WebFetch', 'PlainText', 'Unknown', 'Write', 'Task', 'ExitPlanMode'])(
    'retains raw non-shell %s output', async (name) => {
    const { backend } = historyBackend([message('user', 'read file'), tool('tool-1', name), result('tool-1', 'retained contents')]);
    expect((await backend.readHistory('/repo', 's1', 10)).turns[0]?.tools[0]?.output).toBe('retained contents');
  });

  it('returns an empty listing if the SDK session store cannot be read', async () => {
    const { backend, listSessions } = historyBackend([]);
    listSessions.mockRejectedValueOnce(new Error('session disappeared'));
    expect(await backend.listThreads('/repo', 5)).toEqual([]);
  });

  it('folds raw user, answer, reasoning, and completed tool output without starting a session', async () => {
    const { backend, getSessionMessages, createSession, resumeSession, queryFactory } = historyBackend([
      message('user', '跑个命令'), message('assistant', [{ type: 'thinking', thinking: '想一下' }]),
      tool('tu1', 'Bash', { command: 'ls' }), result('tu1', '文件列表'), message('assistant', '完成'),
    ]);
    expect(await backend.readHistory('/repo', 's1', 10)).toEqual({ totalTurns: 1, turns: [{
      userText: '跑个命令', assistantText: '完成', reasoning: '想一下', tools: [{ title: 'ls', output: '文件列表' }],
    }] });
    expect(getSessionMessages).toHaveBeenCalledWith('s1', { dir: '/repo' });
    expect(createSession).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(queryFactory).not.toHaveBeenCalled();
  });

  it('retains only the last requested turns but reports the full count', async () => {
    const messages: SessionMessage[] = [];
    for (let i = 1; i <= 5; i++) messages.push(message('user', `问题${i}`), message('assistant', `答${i}`));
    const { backend } = historyBackend(messages);
    const history = await backend.readHistory('/repo', 's1', 2);
    expect(history.totalTurns).toBe(5);
    expect(history.turns.map((turn) => turn.userText)).toEqual(['问题4', '问题5']);
  });

  it.each(['<environment_context>', '# AGENTS.md', '<system-reminder>', 'Caveat:'])(
    'omits leading-whitespace %s boilerplate from the visible history', async (prefix) => {
    const { backend } = historyBackend([
      message('user', ` \n  ${prefix} internal setup`), message('user', '真问题'), message('assistant', '真答案'),
    ]);
    expect(await backend.readHistory('/repo', 's1', 10)).toEqual({ totalTurns: 1, turns: [{
      userText: '真问题', assistantText: '真答案', reasoning: '', tools: [],
    }] });
  });

  it('keeps Read content, concatenates array text without images, and joins assistant paragraphs as V3 did', async () => {
    const { backend } = historyBackend([
      message('user', 'read'), tool('read', 'Read', { file_path: '/repo/file.ts' }),
      result('read', [{ type: 'text', text: ' A' }, { type: 'image', source: {} }, { type: 'text', text: 'B ' }], true),
      message('assistant', [{ type: 'text', text: 'first' }, { type: 'thinking', thinking: 'thought 1' }]),
      message('assistant', [{ type: 'text', text: 'second' }, { type: 'thinking', thinking: 'thought 2' }]),
    ]);
    expect(await backend.readHistory('/repo', 's1', 10)).toEqual({ totalTurns: 1, turns: [{
      userText: 'read', assistantText: 'first\n\nsecond', reasoning: 'thought 1\n\nthought 2',
      tools: [{ title: '读取 file.ts', output: 'AB', failed: true }],
    }] });
  });

  it('sorts by modification time, trims the preview, and preserves zero timestamps', async () => {
    const { backend, listSessions } = historyBackend([]);
    listSessions.mockResolvedValueOnce([
      { sessionId: 'old', summary: '', customTitle: '  title  ', createdAt: 0, lastModified: 0 },
      { sessionId: 'new', summary: '  summary ', createdAt: 1000, lastModified: 2000 },
    ]);
    const summaries = await backend.listThreads('/repo');
    expect(summaries.map((summary) => [summary.sessionId, summary.preview, summary.createdAt, summary.updatedAt]))
      .toEqual([['new', 'summary', 1, 2], ['old', 'title', 0, 0]]);
  });

  it('returns empty history on a store error without invoking a provider', async () => {
    const { backend, getSessionMessages, resumeSession, queryFactory } = historyBackend([]);
    getSessionMessages.mockRejectedValueOnce(new Error('gone'));
    expect(await backend.readHistory('/repo', 's1')).toEqual({ turns: [], totalTurns: 0 });
    expect(resumeSession).not.toHaveBeenCalled();
    expect(queryFactory).not.toHaveBeenCalled();
  });
});


it('reads an actual SDK JSONL store with raw Read results and native metadata', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-history-'));
  const sessionId = randomUUID();
  const project = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = join(project, `${sessionId}.jsonl`);
  const first = randomUUID();
  const second = randomUUID();
  const third = randomUUID();
  const fourth = randomUUID();
  await mkdir(project, { recursive: true });
  const records = [
    { type: 'user', uuid: first, parentUuid: null, message: { role: 'user', content: 'read this file' } },
    { type: 'assistant', uuid: second, parentUuid: first, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-id', name: 'Read', input: { file_path: `${cwd}/sample.ts` } }] } },
    { type: 'user', uuid: third, parentUuid: second, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-id', content: [{ type: 'text', text: 'raw ' }, { type: 'text', text: 'contents' }] }] } },
    { type: 'assistant', uuid: fourth, parentUuid: third, message: { role: 'assistant', content: [{ type: 'text', text: 'Read complete' }] } },
  ].map((record, index) => ({ ...record, cwd, sessionId, isSidechain: false, timestamp: new Date(1700000000000 + index * 1000).toISOString() }));
  await writeFile(transcript, [...records, { type: 'custom-title', sessionId, customTitle: 'Native title' }].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const queryFactory = vi.fn();
  const backend = createClaudeBackend({ queryFactory });
  try {
    expect(await backend.readHistory(cwd, sessionId, 10)).toEqual({ totalTurns: 1, turns: [{
      userText: 'read this file', assistantText: 'Read complete', reasoning: '', tools: [{ title: '读取 sample.ts', output: 'raw contents' }],
    }] });
    const summaries = await backend.listThreads(cwd, 5);
    expect(summaries).toContainEqual(expect.objectContaining({ sessionId, name: 'Native title', preview: 'Native title', createdAt: 1700000000 }));
    expect(queryFactory).not.toHaveBeenCalled();
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
