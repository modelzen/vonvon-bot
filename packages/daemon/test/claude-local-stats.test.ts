import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

let base: string;
let root: string;
const now = new Date('2026-11-08T12:00:00Z');
const touched = new Date('2026-11-08T11:00:00Z');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'claude-local-stats-'));
  root = join(base, 'home', '.claude', 'projects');
  vi.stubEnv('HOME', join(base, 'home'));
  vi.stubEnv('USERPROFILE', join(base, 'home'));
  vi.stubEnv('VONVON_HOME', join(base, 'vh'));
  for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(name, '');
  vi.resetModules();
});
afterEach(async () => {
  await (await import('../src/agent/claude-agent/local-stats')).stopClaudeLocalStats();
  for (const name of ['node:fs', 'node:fs/promises', '../src/core/logger']) vi.doUnmock(name);
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await rm(base, { recursive: true, force: true });
});

const user = (timestamp: string, extra: object = {}) => JSON.stringify({ type: 'user', isSidechain: false, timestamp, message: { role: 'user', content: 'private prompt text' }, ...extra });
const assistant = (timestamp: string, model: string, [input, output, read, write]: number[], extra: object = {}) => JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp,
  message: { model, content: [{ type: 'text', text: 'private reply text' }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  ...extra,
});
async function transcript(path: string, lines: string[], mtime = touched): Promise<string> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  await utimes(file, mtime, mtime);
  return file;
}

/** Two projects: a session across UTC midnight with a sub-agent, one today, one with a gap before it. */
async function fixture(): Promise<void> {
  await transcript('p-alpha/s1.jsonl', [
    user('2026-11-06T23:40:00Z'),
    assistant('2026-11-06T23:45:00Z', 'claude-opus', [10, 20, 30, 40]),
    JSON.stringify({ type: 'progress', timestamp: '2026-11-06T23:46:00Z', data: { message: { type: 'assistant', message: { model: 'claude-opus', usage: { input_tokens: 7 } } } } }),
    user('2026-11-07T00:01:00Z', { isSidechain: true }),
    assistant('2026-11-07T00:05:00Z', 'claude-sonnet', [1, 2, 3, 4]),
    assistant('2026-11-07T00:20:00Z', '<synthetic>', [1000, 0, 0, 0]),
    '{oops',
    '',
    JSON.stringify({ type: 'summary', summary: 'private summary' }),
  ]);
  await transcript('p-alpha/s1/subagents/agent-a1.jsonl', [
    user('2026-11-07T00:06:00Z', { isSidechain: true }),
    assistant('2026-11-07T00:07:00Z', 'claude-haiku', [100, 100, 100, 200], { isSidechain: true }),
  ]);
  // Claude Code's Stats reads neither nested workflow agents nor files without the agent- prefix.
  await transcript('p-alpha/s1/subagents/workflows/wf_1/agent-w1.jsonl', [assistant('2026-11-07T01:00:00Z', 'claude-haiku', [99_999, 0, 0, 0], { isSidechain: true })]);
  await transcript('p-alpha/s1/subagents/notes.jsonl', [assistant('2026-11-07T01:00:00Z', 'claude-haiku', [99_999, 0, 0, 0], { isSidechain: true })]);
  await transcript('p-beta/s2.jsonl', [user('2026-11-08T09:00:00Z'), assistant('2026-11-08T09:05:00Z', 'claude-opus', [250, 250, 250, 250])]);
  await transcript('p-beta/s3.jsonl', [user('2026-11-04T15:00:00Z')]);
  await writeFile(join(root, 'p-beta', 'notes.txt'), user('2026-11-08T10:00:00Z'));
  await writeFile(join(root, 'stray.jsonl'), user('2026-11-08T10:00:00Z'));
}

function hours(...starts: string[]): number[] {
  const counts = Array<number>(24).fill(0);
  for (const start of starts) counts[new Date(start).getHours()]!++;
  return counts;
}

