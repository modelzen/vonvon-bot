import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectBridgeSource } from '../src/import/bridge/preflight';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'vonvon-import-source-'));
  temporary.push(path);
  return path;
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

const config = (id: string) => ({
  accounts: { app: { id, tenant: 'feishu', secret: { source: 'env', id: 'SYNTHETIC_SECRET' } } },
  preferences: { messageReply: 'text', access: { ownerOpenId: 'synthetic-owner', admins: ['synthetic-admin'] }, completionReminder: { mode: 'manual' } },
});

async function populateBot(dir: string, id: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await json(join(dir, 'config.json'), config(id));
  await json(join(dir, 'projects.json'), { version: 1, projects: [
    { name: 'group one', chatId: `chat-${id}`, cwd: '/synthetic/project', mode: 'qa', network: false },
  ] });
  await json(join(dir, 'sessions.json'), { version: 3, sessions: [
    { threadId: `thread-${id}`, chatId: `chat-${id}`, cwd: '/synthetic/project', sessionId: `session-${id}`, model: 'synthetic-model' },
  ] });
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, name.name);
      hash.update(file.slice(root.length));
      if (name.isDirectory()) await visit(file);
      else hash.update(await readFile(file));
    }
  }
  await visit(root);
  return hash.digest('hex');
}

it('discovers a registry layout with deterministic counts and leaves source bytes unchanged', async () => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'bots.json'), { version: 1, current: 'bot_a', bots: [
    { name: 'first', appId: 'bot_a', tenant: 'feishu' },
    { name: 'second', appId: 'bot_b', tenant: 'feishu' },
  ] });
  await populateBot(join(sourceDir, 'bots', 'bot_a'), 'bot_a');
  await populateBot(join(sourceDir, 'bots', 'bot_b'), 'bot_b');
  const before = await digestTree(sourceDir);

  const result = await inspectBridgeSource({ sourceDir });

  expect(result).toMatchObject({ kind: 'ready', format: 'multi-bot-v1', currentAppId: 'bot_a',
    counts: { bots: 2, groups: 2, sessions: 2, settings: 10 },
    bots: [
      { appId: 'bot_a', name: 'first', enabled: true, sessionCount: 1, settingCount: 2,
        settings: ['completionReminder.mode', 'messageReply'],
        projects: [{ name: 'group one', sessionCount: 1, settingCount: 2, settings: ['mode', 'network'] }],
        sessions: [{ threadId: 'thread-bot_a', chatId: 'chat-bot_a', sessionId: 'session-bot_a', settings: ['model'] }] },
      { appId: 'bot_b', name: 'second', enabled: false, sessionCount: 1, settingCount: 2 },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  expect(await digestTree(sourceDir)).toBe(before);
});

it('discovers the flat layout without creating a registry', async () => {
  const sourceDir = await fixture();
  await populateBot(sourceDir, 'flat_bot');
  const before = await digestTree(sourceDir);

  expect(await inspectBridgeSource({ sourceDir })).toMatchObject({
    kind: 'ready', format: 'legacy-flat', counts: { bots: 1, groups: 1, sessions: 1, settings: 5 },
    bots: [{ appId: 'flat_bot', name: 'default', enabled: true }],
  });
  expect(await digestTree(sourceDir)).toBe(before);
  expect((await readdir(sourceDir)).sort()).toEqual(['config.json', 'projects.json', 'sessions.json']);
});

it('rejects malformed, truncated, and oversized source files', async () => {
  const sourceDir = await fixture();
  await writeFile(join(sourceDir, 'config.json'), '{');
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-json', file: 'config.json' });

  await json(join(sourceDir, 'config.json'), { accounts: { app: { id: 'bot', tenant: 'feishu' } } });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-schema', file: 'config.json' });

  await writeFile(join(sourceDir, 'config.json'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'too-large', file: 'config.json' });
});

it('rejects invalid UTF-8 and a symlinked ancestor', async () => {
  const sourceDir = await fixture();
  await writeFile(join(sourceDir, 'config.json'), Buffer.from([0xff]));
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-encoding', file: 'config.json' });

  const parent = await fixture();
  await mkdir(join(parent, 'real'));
  await populateBot(join(parent, 'real', 'source'), 'bot');
  await symlink(join(parent, 'real'), join(parent, 'link'));
  expect(await inspectBridgeSource({ sourceDir: join(parent, 'link', 'source') })).toEqual({
    kind: 'invalid', problem: 'unsafe-path', file: '.',
  });
});

it('rejects a symlinked file and duplicate session IDs', async () => {
  const sourceDir = await fixture();
  await populateBot(sourceDir, 'bot');
  await rm(join(sourceDir, 'projects.json'));
  await symlink(join(sourceDir, 'config.json'), join(sourceDir, 'projects.json'));
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'unsafe-path', file: 'projects.json' });

  await rm(join(sourceDir, 'projects.json'));
  await json(join(sourceDir, 'sessions.json'), { version: 3, sessions: [
    { threadId: 'duplicate', chatId: 'one', cwd: '/synthetic', sessionId: 'one' },
    { threadId: 'duplicate', chatId: 'two', cwd: '/synthetic', sessionId: 'two' },
  ] });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-schema', file: 'sessions.json' });
});

