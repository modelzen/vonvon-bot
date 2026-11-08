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
/** The module on a fixed clock: the settled date follows it like today does. */
async function load(options: { now?: Date; tailBytes?: number } = {}) {
  const stats = await import('../src/agent/claude-agent/local-stats');
  const at = options.now ?? now;
  stats.configureClaudeLocalStats({ now: () => at, ...(options.tailBytes ? { tailBytes: options.tailBytes } : {}) });
  return stats;
}
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
  const stats = await load();
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
  const stats = await load();
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
  let stats = await load();
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

  // A transcript moved to another project folder is the same session: it keeps its entry, unread.
  const moved = join(root, 'p-gamma', 's2.jsonl');
  await mkdir(dirname(moved));
  await rename(s2, moved);
  reads.mockClear();
  await stats.refreshClaudeLocalStats(root, true);
  expect(reads).not.toHaveBeenCalled();
  const before = stats.claudeLocalStats(root, now);
  expect(before).toMatchObject({ lifetimeTokens: 1620, localStats: { sessions: 3, messages: 8 } });

  const saved = await readFile(join(base, 'vh', 'claude-local-stats.json'), 'utf8');
  expect(saved).not.toMatch(/private|oops/);
  expect(await readFile(join(root, 'p-alpha', 's1.jsonl'), 'utf8')).toContain('private prompt text');

  await stats.stopClaudeLocalStats();
  vi.resetModules();
  stats = await load();
  reads = (await import('node:fs')).createReadStream as unknown as Mock;
  reads.mockClear();
  await stats.refreshClaudeLocalStats(root);
  expect(reads).not.toHaveBeenCalled();
  expect(stats.claudeLocalStats(root, now)).toEqual(before);
});

it('keeps the settled days of a transcript growing past the tail limit and recounts only the later days', async () => {
  // Like Claude Code: days through the yesterday of the last scan keep their counts, later days come from the new read.
  const pad = (count: number) => Array<string>(count).fill(JSON.stringify({ type: 'progress', data: 'x'.repeat(100) }));
  const opus = (timestamp: string, tokens: number) => assistant(timestamp, 'claude-opus', [tokens, 0, 0, 0]);
  const nextDay = new Date('2026-11-09T12:00:00Z');
  const file = await transcript('p/long.jsonl', [opus('2026-11-07T10:00:00Z', 1000), ...pad(20), opus('2026-11-08T09:00:00Z', 200)]);
  const grow = async (lines: string[], at: Date) => { await appendFile(file, `${lines.join('\n')}\n`); await utimes(file, touched, new Date(at.getTime() - 3_600_000)); };
  const session = { sessions: 1, longestSessionSec: 82_800, longestSessionMessages: 2 };
  let stats = await load({ tailBytes: 4096 });
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root)).toMatchObject({ lifetimeTokens: 1200, localStats: { messages: 2, activeDays: 2, ...session } });

  // The tail no longer reaches 11-07, settled at the first scan; the session stays as first counted.
  await grow([...pad(8), opus('2026-11-08T10:00:00Z', 300)], now);
  await stats.refreshClaudeLocalStats(root, true);
  expect(stats.claudeLocalStats(root)).toMatchObject({
    dailyBuckets: [{ date: '2026-11-07', tokens: 1000, messages: 1 }, { date: '2026-11-08', tokens: 500, messages: 2 }],
    lifetimeTokens: 1500, localStats: { messages: 3, activeDays: 2, ...session },
  });

  // A day later 11-08 is not settled yet, so it is recounted from what the tail still holds, as Claude Code does.
  stats = await load({ now: nextDay, tailBytes: 4096 });
  await grow([...pad(20), opus('2026-11-09T08:00:00Z', 50)], nextDay);
  await stats.refreshClaudeLocalStats(root, true);
  expect(stats.claudeLocalStats(root).dailyBuckets).toEqual([
    { date: '2026-11-07', tokens: 1000, messages: 1 }, { date: '2026-11-08', tokens: 300, messages: 1 }, { date: '2026-11-09', tokens: 50, messages: 1 },
  ]);

  // That scan settled 11-08: it stays when the tail moves past it.
  await grow([...pad(8), opus('2026-11-09T09:00:00Z', 70)], nextDay);
  await stats.refreshClaudeLocalStats(root, true);
  expect(stats.claudeLocalStats(root)).toMatchObject({
    dailyBuckets: [{ date: '2026-11-07', tokens: 1000, messages: 1 }, { date: '2026-11-08', tokens: 300, messages: 1 }, { date: '2026-11-09', tokens: 120, messages: 2 }],
    lifetimeTokens: 1420, currentStreakDays: 3, localStats: { messages: 4, activeDays: 3, ...session },
  });

  // The settled date survives a restart.
  await stats.stopClaudeLocalStats();
  vi.resetModules();
  stats = await load({ now: nextDay, tailBytes: 4096 });
  await grow(pad(1), nextDay);
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root)).toMatchObject({ lifetimeTokens: 1420, localStats: { messages: 4, ...session } });
});

