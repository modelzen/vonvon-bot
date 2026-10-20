import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectBridgeSource, upgradeMessage, type SourceInspectionOptions } from '../src/import/bridge/preflight';
import { loadLegacyKeystoreKey, canDecryptLegacySecret } from '../src/import/bridge/legacy-keystore';
import { readBoundedFile, readBoundedUtf8FileStrict, withTimeout } from '../src/import/bridge/bounded-local-files';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function json(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value)); }
const config = (id: string) => ({ accounts: { app: { id, tenant: 'feishu', secret: { source: 'exec', provider: 'bridge', id: `app-${id}` } } } });
const command = vi.fn<NonNullable<SourceInspectionOptions['command']>>(async () => ({ status: 113, stdout: '', stderr: 'Could not find service' }));
async function fixture() {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'vonvon-s59-')); temporary.push(dir);
  const sourceDir = join(dir, 'bridge'); const homeDir = join(dir, 'home');
  await mkdir(sourceDir); await mkdir(homeDir);
  command.mockReset().mockResolvedValue({ status: 113, stdout: '', stderr: 'Could not find service' });
  const options = { sourceDir, homeDir, platform: 'darwin' as const, command };
  await registry(sourceDir);
  await bot(sourceDir, 'bot_a', dir);
  await bot(sourceDir, 'bot_b', join(dir, 'missing'));
  await secrets(sourceDir);
  return { dir, sourceDir, homeDir, options };
}
async function registry(root: string, ids = ['bot_a', 'bot_b']) {
  await json(join(root, 'bots.json'), { version: 1, current: ids[0], bots: ids.map(appId => ({ appId, name: appId, tenant: 'feishu' })) });
}
async function bot(root: string, id: string, cwd: string) {
  const dir = join(root, 'bots', id); await mkdir(dir, { recursive: true });
  await json(join(dir, 'config.json'), config(id));
  await json(join(dir, 'projects.json'), { version: 1, projects: [{ name: 'synthetic group', chatId: `chat-${id}`, cwd }] });
  await json(join(dir, 'sessions.json'), { version: 3, sessions: [{ threadId: `thread-${id}`, chatId: `chat-${id}`, sessionId: 'synthetic-session', cwd }] });
}
async function secrets(root: string) {
  const salt = randomBytes(32);
  const key = pbkdf2Sync(`${hostname()}|${userInfo().username}`, salt, 100000, 32, 'sha256');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update('synthetic-placeholder'), cipher.final()]);
  const envelope = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  await writeFile(join(root, '.keystore.salt'), salt);
  await json(join(root, 'secrets.enc'), { version: 1, entries: { 'app-bot_a': envelope, 'app-bot_b': envelope } });
  key.fill(0); salt.fill(0); data.fill(0);
  return envelope;
}
async function digest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name); const info = await lstat(file);
      hash.update(file.slice(root.length)); hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(await readlink(file));
      else if (info.isDirectory()) await walk(file);
      else hash.update(await readFile(file));
    }
  }
  await walk(root); return hash.digest('hex');
}
async function inspect(options: SourceInspectionOptions) {
  const result = await inspectBridgeSource(options);
  expect(result.kind).toBe('inspected');
  if (result.kind !== 'inspected') throw new Error('Expected report');
  return result;
}

it('checks every bot without a legacy admission lock, and preserves recursive source/home bytes', async () => {
  const { dir, options } = await fixture(); const before = await digest(dir);
  const result = await inspect(options);
  expect(result).toMatchObject({ service: 'stopped', bundledCodex: 'missing', bots: [
    { appId: 'bot_a', groups: 1, directories: [{ index: 0, state: 'present' }], secret: 'decryptable', hooks: { claude: 'absent', codex: 'absent' }, running: 'stopped', problems: [] },
    { appId: 'bot_b', groups: 1, directories: [{ state: 'missing' }], secret: 'decryptable', problems: [] },
  ] });
  expect(await digest(dir)).toBe(before);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('synthetic-placeholder'); expect(serialized).not.toContain('thread-bot');
  expect(serialized).not.toContain(dir); expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0]?.[0]).toBe('/bin/launchctl');
  expect(command.mock.calls[0]?.[1]?.[0]).toBe('print');
});