it('rejects a registry/config identity mismatch and missing bot directory', async () => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'bots.json'), { version: 1, current: 'bot_a', bots: [
    { name: 'first', appId: 'bot_a', tenant: 'feishu' },
  ] });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'missing-file', file: 'bots' });

  await populateBot(join(sourceDir, 'bots', 'bot_a'), 'bot_b');
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-schema', file: join('bots', 'bot_a', 'config.json') });
});

it('accepts only an explicit absolute source directory', async () => {
  expect(await inspectBridgeSource({ sourceDir: 'relative-source' })).toEqual({ kind: 'invalid', problem: 'source-path', file: '.' });
  const sourceDir = await fixture();
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'not-found' });
});

it.each(['flat', 'nested', 'access'])('bounds wide %s preferences with a source-relative failure', async (shape) => {
  const sourceDir = await fixture();
  const base = join('bots', 'wide_bot');
  await json(join(sourceDir, 'bots.json'), { version: 1, bots: [{ name: 'wide', appId: 'wide_bot', tenant: 'feishu' }] });
  await mkdir(join(sourceDir, base), { recursive: true });
  const wide = Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`k${index}`, 0]));
  const preferences = shape === 'flat' ? wide : { [shape === 'nested' ? 'future' : 'access']: wide };
  const file = join(base, 'config.json');
  const contents = JSON.stringify({ ...config('wide_bot'), preferences });
  expect(Buffer.byteLength(contents)).toBeLessThan(16 * 1024 * 1024);
  await writeFile(join(sourceDir, file), contents);
  await expect(inspectBridgeSource({ sourceDir })).resolves.toEqual({ kind: 'invalid', problem: 'too-large', file });
});

it.each([
  ['access record', 'bad'],
  ['owner type', { ownerOpenId: 7 }],
  ['owner empty', { ownerOpenId: ' ' }],
  ['owner raw bound', { ownerOpenId: ` ${'a'.repeat(256)}` }],
  ['admins type', { admins: 'bad' }],
  ['admin type', { admins: [7] }],
  ['admin empty', { admins: [' '] }],
  ['admin raw bound', { admins: [` ${'a'.repeat(256)}`] }],
  ['admin count', { admins: Array.from({ length: 4_097 }, () => 'a') }],
])('rejects malformed known access metadata: %s', async (_name, access) => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'config.json'), { ...config('bot'), preferences: { access } });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-schema', file: 'config.json' });
});

it.each([
  ['blank', 'bad'], ['createdAt', 'bad'], ['branch', 7], ['branch', 'a'.repeat(257)],
  ['origin', 'bad'], ['addedBy', 7], ['addedBy', 'a'.repeat(257)], ['pendingPolicy', 'bad'],
  ['allowedUsers', [` ${'a'.repeat(256)}`]],
])('rejects malformed known project metadata: %s', async (key, value) => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'config.json'), config('bot'));
  await json(join(sourceDir, 'projects.json'), { version: 1, projects: [{ name: 'group', chatId: 'chat', cwd: '/synthetic', [key]: value }] });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-schema', file: 'projects.json' });
});

it.each([
  ['summary', {}], ['summary', 'a'.repeat(64 * 1024 + 1)], ['titleJobKey', {}], ['titleJobKey', 'a'.repeat(257)],
  ['lastSeenAt', 'bad'], ['createdAt', 'bad'], ['updatedAt', 'bad'],
  ['threadId', ` ${'a'.repeat(256)}`], ['chatId', ` ${'a'.repeat(256)}`], ['sessionId', ` ${'a'.repeat(256)}`],
])('rejects malformed known session metadata: %s', async (key, value) => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'config.json'), config('bot'));
  await json(join(sourceDir, 'sessions.json'), { version: 3, sessions: [{ threadId: 'thread', chatId: 'chat', cwd: '/synthetic', sessionId: 'session', [key]: value }] });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({ kind: 'invalid', problem: 'invalid-schema', file: 'sessions.json' });
});