it('counts like Claude Code /usage Stats: files, sidechains, sub-agents, UTC days, sessions, streaks and models', async () => {
  await fixture();
  const stats = await import('../src/agent/claude-agent/local-stats');
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root, now)).toEqual({
    dailyBuckets: [
      { date: '2026-11-04', tokens: 0, messages: 1 },
      { date: '2026-11-06', tokens: 100, messages: 2 },
      { date: '2026-11-07', tokens: 510, messages: 2 },
      { date: '2026-11-08', tokens: 1000, messages: 2 },
    ],
    lifetimeTokens: 1610,
    peakDailyTokens: 1000,
    currentStreakDays: 3,
    longestStreakDays: 3,
    localStats: {
      state: 'ready',
      models: [{ id: 'claude-opus', tokens: 1100 }, { id: 'claude-haiku', tokens: 500 }, { id: 'claude-sonnet', tokens: 10 }],
      sessions: 3,
      messages: 7,
      activeDays: 4,
      longestSessionSec: 2400,
      longestSessionMessages: 4,
      hourCounts: hours('2026-11-06T23:40:00Z', '2026-11-08T09:00:00Z', '2026-11-04T15:00:00Z'),
    },
  });
  // Today and the current streak follow the clock without a rescan.
  expect(stats.claudeLocalStats(root, new Date('2026-11-09T01:00:00Z'))).toMatchObject({ currentStreakDays: 0, longestStreakDays: 3 });
});

it("keeps Claude Code's day window: nothing after today, and a session starting today counts only today", async () => {
  await transcript('p/old.jsonl', [user('2026-11-05T10:00:00Z'), assistant('2026-11-05T10:10:00Z', 'claude-opus', [5, 5, 0, 0])]);
  await transcript('p/today.jsonl', [user('2026-11-08T08:00:00Z'), JSON.stringify({ type: 'attachment', timestamp: '2026-11-07T20:00:00Z' })]);
  await transcript('p/future.jsonl', [user('2026-11-09T10:00:00Z')]);
  // Its today pass reads only transcripts modified today.
  await transcript('p/untouched.jsonl', [user('2026-11-06T10:00:00Z'), user('2026-11-08T10:00:00Z')], new Date('2026-11-07T00:00:00Z'));
  await transcript('p/untouched-today.jsonl', [user('2026-11-08T07:00:00Z')], new Date('2026-11-07T00:00:00Z'));
  const stats = await import('../src/agent/claude-agent/local-stats');
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root, now)).toMatchObject({
    dailyBuckets: [
      { date: '2026-11-05', tokens: 10, messages: 2 },
      { date: '2026-11-06', tokens: 0, messages: 1 },
      { date: '2026-11-08', tokens: 0, messages: 1 },
    ],
    localStats: { sessions: 3, messages: 4, activeDays: 3, longestSessionSec: 172_800, longestSessionMessages: 2 },
  });
});

it('rescans only a changed transcript, keeps deleted ones and reuses the saved cache after a restart', async () => {
  vi.doMock('node:fs', async original => {
    const fs = await original<typeof import('node:fs')>();
    return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
  });
  await fixture();
  let stats = await import('../src/agent/claude-agent/local-stats');
  let reads = (await import('node:fs')).createReadStream as unknown as Mock;
  await stats.refreshClaudeLocalStats(root);
  expect(reads).toHaveBeenCalledTimes(4);

  const s2 = join(root, 'p-beta', 's2.jsonl');
  await appendFile(s2, `${assistant('2026-11-08T09:30:00Z', 'claude-sonnet', [5, 5, 0, 0])}\n`);
  await utimes(s2, now, now);
  reads.mockClear();
  await stats.refreshClaudeLocalStats(root, true);
  expect(reads.mock.calls.map(call => call[0])).toEqual([s2]);
  expect(stats.claudeLocalStats(root, now)).toMatchObject({ lifetimeTokens: 1620, localStats: { messages: 8, longestSessionSec: 2400 } });

  // Claude Code cleans up old transcripts; its stats keep the days they counted, and so do these.
  await rm(join(root, 'p-beta', 's3.jsonl'));
  reads.mockClear();
  await stats.refreshClaudeLocalStats(root, true);
  expect(reads).not.toHaveBeenCalled();
  expect(stats.claudeLocalStats(root, now).localStats).toMatchObject({ sessions: 3, messages: 8 });

  // A transcript moved to another project folder is the same session.
  const moved = join(root, 'p-gamma', 's2.jsonl');
  await mkdir(dirname(moved));
  await rename(s2, moved);
  reads.mockClear();
  await stats.refreshClaudeLocalStats(root, true);
  expect(reads.mock.calls.map(call => call[0])).toEqual([moved]);
  const before = stats.claudeLocalStats(root, now);
  expect(before).toMatchObject({ lifetimeTokens: 1620, localStats: { sessions: 3, messages: 8 } });

  const saved = await readFile(join(base, 'vh', 'claude-local-stats.json'), 'utf8');
  expect(saved).not.toMatch(/private|oops/);
  expect(await readFile(join(root, 'p-alpha', 's1.jsonl'), 'utf8')).toContain('private prompt text');

  await stats.stopClaudeLocalStats();
  vi.resetModules();
  stats = await import('../src/agent/claude-agent/local-stats');
  reads = (await import('node:fs')).createReadStream as unknown as Mock;
  reads.mockClear();
  await stats.refreshClaudeLocalStats(root);
  expect(reads).not.toHaveBeenCalled();
  expect(stats.claudeLocalStats(root, now)).toEqual(before);
});

