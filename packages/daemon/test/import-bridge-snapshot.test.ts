import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readBridgeSnapshot, type BridgeSnapshotOptions } from '../src/import/bridge/snapshot';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
const envelope = { iv: Buffer.alloc(12, 1).toString('base64'), data: Buffer.from('synthetic-ciphertext').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') };
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const entries = ['bot_a', 'bot_b'].map(appId => ({ appId, name: appId, tenant: 'feishu', createdAt: 1, active: true }));
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'vonvon-s61-snapshot-')); temporary.push(root);
  const options = { sourceDir: root, destinationSecretsGetter: '/synthetic/v1/secrets-getter' };
  await json(join(root, 'bots.json'), { version: 1, current: 'bot_a', bots: entries });
  for (const { appId } of entries) {
    const base = join(root, 'bots', appId); await mkdir(base, { recursive: true });
    await json(join(base, 'config.json'), { accounts: { app: { id: appId, tenant: 'feishu',
      secret: appId === 'bot_a' ? 'synthetic-plaintext-never-export' : { source: 'exec', provider: 'bridge', id: 'app-bot_b' },
    } }, preferences: { access: { admins: ['synthetic-admin'] }, runIdleTimeoutSeconds: 120 } });
    await json(join(base, 'projects.json'), { version: 1, projects: [{ name: 'synthetic', chatId: `chat_${appId}`,
      cwd: '/synthetic/work', blank: false, createdAt: 1, mode: 'write', guestMode: 'qa', autoCompact: false }] });
    await json(join(base, 'sessions.json'), { version: 3, sessions: [{ threadId: `thread_${appId}#admin`,
      chatId: `chat_${appId}`, cwd: '/synthetic/work', sessionId: 'synthetic-session', summary: '', createdAt: 1, updatedAt: 2 }], titleJobs: [] });
    await writeFile(join(base, 'comment-instructions.md'), 'synthetic instructions');
    await mkdir(join(base, 'outbound-files'));
  }
  await json(join(root, 'secrets.enc'), { version: 1, entries: { 'app-bot_b': envelope, unreferenced: { malformed: true } } });
  return { root, options, bot: join(root, 'bots/bot_a') };
}
async function digest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name); const info = await lstat(file);
      hash.update(file.slice(root.length)); hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(await readlink(file));
      else if (info.isDirectory()) await walk(file);
      else if (info.isFile()) hash.update(await readFile(file));
    }
  }
  await walk(root); return hash.digest('hex');
}
async function read(options: BridgeSnapshotOptions) {
  const result = await readBridgeSnapshot(options);
  expect(result.kind).toBe('read');
  if (result.kind !== 'read') throw new Error('Expected readable registry');
  return result;
}
it('reads real legacy bytes, calls the real s60 converter, and never returns plaintext or derives a key', async () => {
  const { root, options } = await fixture();
  await symlink(join(root, 'not-present'), join(root, '.keystore.salt'));
  const before = await digest(root); const result = await read(options);
  expect(result.issues).toEqual([]); expect(result.conversion.kind).toBe('converted');
  expect(result.legacySecrets).toEqual({ 'app-bot_b': envelope });
  expect(result.identity.bots).toEqual(entries.map(({ appId }) => ({ appId, tenant: 'feishu' })));
  expect(result.identity.registrySha256).toMatch(/^[a-f0-9]{64}$/);
  for (const bot of result.conversion.bots) {
    expect(bot.kind).toBe('converted'); if (bot.kind !== 'converted') throw new Error('Expected valid bot');
    expect(bot.projects.projects[0]).toMatchObject({ mode: 'qa', noMention: true, backend: 'codex-appserver' });
    expect(bot.sessions.sessions[0]?.threadId).toBe(`thread_${bot.appId}`);
    expect(bot.config.preferences).not.toHaveProperty('runIdleTimeoutSeconds');
    expect(bot.copy).toEqual(['comment-instructions.md', 'outbound-files/**']);
    expect(bot.notes.map(note => note.kind)).toEqual(expect.arrayContaining(['permission-merged', 'automatic-compaction', 'idle-timeout-default']));
  }
  expect(JSON.stringify(result)).not.toContain('synthetic-plaintext-never-export');
  expect(await digest(root)).toBe(before);
});
it('keeps title job lease state and actual session fields, not the s59 redacted report', async () => {
  const { bot, options } = await fixture();
  const job = { key: 'claude-agent:synthetic-session', backend: 'claude-agent', sessionId: 'synthetic-session', cwd: '/synthetic/work',
    phase: 'generating', policy: { strategy: 'model' }, claimId: 'synthetic-claim', leaseUntil: 10, attempts: 1, createdAt: 1, updatedAt: 2 };
  await json(join(bot, 'sessions.json'), { version: 3, sessions: [], titleJobs: [job] });
  const result = await read(options); expect(result.conversion.kind).toBe('converted');
  const converted = result.conversion.bots[0];
  expect(converted?.kind === 'converted' && converted.sessions.titleJobs).toEqual([job]);
});
it('does not resolve or execute external references', async () => {
  const { root, bot, options } = await fixture(); const reference = { source: 'exec', provider: 'external', id: 'synthetic-key' };
  await json(join(bot, 'config.json'), { accounts: { app: { id: 'bot_a', tenant: 'feishu', secret: reference } },
    secrets: { providers: { external: { source: 'exec', command: '/synthetic/nonexistent-provider' } } } });
  const before = await digest(root); const result = await read(options); const converted = result.conversion.bots[0];
  expect(converted?.kind === 'converted' && converted.secret).toEqual({ kind: 'external', reference });
  expect(converted?.kind === 'converted' && converted.config.accounts.app.secret).toEqual(reference);
  expect(await digest(root)).toBe(before);
});
it.each(['../escape', 'bot_a/../../escape', 'bot_a\n'])('rejects unsafe registry identity %j before reading bot paths', async appId => {
  const { root, options } = await fixture(); await json(join(root, 'bots.json'), { version: 1, bots: [{ ...entries[0], appId }] });
  const before = await digest(root); expect((await readBridgeSnapshot(options)).kind).toBe('invalid'); expect(await digest(root)).toBe(before);
});
it.each(['missing', 'json', 'schema', 'duplicate'])('rejects %s registry without source writes', async kind => {
  const { root, options } = await fixture(); const file = join(root, 'bots.json');
  if (kind === 'missing') await rm(file);
  if (kind === 'json') await writeFile(file, '{');
  if (kind === 'schema') await json(file, { version: 2, bots: entries });
  if (kind === 'duplicate') await json(file, { version: 1, bots: [entries[0], entries[0]] });
  const before = await digest(root); expect((await readBridgeSnapshot(options)).kind).toBe('invalid');
  expect(await digest(root)).toBe(before);
});
it.each(['config.json', 'projects.json', 'sessions.json'])('keeps valid siblings when required %s is missing', async file => {
  const { root, bot, options } = await fixture(); await rm(join(bot, file)); const before = await digest(root);
  const result = await read(options); expect(result.issues).toMatchObject([{ appId: 'bot_a', code: 'missing-file' }]);
  expect(result.conversion.kind).toBe('invalid'); expect(result.conversion.bots.map(bot => bot.kind)).toEqual(['invalid', 'converted']);
  expect(await digest(root)).toBe(before);
});
it.each(['config.json', 'projects.json', 'sessions.json'])('keeps per-bot real conversion errors for corrupt %s', async file => {
  const { root, bot, options } = await fixture(); await json(join(bot, file), { invalid: true }); const before = await digest(root);
  const result = await read(options); expect(result.conversion.kind).toBe('invalid');
  expect(result.conversion.bots.map(bot => bot.kind)).toEqual(['invalid', 'converted']); expect(await digest(root)).toBe(before);
});
it.each(['symlink', 'hardlink', 'directory', 'fifo', 'utf8', 'json'])('refuses %s source files without following or modifying them', async kind => {
  if (kind === 'fifo' && process.platform === 'win32') return;
  const { root, bot, options } = await fixture(); const file = join(bot, 'config.json'); await rm(file);
  if (kind === 'symlink') await symlink(join(root, 'bots/bot_b/config.json'), file);
  if (kind === 'hardlink') await link(join(root, 'bots/bot_b/config.json'), file);
  if (kind === 'directory') await mkdir(file);
  if (kind === 'fifo') execFileSync('mkfifo', [file]);
  if (kind === 'utf8') await writeFile(file, Buffer.from([0xff]));
  if (kind === 'json') await writeFile(file, '{');
  const before = await digest(root); const result = await read(options);
  expect(result.issues).toHaveLength(kind === 'hardlink' ? 2 : 1);
  expect(result.conversion.kind).toBe('invalid'); expect(await digest(root)).toBe(before);
});
it('rejects linked source/bot ancestors and linked outbound directories', async () => {
  const { root, bot, options } = await fixture(); const alias = join(root, 'alias'); await symlink(bot, alias);
  expect((await readBridgeSnapshot({ ...options, sourceDir: alias })).kind).toBe('invalid');
  await rmdir(join(bot, 'outbound-files')); await symlink(join(root, 'bots/bot_b/outbound-files'), join(bot, 'outbound-files'));
  expect((await read(options)).conversion.kind).toBe('invalid');
});
it('refuses a linked intermediate bots directory without traversing it', async () => {
  const { root, options } = await fixture(); const saved = join(root, 'saved-bots');
  const { rename } = await import('node:fs/promises'); await rename(join(root, 'bots'), saved);
  await symlink(saved, join(root, 'bots')); const before = await digest(root); const result = await read(options);
  expect(result.conversion.bots.map(bot => bot.kind)).toEqual(['invalid', 'invalid']);
  expect(result.issues.every(issue => issue.code === 'not-directory')).toBe(true); expect(await digest(root)).toBe(before);
});
it.each(['missing', 'bad-schema', 'bad-envelope'])('rejects %s legacy ciphertext while preserving valid siblings', async kind => {
  const { root, options } = await fixture(); const file = join(root, 'secrets.enc');
  if (kind === 'missing') await rm(file);
  if (kind === 'bad-schema') await json(file, { version: 2, entries: {} });
  if (kind === 'bad-envelope') await json(file, { version: 1, entries: { 'app-bot_b': { ...envelope, tag: 'bad' } } });
  const before = await digest(root); const result = await read(options);
  expect(result.conversion.bots.map(bot => bot.kind)).toEqual(['converted', 'invalid']); expect(result.issues[0]?.appId).toBe('bot_b');
  expect(await digest(root)).toBe(before);
});
it('freshly reads identities; registry order is immaterial and name changes are detectable', async () => {
  const { root, options } = await fixture(); const first = await read(options);
  await json(join(root, 'bots.json'), { version: 1, current: 'bot_a', bots: [...entries].reverse() });
  expect((await read(options)).identity).toEqual(first.identity);
  await json(join(root, 'bots.json'), { version: 1, current: 'bot_a', bots: entries.map(bot => ({ ...bot, name: `new_${bot.name}` })) });
  expect((await read(options)).identity.registrySha256).not.toBe(first.identity.registrySha256);
});
it('permits absent optional instructions/outbound but never absent required source or relative paths', async () => {
  const { bot, options } = await fixture(); await rm(join(bot, 'comment-instructions.md')); await rm(join(bot, 'outbound-files'), { recursive: true });
  const converted = (await read(options)).conversion.bots[0]; expect(converted?.kind === 'converted' && converted.copy).toEqual([]);
  expect((await readBridgeSnapshot({ ...options, sourceDir: 'relative' })).kind).toBe('invalid');
  expect((await readBridgeSnapshot({ ...options, sourceDir: join(options.sourceDir, 'missing') })).kind).toBe('invalid');
});