it.each([
  ['short padding', ' /synthetic/project '],
  ['padding beyond raw path bound', `${' '.repeat(4_096)}/synthetic/project `],
])('accepts legacy v1 cwd with %s and default backend', async (_name, cwd) => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'config.json'), { ...config('bot'), preferences: { access: {} } });
  await json(join(sourceDir, 'projects.json'), { version: 1, projects: [{ name: 'group', chatId: 'chat', cwd: '/synthetic', futureMetadata: {} }] });
  await json(join(sourceDir, 'sessions.json'), { version: 1, sessions: [{ threadId: ' thread ', chatId: ' chat ', cwd, codexThreadId: ' legacy-session ', futureMetadata: {} }] });
  expect(await inspectBridgeSource({ sourceDir })).toEqual({
    kind: 'ready', format: 'legacy-flat', currentAppId: 'bot', counts: { bots: 1, groups: 1, sessions: 1, settings: 0 },
    bots: [{ appId: 'bot', name: 'default', tenant: 'feishu', enabled: true, sessionCount: 1, settingCount: 0, settings: [],
      projects: [{ name: 'group', chatId: 'chat', sessionCount: 1, settingCount: 0, settings: [] }],
      sessions: [{ threadId: 'thread', chatId: 'chat', sessionId: 'legacy-session', backend: 'codex-appserver', settings: [] }],
    }],
  });
});

it('accepts bounded known metadata and keeps future fields', async () => {
  const sourceDir = await fixture();
  await json(join(sourceDir, 'config.json'), { ...config('bot'), preferences: {
    access: { ownerOpenId: ' owner ', admins: [' admin '], futurePolicy: { enabled: true } },
    futurePreference: {},
  } });
  await json(join(sourceDir, 'projects.json'), { version: 1, projects: [{
    name: 'group', chatId: 'chat', cwd: '/synthetic', blank: false, createdAt: 0, branch: '', origin: 'joined', addedBy: '',
    pendingPolicy: 'queue', allowedUsers: [' user '], futureMetadata: {},
  }] });
  await json(join(sourceDir, 'sessions.json'), { version: 3, sessions: [{
    threadId: 'thread', chatId: 'chat', cwd: '/synthetic', sessionId: 'session', summary: 'a'.repeat(64 * 1024),
    titleJobKey: '', lastSeenAt: 0, createdAt: 0, updatedAt: 0, futureMetadata: {},
  }] });
  expect(await inspectBridgeSource({ sourceDir })).toMatchObject({ kind: 'ready',
    counts: { bots: 1, groups: 1, sessions: 1, settings: 3 },
    bots: [{ settings: ['access.futurePolicy.enabled', 'futurePreference'], projects: [{ settings: ['allowedUsers'] }] }],
  });
});

it('accepts exactly the setting traversal budget', async () => {
  const sourceDir = await fixture();
  const preferences = { future: Object.fromEntries(Array.from({ length: 99_999 }, (_, index) => [`k${index}`, 0])) };
  await json(join(sourceDir, 'config.json'), { ...config('bot'), preferences });
  const result = await inspectBridgeSource({ sourceDir });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.counts).toEqual({ bots: 1, groups: 0, sessions: 0, settings: 99_999 });
  expect(result.bots[0]?.settings).toContain('future.k99998');
});

it.each(['flat', 'registry'])('bounds intermediate and retained setting paths in a compact %s source', async (layout) => {
  const sourceDir = await fixture();
  const base = layout === 'flat' ? '' : join('bots', 'nested_bot');
  if (base) {
    await json(join(sourceDir, 'bots.json'), { version: 1, bots: [{ name: 'nested', appId: 'nested_bot', tenant: 'feishu' }] });
    await mkdir(join(sourceDir, base), { recursive: true });
  }
  const depth = 2_200;
  let nested = '0';
  let derivedCharacters = 'future'.length;
  let leafCharacters = 0;
  for (let level = 1; level <= depth; level += 1) {
    nested = `{"a":0,"b":${nested}}`;
    const pathLength = 'future'.length + level * 2;
    derivedCharacters += pathLength * 2;
    leafCharacters += pathLength;
  }
  leafCharacters += 'future'.length + depth * 2;
  const contents = `{"accounts":${JSON.stringify(config('nested_bot').accounts)},"preferences":{"future":${nested}}}`;
  expect(Buffer.byteLength(contents)).toBeLessThan(16 * 1024 * 1024);
  expect(1 + depth * 2).toBeLessThan(100_000);
  expect(derivedCharacters).toBeGreaterThan(8 * 1024 * 1024);
  expect(leafCharacters).toBeLessThan(8 * 1024 * 1024);
  const file = join(base, 'config.json');
  await writeFile(join(sourceDir, file), contents);
  const result = await inspectBridgeSource({ sourceDir });
  expect(result.kind).toBe('invalid');
  expect(result).toEqual({ kind: 'invalid', problem: 'too-large', file });
});