it('reports flat processes.json as upgrade-required, leaves it alone, and rechecks after bridge upgrades', async () => {
  const { dir, sourceDir, options } = await fixture();
  await rm(join(sourceDir, 'bots.json')); await writeFile(join(sourceDir, 'processes.json'), '{invalid old data');
  const before = await digest(dir);
  expect(await inspectBridgeSource(options)).toEqual({ kind: 'upgrade-required', message: upgradeMessage });
  expect(await digest(dir)).toBe(before); expect(command).not.toHaveBeenCalled();
  await registry(sourceDir); expect((await inspect(options)).bots).toHaveLength(2);
});
it('also guides old config-only installs without silently calling them empty', async () => {
  const { sourceDir, options } = await fixture(); await rm(join(sourceDir, 'bots.json'));
  await json(join(sourceDir, 'config.json'), config('bot_a'));
  expect(await inspectBridgeSource(options)).toEqual({ kind: 'upgrade-required', message: upgradeMessage });
});
it('requires macOS and absolute paths before reading files or querying services', async () => {
  const { options } = await fixture();
  expect(await inspectBridgeSource({ ...options, platform: 'linux' })).toEqual({ kind: 'unsupported-platform' });
  expect(await inspectBridgeSource({ ...options, sourceDir: 'relative' })).toMatchObject({ kind: 'invalid', problem: 'source-path' });
  expect(command).not.toHaveBeenCalled();
});
it.each(['missing', 'broken', 'mismatched'])('retains every bot when one config is %s', async kind => {
  const { dir, sourceDir, options } = await fixture(); const path = join(sourceDir, 'bots/bot_a/config.json');
  if (kind === 'missing') await rm(path);
  else if (kind === 'broken') await writeFile(path, '{');
  else await json(path, config('wrong-bot'));
  const before = await digest(dir); const result = await inspect(options);
  expect(result.bots).toHaveLength(2); expect(result.bots[0]?.problems).toHaveLength(1);
  expect(result.bots[1]).toMatchObject({ secret: 'decryptable', groups: 1, problems: [] });
  expect(await digest(dir)).toBe(before);
});
it.each(['projects.json', 'sessions.json'])('reports malformed %s without hiding other bots', async file => {
  const { sourceDir, options } = await fixture(); await writeFile(join(sourceDir, 'bots/bot_a', file), '{');
  const result = await inspect(options);
  expect(result.bots[0]?.problems).toEqual([{ file: join('bots/bot_a', file), code: 'invalid-json' }]);
  expect(result.bots[1]?.problems).toEqual([]);
});
it.each(['../escape', 'bot_a/../../escape'])('rejects registry path escape %s', async id => {
  const { sourceDir, options } = await fixture(); await registry(sourceDir, [id]);
  expect(await inspectBridgeSource(options)).toMatchObject({ kind: 'invalid', file: 'bots.json', problem: 'invalid-schema' });
});
it('rejects duplicate bot identities and invalid registry current', async () => {
  const { sourceDir, options } = await fixture(); await registry(sourceDir, ['bot_a', 'bot_a']);
  expect(await inspectBridgeSource(options)).toMatchObject({ kind: 'invalid', problem: 'inconsistent-registry' });
  await json(join(sourceDir, 'bots.json'), { version: 1, current: 'absent', bots: [] });
  expect(await inspectBridgeSource(options)).toMatchObject({ kind: 'invalid', problem: 'inconsistent-registry' });
});
it('rejects source ancestor/file links and group-directory links without traversing them', async () => {
  const { dir, sourceDir, options } = await fixture();
  await symlink(sourceDir, join(dir, 'alias'));
  expect(await inspectBridgeSource({ ...options, sourceDir: join(dir, 'alias') })).toMatchObject({ kind: 'invalid', file: '.' });
  const file = join(sourceDir, 'bots/bot_a/config.json'); await rm(file);
  await symlink(join(sourceDir, 'bots/bot_b/config.json'), file);
  await json(join(sourceDir, 'bots/bot_b/projects.json'), { version: 1, projects: [{ name: 'synthetic', chatId: 'synthetic', cwd: join(dir, 'alias') }] });
  const before = await digest(dir); const result = await inspect(options);
  expect(result.bots[0]?.problems[0]?.code).toBe('not-directory');
  expect(result.bots[1]?.directories[0]?.state).toBe('invalid'); expect(await digest(dir)).toBe(before);
});
it.each(['missing-store', 'missing-salt', 'short-salt', 'wrong-salt', 'bad-store', 'bad-envelope'])('handles %s without creating a salt or modifying data', async kind => {
  const { dir, sourceDir, options } = await fixture();
  if (kind === 'missing-store') await rm(join(sourceDir, 'secrets.enc'));
  if (kind === 'missing-salt') await rm(join(sourceDir, '.keystore.salt'));
  if (kind === 'short-salt') await writeFile(join(sourceDir, '.keystore.salt'), randomBytes(3));
  if (kind === 'wrong-salt') await writeFile(join(sourceDir, '.keystore.salt'), randomBytes(32));
  if (kind === 'bad-store') await writeFile(join(sourceDir, 'secrets.enc'), '{');
  if (kind === 'bad-envelope') await json(join(sourceDir, 'secrets.enc'), { version: 1, entries: { 'app-bot_a': { iv: 'bad', tag: 'bad', data: 'bad' } } });
  const before = await digest(dir); const result = await inspect(options);
  expect(result.bots[0]?.secret).toBe(kind.startsWith('missing') ? 'missing' : ['wrong-salt', 'bad-envelope'].includes(kind) ? 'cannot-decrypt' : 'invalid');
  expect(await digest(dir)).toBe(before);
});
it('does not execute external credential references or read outside files', async () => {
  const { sourceDir, options } = await fixture();
  await json(join(sourceDir, 'bots/bot_a/config.json'), { accounts: { app: { id: 'bot_a', tenant: 'feishu', secret: { source: 'file', id: '/do-not-read' } } } });
  expect((await inspect(options)).bots[0]?.secret).toBe('external-reference');
  expect(command.mock.calls.every(([binary]) => binary === '/bin/launchctl')).toBe(true);
});
it('derives a matching fake legacy key from the actual identity and rejects an invalid tag', async () => {
  const { sourceDir } = await fixture(); const envelope = await secrets(sourceDir);
  const key = await loadLegacyKeystoreKey(sourceDir); expect(key.state).toBe('ready');
  if (key.state !== 'ready') return;
  try {
    expect(canDecryptLegacySecret(key.key, envelope)).toBe(true);
    expect(canDecryptLegacySecret(key.key, { ...envelope, tag: randomBytes(16).toString('base64') })).toBe(false);
  } finally { key.key.fill(0); }
});
it('bounds reads, rejects invalid UTF-8 and directories, and times out safely', async () => {
  const { dir } = await fixture(); const path = join(dir, 'bounded'); await writeFile(path, 'ab');
  await expect(readBoundedFile(path, { maxBytes: 1, timeoutMs: 2000 })).rejects.toMatchObject({ problem: 'too-large' });
  await writeFile(path, Buffer.from([0xff]));
  await expect(readBoundedUtf8FileStrict(path, { maxBytes: 2, timeoutMs: 2000 })).rejects.toMatchObject({ problem: 'invalid-encoding' });
  await expect(readBoundedFile(dir, { maxBytes: 2, timeoutMs: 2000 })).rejects.toMatchObject({ problem: 'not-regular-file' });
  await expect(withTimeout(new Promise(() => {}), 1)).rejects.toMatchObject({ problem: 'timed-out' });
});