it('reports scanning during the first scan while quota still returns, and stops on shutdown', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.doMock('node:fs/promises', async original => {
    const fs = await original<typeof import('node:fs/promises')>();
    return { ...fs, stat: vi.fn(async (path: string) => { if (path.endsWith('.jsonl')) await gate; return fs.stat(path); }) };
  });
  await fixture();
  await writeFile(join(base, 'home', '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', subscriptionType: 'max' } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ five_hour: { utilization: 12, resets_at: null } })));
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  const stats = await import('../src/agent/claude-agent/local-stats');

  const first = await fetchClaudeUsageBundle();
  expect(first.usage.main.primary).toMatchObject({ usedPercent: 12 });
  expect(first.profile).toMatchObject({ dailyBuckets: [], localStats: { state: 'scanning', sessions: 0 } });
  release();
  await vi.waitFor(async () => expect((await fetchClaudeUsageBundle()).profile.localStats?.state).toBe('ready'));
  expect((await fetchClaudeUsageBundle()).profile).toMatchObject({ topInvocations: [], lifetimeTokens: 1610, localStats: { sessions: 3 } });

  // A stopped scan writes nothing, and the next read starts over.
  await rm(join(base, 'vh'), { recursive: true, force: true });
  await transcript('p-beta/s4.jsonl', [user('2026-11-08T11:30:00Z')]);
  let hold!: () => void;
  const held = new Promise<void>(resolve => { hold = resolve; });
  const fs = await import('node:fs/promises');
  const realStat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat;
  (fs.stat as unknown as Mock).mockImplementation(async (path: string) => { await held; return realStat(path); });
  const scan = stats.refreshClaudeLocalStats(root, true);
  const stopped = stats.stopClaudeLocalStats();
  hold();
  await Promise.all([scan, stopped]);
  expect(stats.claudeLocalStats(root).localStats.state).toBe('scanning');
  await expect(stat(join(base, 'vh', 'claude-local-stats.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('logs one line without paths when the scan fails and still returns quota', async () => {
  const warn = vi.fn();
  vi.doMock('../src/core/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));
  await mkdir(dirname(root), { recursive: true });
  await writeFile(root, 'not a folder');
  await writeFile(join(base, 'home', '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ five_hour: { utilization: 3 } })));
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  expect((await fetchClaudeUsageBundle()).usage.main.primary).toMatchObject({ usedPercent: 3 });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('claude-stats', 'scan-failed', { code: 'ENOTDIR' }));
  const result = await fetchClaudeUsageBundle();
  expect(result.usage.main.primary).toMatchObject({ usedPercent: 3 });
  expect(result.profile.localStats).toEqual({ state: 'unavailable', models: [], sessions: 0, messages: 0, activeDays: 0 });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(base);
});

it('reports unavailable without writing anything when Claude Code has no transcripts', async () => {
  const stats = await import('../src/agent/claude-agent/local-stats');
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root, now).localStats.state).toBe('unavailable');
  await expect(stat(join(base, 'vh'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reads only the last 100 MiB of a larger transcript, dropping the cut first line', async () => {
  const size = 100 * 1024 * 1024 + 4096;
  const file = join(root, 'p', 'big.jsonl');
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, 'w');
  try {
    const write = (text: string, at: number) => handle.write(text, at);
    await write(`${user('2026-11-01T10:00:00Z')}\n`, 0);
    // The window starts exactly at this line, and Claude Code still drops it.
    await write(`${user('2026-11-02T10:00:00Z')}\n`, 4096);
    // A sparse body, cut into short lines so the reader never holds one huge line.
    for (let at = 8192; at < size - 4096; at += 1 << 20) await write('\n', at);
    const last = `\n${user('2026-11-03T10:00:00Z')}\n`;
    await write(last, size - Buffer.byteLength(last));
  } finally { await handle.close(); }
  await utimes(file, touched, touched);
  const stats = await import('../src/agent/claude-agent/local-stats');
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root, now)).toMatchObject({ dailyBuckets: [{ date: '2026-11-03', tokens: 0, messages: 1 }], localStats: { sessions: 1 } });
});
