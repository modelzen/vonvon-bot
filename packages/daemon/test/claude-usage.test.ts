import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let home: string;
let file: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  await mkdir(join(home, '.claude'));
  file = join(home, '.claude', '.credentials.json');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('VONVON_HOME', join(home, 'vh'));
  for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(name, '');
  vi.resetModules();
});
afterEach(async () => {
  await (await import('../src/agent/claude-agent/local-stats')).stopClaudeLocalStats();
  vi.doUnmock('node:fs/promises'); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); await rm(home, { recursive: true, force: true });
});
const credentials = (accessToken = 'fixture-token', subscriptionType = 'max') => JSON.stringify({ claudeAiOauth: { accessToken, subscriptionType, refreshToken: 'do-not-use' } });
const window = (utilization: number) => ({ utilization, resets_at: '2026-11-08T09:00:00Z' });

it('reads Linux credentials and returns real session, weekly and scoped limits without inventing daily history', async () => {
  await writeFile(file, credentials());
  const fetch = vi.fn(async () => Response.json({ five_hour: window(2), seven_day: window(91), limits: [
    { kind: 'session', percent: 3, resets_at: '2026-11-08T09:00:00Z' },
    { kind: 'weekly_all', percent: 92, resets_at: '2026-11-08T09:00:00Z' },
    { kind: 'weekly_scoped', percent: 23, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 30, resets_at: null, scope: { surface: { display_name: 'Claude Code' } } },
  ] }));
  vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  const result = await fetchClaudeUsageBundle();
  expect(result.usage).toMatchObject({ planType: 'max', main: {
    primary: { usedPercent: 3, windowSeconds: 18000, resetAt: 1794128400 },
    secondary: { usedPercent: 92, windowSeconds: 604800 },
  }, extras: [{ name: 'Fable', secondary: { usedPercent: 23, windowSeconds: 604800 } }, { name: 'Claude Code', secondary: { usedPercent: 30, windowSeconds: 604800 } }] });
  expect(result.profile).toMatchObject({ topInvocations: [], dailyBuckets: [] });
  expect(result.profile.localStats?.state).not.toBe('ready');
  expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-token', 'anthropic-beta': 'oauth-2025-04-20' }) }));
  expect(await readFile(file, 'utf8')).toBe(credentials());
  expect(JSON.stringify(result)).not.toMatch(/fixture-token|do-not-use/);
});

it('honors CLAUDE_CONFIG_DIR and user settings API mode without using another saved subscription', async () => {
  await writeFile(file, credentials());
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'api-fixture' } }));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  expect((await fetchClaudeUsageBundle()).usage).toEqual({ main: {}, extras: [], fetchedAt: expect.any(Number), unavailable: 'api-key-mode' });
  expect(fetch).not.toHaveBeenCalled();
  const dir = join(home, 'custom'); await mkdir(dir); vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  await writeFile(join(dir, '.credentials.json'), credentials('custom-token', 'pro'));
  fetch.mockResolvedValue(Response.json({ five_hour: window(0), seven_day: null }));
  expect((await fetchClaudeUsageBundle()).usage).toMatchObject({ planType: 'pro', main: { primary: { usedPercent: 0 } } });
});

it('shares concurrent reads, caches briefly and never reuses quota after credentials change', async () => {
  await writeFile(file, credentials());
  const fetch = vi.fn(async () => Response.json({ five_hour: window(10) })); vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  await Promise.all([fetchClaudeUsageBundle(), fetchClaudeUsageBundle()]);
  await fetchClaudeUsageBundle(); expect(fetch).toHaveBeenCalledTimes(1);
  await fetchClaudeUsageBundle(true); expect(fetch).toHaveBeenCalledTimes(2);
  await writeFile(file, credentials('different-account'));
  await fetchClaudeUsageBundle(); expect(fetch).toHaveBeenCalledTimes(3);
});