async function hookFixture(home: string, agent: 'claude' | 'codex', botId = 'bot_a', events = ['PermissionRequest', 'Stop']) {
  const dir = join(home, `.${agent}`); await mkdir(dir, { recursive: true });
  await json(join(dir, agent === 'claude' ? 'settings.json' : 'hooks.json'), { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: `"/synthetic/node" "/synthetic/bin/feishu-codex-bridge.mjs" hook --bot "${botId}" --agent ${agent}` }] }]])) });
  if (agent === 'codex') await writeFile(join(dir, 'config.toml'), '[features]\nhooks = true\n');
}
it('reports per-bot hooks and Codex feature gating without changing settings', async () => {
  const { dir, homeDir, options } = await fixture(); await hookFixture(homeDir, 'claude'); await hookFixture(homeDir, 'codex');
  const before = await digest(dir); const result = await inspect(options);
  expect(result.bots[0]?.hooks).toEqual({ claude: 'installed', codex: 'installed' });
  expect(result.bots[1]?.hooks).toEqual({ claude: 'absent', codex: 'absent' }); expect(await digest(dir)).toBe(before);
  await writeFile(join(homeDir, '.codex/config.toml'), '[features]\nhooks = false\n');
  expect((await inspect(options)).bots[0]?.hooks.codex).toBe('needs-repair');
  await hookFixture(homeDir, 'claude', 'bot_a', ['Stop']);
  expect((await inspect(options)).bots[0]?.hooks.claude).toBe('needs-repair');
  await writeFile(join(homeDir, '.claude/settings.json'), '{');
  expect((await inspect(options)).bots[0]?.hooks.claude).toBe('unknown');
});
it('does not call unrelated hook commands bridge hooks', async () => {
  const { homeDir, options } = await fixture(); await mkdir(join(homeDir, '.claude'));
  await json(join(homeDir, '.claude/settings.json'), { hooks: { Stop: [{ hooks: [{ command: 'other-tool hook --agent claude' }] }] } });
  expect((await inspect(options)).bots[0]?.hooks.claude).toBe('absent');
});
it('accepts the private npm Codex link but rejects a link escaping its install', async () => {
  const { dir, sourceDir, options } = await fixture(); const base = join(sourceDir, 'codex-cli/node_modules');
  await mkdir(join(base, '.bin'), { recursive: true }); await mkdir(join(base, '@openai/codex/bin'), { recursive: true });
  const cli = join(base, '@openai/codex/bin/codex.js'); await writeFile(cli, '#!/bin/sh\nexit 0'); await chmod(cli, 0o700);
  const link = join(base, '.bin/codex'); await symlink('../@openai/codex/bin/codex.js', link);
  const before = await digest(dir); expect((await inspect(options)).bundledCodex).toBe('present'); expect(await digest(dir)).toBe(before);
  await rm(link); await symlink(join(dir, 'outside'), link);
  expect((await inspect(options)).bundledCodex).toBe('invalid');
});
it.each(['running', 'stopped', 'unknown'])('parses launchctl service %s from a read-only snapshot', async state => {
  const { options } = await fixture(); command.mockResolvedValue({ status: state === 'unknown' ? 1 : 0, stdout: `state = ${state === 'stopped' ? 'not running' : state}\n`, stderr: '' });
  expect((await inspect(options)).service).toBe(state);
});
it.each(['matching', 'single', 'reused', 'foreign', 'wrong-bot', 'dead', 'malformed'])('checks per-bot process %s without signalling it', async kind => {
  const { sourceDir, options } = await fixture();
  await json(join(sourceDir, 'bots/bot_a/processes.json'), kind === 'malformed' ? {} : { pid: 424242, appId: 'bot_a', startedAt: Date.now() - (kind === 'reused' ? 600000 : 1000) });
  command.mockImplementation(async binary => binary.endsWith('launchctl') ? { status: 113, stdout: '', stderr: '' } : {
    status: kind === 'dead' ? 1 : 0,
    stdout: kind === 'dead' ? '' : `00:01 node /synthetic/bin/${kind === 'foreign' ? 'unrelated' : 'feishu-codex-bridge'}.mjs run${kind === 'single' ? '' : ` --bot ${kind === 'wrong-bot' ? 'bot_b' : 'bot_a'}`}\n`, stderr: '',
  });
  expect((await inspect(options)).bots[0]?.running).toBe(['matching', 'single'].includes(kind) ? 'running' : ['dead', 'reused'].includes(kind) ? 'stopped' : 'unknown');
  expect(command.mock.calls.every(([binary, args]) => (binary.endsWith('launchctl') && args[0] === 'print') || (binary.endsWith('ps') && args[0] === '-p'))).toBe(true);
});
it('assigns a legacy unscoped hook only to the current bot', async () => {
  const { homeDir, options } = await fixture(); await mkdir(join(homeDir, '.claude'));
  await json(join(homeDir, '.claude/settings.json'), { hooks: Object.fromEntries(['PermissionRequest', 'Stop'].map(event => [event, [{ hooks: [{ command: 'feishu-codex-bridge hook --agent claude' }] }]])) });
  const result = await inspect(options);
  expect(result.bots[0]?.hooks.claude).toBe('installed'); expect(result.bots[1]?.hooks.claude).toBe('absent');
});
it('distinguishes an empty or absent source from a corrupt registry', async () => {
  const { sourceDir, options } = await fixture();
  expect(await inspectBridgeSource({ ...options, sourceDir: join(sourceDir, 'missing') })).toEqual({ kind: 'not-found' });
  await writeFile(join(sourceDir, 'bots.json'), '{');
  expect(await inspectBridgeSource(options)).toEqual({ kind: 'invalid', file: 'bots.json', problem: 'invalid-json' });
  await rm(join(sourceDir, 'bots.json'));
  expect(await inspectBridgeSource(options)).toEqual({ kind: 'not-found' });
});
it('detects linked bot ancestors even when both target files are ordinary files', async () => {
  const { dir, sourceDir, options } = await fixture();
  const bots = join(sourceDir, 'bots'); const target = join(dir, 'other-bots');
  await mkdir(target); await rename(join(bots, 'bot_a'), join(target, 'bot_a'));
  await symlink(join(target, 'bot_a'), join(bots, 'bot_a'));
  const result = await inspect(options); expect(result.bots).toHaveLength(2);
  expect(result.bots[0]?.problems[0]?.code).toBe('not-directory');
});
it('rejects an oversized or invalidly encoded registry before native probes', async () => {
  const { sourceDir, options } = await fixture(); const file = join(sourceDir, 'bots.json');
  await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  expect(await inspectBridgeSource(options)).toMatchObject({ kind: 'invalid', problem: 'too-large' });
  await writeFile(file, Buffer.from([0xff]));
  expect(await inspectBridgeSource(options)).toMatchObject({ kind: 'invalid', problem: 'invalid-encoding' });
  expect(command).not.toHaveBeenCalled();
});
it('does not follow a linked salt or hook configuration', async () => {
  const { dir, sourceDir, homeDir, options } = await fixture();
  await rm(join(sourceDir, '.keystore.salt')); await symlink(join(dir, 'outside'), join(sourceDir, '.keystore.salt'));
  await mkdir(join(homeDir, '.claude')); await symlink(join(dir, 'outside'), join(homeDir, '.claude/settings.json'));
  const before = await digest(dir); const result = await inspect(options);
  expect(result.bots[0]?.secret).toBe('invalid'); expect(result.bots[0]?.hooks.claude).toBe('unknown');
  expect(await digest(dir)).toBe(before);
});