it('counts only the unsettled days of a transcript that shows up after its session started on a settled day', async () => {
  await fixture();
  const stats = await load();
  await stats.refreshClaudeLocalStats(root);
  const before = stats.claudeLocalStats(root);
  // Claude Code never recounts a settled day, so it neither counts this session nor its 11-05 lines.
  await transcript('p-beta/s5.jsonl', [user('2026-11-05T10:00:00Z'), assistant('2026-11-05T10:05:00Z', 'claude-opus', [5, 5, 0, 0]), user('2026-11-08T11:30:00Z')]);
  await stats.refreshClaudeLocalStats(root, true);
  expect(stats.claudeLocalStats(root)).toEqual({
    ...before,
    dailyBuckets: before.dailyBuckets.map(day => day.date === '2026-11-08' ? { ...day, messages: (day.messages ?? 0) + 1 } : day),
    localStats: { ...before.localStats, messages: before.localStats.messages + 1 },
  });
});

it('discards a cache with an impossible day or an older version, and a failing summary still returns quota', async () => {
  const warn = vi.fn();
  vi.doMock('../src/core/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));
  vi.doMock('node:fs', async original => {
    const fs = await original<typeof import('node:fs')>();
    return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
  });
  await fixture();
  let stats = await load();
  await stats.refreshClaudeLocalStats(root);
  const expected = stats.claudeLocalStats(root);
  const cache = join(base, 'vh', 'claude-local-stats.json');
  const saved = JSON.parse(await readFile(cache, 'utf8')) as { files: Record<string, { days: Record<string, unknown> }> };
  const s1 = saved.files[join(root, 'p-alpha', 's1.jsonl')]!;
  const impossible = { ...saved, files: { ...saved.files, [join(root, 'p-alpha', 's1.jsonl')]: { ...s1, days: { '2026-11-00': s1.days['2026-11-06'], '2026-11-01': s1.days['2026-11-07'] } } } };
  for (const broken of [impossible, { ...saved, version: 1 }]) {
    await stats.stopClaudeLocalStats();
    await writeFile(cache, JSON.stringify(broken));
    vi.resetModules();
    stats = await load();
    const reads = (await import('node:fs')).createReadStream as unknown as Mock;
    reads.mockClear();
    await stats.refreshClaudeLocalStats(root);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(stats.claudeLocalStats(root)).toEqual(expected);
  }

  // Whatever breaks the summary, quota comes back and one line carries only an error code.
  await writeFile(join(base, 'home', '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ five_hour: { utilization: 4 } })));
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  const broken = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => { throw new RangeError('Invalid time value'); });
  const result = await fetchClaudeUsageBundle().finally(() => broken.mockRestore());
  expect(result.usage.main.primary).toMatchObject({ usedPercent: 4 });
  expect(result.profile.localStats).toEqual({ state: 'unavailable', models: [], sessions: 0, messages: 0, activeDays: 0 });
  expect(warn.mock.calls).toEqual([['claude-stats', 'summary-failed', { code: 'RangeError' }]]);
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
  const stats = await load();

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
  const stats = await load();
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
  const stats = await load();
  await stats.refreshClaudeLocalStats(root);
  expect(stats.claudeLocalStats(root, now)).toMatchObject({ dailyBuckets: [{ date: '2026-11-03', tokens: 0, messages: 1 }], localStats: { sessions: 1 } });
});