it('shares the new token request when credentials rotate during an unauthorized response', async () => {
  await writeFile(file, credentials('old-token'));
  let releaseOld!: (value: Response) => void;
  let releaseNew!: () => void;
  const old = new Promise<Response>(resolve => { releaseOld = resolve; });
  const fresh = new Promise<void>(resolve => { releaseNew = resolve; });
  const fetch = vi.fn().mockReturnValueOnce(old).mockImplementation(() => fresh.then(() => Response.json({ five_hour: window(5) }))); vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  const first = fetchClaudeUsageBundle();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await writeFile(file, credentials('new-token'));
  const second = fetchClaudeUsageBundle();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  releaseOld(new Response('', { status: 401 }));
  releaseNew();
  expect((await first).usage.main).toEqual((await second).usage.main);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 429, 500])('says why there is no quota for HTTP %s without exposing the response body', async status => {
  await writeFile(file, credentials());
  const fetch = vi.fn(async () => new Response('Bearer secret-fixture', { status })); vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  const results = [await fetchClaudeUsageBundle(), await fetchClaudeUsageBundle()];
  for (const result of results) expect(result.usage).toEqual({ main: {}, extras: [], fetchedAt: expect.any(Number), unavailable: status === 401 ? 'need-relogin' : 'transient' });
  expect(JSON.stringify(results)).not.toMatch(/secret-fixture|fixture-token/);
  if (status === 429) expect(fetch).toHaveBeenCalledTimes(1);
  expect(await readFile(file, 'utf8')).toBe(credentials());
});

it('says no-auth and transient for missing credentials and malformed responses instead of an empty successful quota', async () => {
  const fetch = vi.fn(async () => Response.json({ unexpected: true })); vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  expect((await fetchClaudeUsageBundle()).usage).toMatchObject({ main: {}, extras: [], unavailable: 'no-auth' });
  await writeFile(file, credentials());
  expect((await fetchClaudeUsageBundle()).usage).toMatchObject({ main: {}, extras: [], unavailable: 'transient' });
});

it('settles all reads when accounts switch A to B and back to A during 401 retries', async () => {
  let token = 'A';
  const readAuthFile = vi.fn(async () => credentials(token));
  vi.doMock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), readFile: readAuthFile }));
  let releaseA!: (response: Response) => void, releaseB!: (response: Response) => void;
  const a = new Promise<Response>(resolve => { releaseA = resolve; });
  const b = new Promise<Response>(resolve => { releaseB = resolve; });
  const fetch = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b).mockImplementation(async () => new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  vi.useFakeTimers();
  const first = fetchClaudeUsageBundle();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  token = 'B'; const second = fetchClaudeUsageBundle();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  let settled = false;
  const results = Promise.allSettled([first, second]).then(value => { settled = true; return value; });
  releaseA(new Response('', { status: 401 }));
  await vi.waitFor(() => expect(readAuthFile).toHaveBeenCalledTimes(3));
  token = 'A'; releaseB(new Response('', { status: 401 }));
  await vi.advanceTimersByTimeAsync(15_001);
  expect(settled).toBe(true);
  const relogin = { status: 'fulfilled', value: expect.objectContaining({ usage: expect.objectContaining({ main: {}, unavailable: 'need-relogin' }) }) };
  expect(await results).toEqual([relogin, relogin]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

// now-share N2b: without subscription quota the local stats still come back, and the quota says why.
const stuck = (error: Error) => vi.fn(async () => { throw error; });
const noQuota: [string, () => Promise<void>, string][] = [
  ['an API key', async () => { vi.stubEnv('ANTHROPIC_API_KEY', 'sk-fixture'); }, 'api-key-mode'],
  ['Bedrock', async () => { vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1'); }, 'api-key-mode'],
  ['Vertex', async () => { vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1'); }, 'api-key-mode'],
  ['no OAuth login', async () => {}, 'no-auth'],
  ['expired subscription credentials', async () => { await writeFile(file, credentials()); vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 }))); }, 'need-relogin'],
  ['a network error', async () => { await writeFile(file, credentials()); vi.stubGlobal('fetch', stuck(new TypeError('fetch failed'))); }, 'transient'],
];
const now = new Date('2026-11-08T12:00:00Z');
async function transcripts(): Promise<void> {
  const dir = join(home, '.claude', 'projects', 'p');
  await mkdir(dir, { recursive: true });
  const line = (type: string, timestamp: string, usage?: object) => JSON.stringify({ type, timestamp, message: { model: 'claude-opus', content: 'private text', ...(usage ? { usage } : {}) } });
  await writeFile(join(dir, 's.jsonl'), `${[line('user', '2026-11-06T10:00:00Z'), line('assistant', '2026-11-06T10:05:00Z', { input_tokens: 40, output_tokens: 2 })].join('\n')}\n`);
}

it.each(noQuota)('with %s, returns the local stats and why there is no quota', async (_case, arrange, reason) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ five_hour: window(1) })));
  await arrange();
  await transcripts();
  (await import('../src/agent/claude-agent/local-stats')).configureClaudeLocalStats({ now: () => now });
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  // The first read may still be scanning; it answers either way.
  expect((await fetchClaudeUsageBundle()).usage).toMatchObject({ main: {}, extras: [], unavailable: reason });
  await vi.waitFor(async () => expect((await fetchClaudeUsageBundle()).profile.localStats?.state).toBe('ready'));
  const result = await fetchClaudeUsageBundle();
  expect(result.usage).toEqual({ main: {}, extras: [], fetchedAt: expect.any(Number), unavailable: reason });
  expect(result.profile).toMatchObject({ lifetimeTokens: 42, dailyBuckets: [{ date: '2026-11-06', tokens: 42, messages: 2 }], localStats: { sessions: 1, messages: 2 } });
  expect(JSON.stringify(result)).not.toMatch(/sk-fixture|fixture-token|private text/);
});

it.each(noQuota)('with %s and no local stats, still answers with the reason', async (_case, arrange, reason) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ five_hour: window(1) })));
  await arrange();
  const stats = await import('../src/agent/claude-agent/local-stats');
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  await fetchClaudeUsageBundle();
  await stats.refreshClaudeLocalStats(join(home, '.claude', 'projects'));
  const result = await fetchClaudeUsageBundle();
  expect(result.usage).toEqual({ main: {}, extras: [], fetchedAt: expect.any(Number), unavailable: reason });
  expect(result.profile.localStats).toEqual({ state: 'unavailable', models: [], sessions: 0, messages: 0, activeDays: 0 });
});

it('keeps the last quota of the same credentials through a passing failure, and only that long', async () => {
  await writeFile(file, credentials());
  const fetch = vi.fn(async () => Response.json({ five_hour: window(7) })); vi.stubGlobal('fetch', fetch);
  const { fetchClaudeUsageBundle } = await import('../src/agent/claude-agent/usage');
  vi.useFakeTimers({ toFake: ['Date'] });
  const good = await fetchClaudeUsageBundle();
  expect(good.usage.main.primary).toMatchObject({ usedPercent: 7 });
  fetch.mockImplementation(async () => new Response('', { status: 503 }));
  vi.advanceTimersByTime(5 * 60_000);
  // Its own read time says how old it is.
  expect((await fetchClaudeUsageBundle(true)).usage).toEqual(good.usage);
  vi.advanceTimersByTime(6 * 60_000);
  expect((await fetchClaudeUsageBundle(true)).usage).toMatchObject({ main: {}, unavailable: 'transient' });
  // Other credentials never see it.
  fetch.mockImplementation(async () => Response.json({ five_hour: window(9) }));
  await fetchClaudeUsageBundle(true);
  fetch.mockImplementation(async () => new Response('', { status: 503 }));
  await writeFile(file, credentials('other-account'));
  expect((await fetchClaudeUsageBundle(true)).usage).toMatchObject({ main: {}, unavailable: 'transient' });
});
