import { chmod, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminReplySchema, type AdminReply } from '@vonvon/protocol';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'secrets-view-'));
  const botDir = (appId: string) => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => ({ dir: botDir(appId), configFile: join(botDir(appId), 'config.json'), projectsFile: join(botDir(appId), 'projects.json') });
  return { botDir, botPaths, paths: { appDir, projectsRootDir: join(appDir, 'projects'), botsFile: join(appDir, 'bots.json'), secretsFile: join(appDir, 'secrets.enc'), masterKeyFile: join(appDir, 'master.key') } };
});

import { paths } from '../src/config/paths';
import { acquireMutex, closeMutex, DataAccessError } from '../src/config/data-access';
import { getSecret, setSecret } from '../src/config/keystore';
import { describeKeystoreError, keyStatus, secretsAction, secretsView } from '../src/admin/secrets';
import type { AdminService } from '../src/admin/service';
import { log } from '../src/core/logger';
import { adminRpc } from '../src/server/rpc/admin';

const KEY = 'ts_TESTKEY0000';
const JEV = { kind: 'decision', provider: 'typesafe', model: 'jev-latest' };
const TYPESAFE = { keyId: 'typesafe-api-key' };
const group = (chatId: string, name: string, extra: object = {}) => ({ name, chatId, cwd: `/tmp/${chatId}`, createdAt: 1, blank: false, ...extra });
const smart = { kind: 'single', smart: true };
async function bot(appId: string, botName: string, judge: object | undefined, projects: object[] | string): Promise<void> {
  const dir = join(paths.appDir, 'bots', appId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ preferences: judge ? { judge } : {} }));
  await writeFile(join(dir, 'projects.json'), typeof projects === 'string' ? projects : JSON.stringify({ projects }));
}
const services = async () => (await secretsView()).services;
const typesafe = async () => (await services()).find(s => s.provider === 'typesafe')!;

beforeEach(async () => {
  await rm(paths.appDir, { recursive: true, force: true });
  await mkdir(paths.appDir, { recursive: true });
  await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [] }));
});

describe('keyStatus and describeKeystoreError (s23g)', () => {
  it('missing, set with its last four only from 12 characters, and a stored key no header carries', async () => {
    expect(await keyStatus(TYPESAFE)).toEqual({ status: 'missing' });
    await setSecret('typesafe-api-key', KEY);
    expect(await keyStatus(TYPESAFE)).toEqual({ status: 'set', last4: '0000' });
    await setSecret('typesafe-api-key', 'ts_SHORT01');
    expect(await keyStatus(TYPESAFE)).toEqual({ status: 'set' });
    await setSecret('typesafe-api-key', 'ts_TEST KEY0000');
    expect(await keyStatus(TYPESAFE)).toEqual({ status: 'invalid' });
  });

  it('an unreadable keystore by the cause, in fixed words', async () => {
    await setSecret('typesafe-api-key', KEY);
    await chmod(paths.masterKeyFile, 0o644);
    expect(await keyStatus(TYPESAFE)).toMatchObject({ status: 'unreadable', code: 'KEYSTORE_MASTER_KEY_MODE', problem: 'master.key 不对：要是本人所有、权限 0600、32 字节的普通文件' });
    await unlink(paths.masterKeyFile);
    await writeFile(paths.masterKeyFile, randomBytes(32), { mode: 0o600 });
    expect(await keyStatus(TYPESAFE)).toMatchObject({ status: 'unreadable', code: 'KEYSTORE_DECRYPT', problem: 'secrets.enc 解不开：master.key 和它对不上' });
    await unlink(paths.masterKeyFile);
    const gone = 'master.key 不在了，secrets.enc 解不开。不要删 secrets.enc，里面还有 Bot 的 App Secret';
    expect(await keyStatus(TYPESAFE)).toMatchObject({ status: 'unreadable', code: 'KEYSTORE_MASTER_KEY_MISSING', problem: gone });
    expect(await secretsAction({ type: 'removeSecret', keyId: 'typesafe-api-key' })).toEqual({ kind: 'refused', code: 'keystore', message: `${gone}（KEYSTORE_MASTER_KEY_MISSING）` });
    expect(await secretsAction({ type: 'testSecret', keyId: 'typesafe-api-key' })).toEqual({ kind: 'refused', code: 'keystore', message: `${gone}（KEYSTORE_MASTER_KEY_MISSING）` });
    await writeFile(paths.secretsFile, '{"version":1,');
    const broken = await keyStatus(TYPESAFE);
    expect(broken).toEqual({ status: 'unreadable', code: 'KEYSTORE_STORE_FORMAT', problem: 'secrets.enc 的格式不对' });
    expect(JSON.stringify(broken)).not.toContain(paths.appDir);
    expect(describeKeystoreError(Object.assign(new Error('EACCES: /home/u/x'), { code: 'EACCES' }))).toEqual({ code: 'EACCES', problem: '没有权限读写密钥库的文件' });
    expect(describeKeystoreError(new Error('odd'))).toEqual({ code: 'UNKNOWN', problem: '密钥库读不了' });
  });

  it('busy only when the lock was waited out; another lock failure or a file gone mid-write is not master.key', async () => {
    const held = await acquireMutex(paths.appDir, 'keystore');
    const waitedOut = await acquireMutex(paths.appDir, 'keystore', 50).catch((error: unknown) => error);
    await closeMutex(held);
    expect(describeKeystoreError(waitedOut)).toEqual({ code: 'KEYSTORE_BUSY', problem: '密钥库被别的进程占着，30 秒没等到' });
    expect(describeKeystoreError(new DataAccessError('Invalid lock directory /home/u/.vonvon-bot/.locks.'))).toEqual({ code: 'UNKNOWN', problem: '密钥库读不了' });
    expect(describeKeystoreError(Object.assign(new Error('ENOENT: open /home/u/x.tmp'), { code: 'ENOENT' }))).toEqual({ code: 'ENOENT', problem: '密钥库读不了' });
  });

  it('an unreadable keystore is logged once a minute per key and cause, not on every read', async () => {
    await setSecret('typesafe-api-key', KEY);
    // a read that works forgets what was logged before
    expect(await keyStatus(TYPESAFE)).toMatchObject({ status: 'set' });
    await chmod(paths.masterKeyFile, 0o644);
    const warn = vi.spyOn(log, 'warn');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 3; i++) expect(await keyStatus(TYPESAFE)).toMatchObject({ status: 'unreadable', code: 'KEYSTORE_MASTER_KEY_MODE' });
      expect(warn).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 60_000);
      await keyStatus(TYPESAFE);
      expect(warn).toHaveBeenCalledTimes(2);
      await unlink(paths.masterKeyFile);
      expect(await keyStatus(TYPESAFE)).toMatchObject({ code: 'KEYSTORE_MASTER_KEY_MISSING' });
      expect(warn.mock.calls.map(c => [c[1], (c[2] as { code: string }).code])).toEqual([['unreadable', 'KEYSTORE_MASTER_KEY_MODE'], ['unreadable', 'KEYSTORE_MASTER_KEY_MODE'], ['unreadable', 'KEYSTORE_MASTER_KEY_MISSING']]);
    } finally { vi.useRealTimers(); warn.mockRestore(); }
  });
});

describe('who chose a key: the judge\'s own resolution (s23g)', () => {
  it('lists the bot default, smart groups that use it, and a group outside 智能 that chose it itself; counts unread bots', async () => {
    await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: ['cli_a', 'cli_b', 'cli_c', 'cli_d'].map(appId => ({ name: appId, appId, tenant: 'feishu', createdAt: 1, ...(appId === 'cli_a' ? { botName: '值班助手' } : {}) })) }));
    await bot('cli_a', '值班助手', JEV, [
      group('oc_1', '发布群', smart),
      // a language model on the group's own backend: it judges with that
      group('oc_2', '同后端', { ...smart, judge: { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' } }),
      // stored for another backend, so the group falls to the bot's layer
      group('oc_3', '别的后端', { ...smart, backend: 'claude-agent', judge: { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' } }),
      group('oc_4', '多会话', {}),
      group('oc_5', '单会话自己选了', { kind: 'single', judge: JEV }),
      // `smart` counts only with single (registry.ts sessionModeOf)
      group('oc_6', '残留的 smart', { kind: 'multi', smart: true }),
      group('oc_7', '读不懂的覆盖', { ...smart, judge: { kind: 'decision', provider: 'Bad Id', model: 'x' } }),
    ]);
    await bot('cli_b', 'b', undefined, [group('oc_b1', '', { ...smart, judge: JEV }), group('oc_b2', '没选', smart)]);
    await bot('cli_c', 'c', JEV, '{not json');
    await bot('cli_d', 'd', { kind: 'decision', provider: 'other', model: 'x' }, [group('oc_d1', 'd', smart)]);
    const view = await secretsView();
    expect(view.unreadBots).toBe(1);
    expect(view.services.map(s => s.provider)).toEqual(['typesafe']);
    expect(view.services[0]!.inUse).toEqual([
      { agentId: 'cli_a', agentName: '值班助手' },
      { agentId: 'cli_a', agentName: '值班助手', groupId: 'oc_1', groupName: '发布群', inherited: true },
      { agentId: 'cli_a', agentName: '值班助手', groupId: 'oc_3', groupName: '别的后端', inherited: true },
      { agentId: 'cli_a', agentName: '值班助手', groupId: 'oc_5', groupName: '单会话自己选了', notSmart: true },
      { agentId: 'cli_a', agentName: '值班助手', groupId: 'oc_7', groupName: '读不懂的覆盖', inherited: true },
      { agentId: 'cli_b', agentName: 'cli_b', groupId: 'oc_b1', groupName: '' },
    ]);
    expect(view.botsUnreadable).toBeUndefined();
    expect(adminReplySchema.safeParse(view).success).toBe(true);
  });

  it('a bots.json that cannot be read leaves the keys listed, saved and removed, and says so', async () => {
    await writeFile(paths.botsFile, '{not json');
    const warn = vi.spyOn(log, 'warn');
    const view = await secretsView();
    expect(view).toMatchObject({ kind: 'secrets', unreadBots: 0, botsUnreadable: true, services: [{ status: 'missing', inUse: [] }] });
    expect(adminReplySchema.safeParse(view).success).toBe(true);
    expect(await secretsAction({ type: 'setSecret', keyId: 'typesafe-api-key', value: KEY })).toMatchObject({ kind: 'secrets', botsUnreadable: true, services: [{ status: 'set', last4: '0000' }] });
    expect(await getSecret('typesafe-api-key')).toBe(KEY);
    expect(await secretsAction({ type: 'removeSecret', keyId: 'typesafe-api-key' })).toMatchObject({ kind: 'secrets', removed: true, botsUnreadable: true });
    expect(warn).toHaveBeenCalledWith('secrets', 'bots-unreadable', { reason: expect.any(String) });
    warn.mockRestore();
  });
});

describe('secretsAction (s23g)', () => {
  const kind = <K extends AdminReply['kind']>(reply: AdminReply, k: K) => { expect(reply.kind).toBe(k); return reply as Extract<AdminReply, { kind: K }>; };
  it('set trims and saves; the reply has the last four, never the key', async () => {
    const reply = kind(await secretsAction({ type: 'setSecret', keyId: 'typesafe-api-key', value: `  ${KEY}\n` }), 'secrets');
    expect(reply.services[0]).toMatchObject({ status: 'set', last4: '0000' });
    expect(JSON.stringify(reply)).not.toContain(KEY);
    expect(await getSecret('typesafe-api-key')).toBe(KEY);
  });

  it('refuses a bad shape, an unknown name and a keystore that fails, quoting none of the input', async () => {
    for (const value of ['ts_TEST KEY', 'ts_中文', 'x'.repeat(4097), '  \n']) {
      const reply = kind(await secretsAction({ type: 'setSecret', keyId: 'typesafe-api-key', value }), 'refused');
      expect(reply.code).toBe('invalid_key');
      expect(reply.message).not.toContain(value.trim() || '\n');
    }
    expect(await getSecret('typesafe-api-key')).toBeUndefined();
    // a bot's App Secret is not the key page's
    expect(await secretsAction({ type: 'setSecret', keyId: 'app-cli_a', value: KEY })).toEqual({ kind: 'refused', code: 'unknown_service', message: '不认识的服务' });
    const held = await acquireMutex(paths.appDir, 'keystore');
    const waitedOut = await acquireMutex(paths.appDir, 'keystore', 50).catch((error: unknown) => error);
    await closeMutex(held);
    const busy = await secretsAction({ type: 'setSecret', keyId: 'typesafe-api-key', value: KEY }, { setSecret: async () => { throw waitedOut; } });
    expect(busy).toEqual({ kind: 'refused', code: 'keystore', message: '密钥库被别的进程占着，30 秒没等到（KEYSTORE_BUSY）' });
  });

  it('a broken secrets.enc is refused and left as it was: the bots\' App Secrets are in it', async () => {
    await writeFile(paths.secretsFile, '{"version":1,');
    expect(await secretsAction({ type: 'setSecret', keyId: 'typesafe-api-key', value: KEY })).toEqual({ kind: 'refused', code: 'keystore', message: 'secrets.enc 的格式不对（KEYSTORE_STORE_FORMAT）' });
    expect(await readFile(paths.secretsFile, 'utf8')).toBe('{"version":1,');
  });

  it('logs and the RPC carry no key, and a save rebuilds no snapshot', async () => {
    const info = vi.spyOn(log, 'info'); const warn = vi.spyOn(log, 'warn');
    const fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch;
    await secretsAction({ type: 'setSecret', keyId: 'typesafe-api-key', value: KEY });
    await secretsAction({ type: 'testSecret', keyId: 'typesafe-api-key' }, { fetch });
    await secretsAction({ type: 'removeSecret', keyId: 'typesafe-api-key' });
    expect(info.mock.calls.map(c => c.slice(0, 2))).toEqual([['secrets', 'set'], ['secrets', 'test'], ['secrets', 'remove']]);
    expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain('TESTKEY');
    for (const request of [{ type: 'secrets' }, { type: 'setSecret', keyId: 'typesafe-api-key', value: KEY }, { type: 'removeSecret', keyId: 'typesafe-api-key' }] as const) {
      const outcome = await adminRpc({} as AdminService, () => undefined, request);
      expect(outcome.kind).toBe('read');
      expect(JSON.stringify(outcome)).not.toContain(KEY);
    }
    info.mockRestore(); warn.mockRestore();
  });

  it('remove says whether there was a key and still lists who chose it', async () => {
    await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [{ name: 'a', appId: 'cli_a', tenant: 'feishu', createdAt: 1 }] }));
    await bot('cli_a', 'a', JEV, []);
    await setSecret('typesafe-api-key', KEY);
    const removed = kind(await secretsAction({ type: 'removeSecret', keyId: 'typesafe-api-key' }), 'secrets');
    expect(removed).toMatchObject({ removed: true, services: [{ status: 'missing', inUse: [{ agentId: 'cli_a' }] }] });
    expect(kind(await secretsAction({ type: 'removeSecret', keyId: 'typesafe-api-key' }), 'secrets').removed).toBe(false);
  });

  it('test asks the model list with the stored key, and refuses without one', async () => {
    expect(await secretsAction({ type: 'testSecret', keyId: 'typesafe-api-key' })).toEqual({ kind: 'refused', code: 'missing_key', message: '还没填 TypeSafe 的 key' });
    await setSecret('typesafe-api-key', KEY);
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetch = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response('{}', { status: 401 }); }) as unknown as typeof globalThis.fetch;
    expect(await secretsAction({ type: 'testSecret', keyId: 'typesafe-api-key' }, { fetch }))
      .toEqual({ kind: 'secretTested', keyId: 'typesafe-api-key', outcome: 'auth', message: 'key 不对：TypeSafe 不认这个 key', status: 401 });
    expect(calls[0]![0]).toBe('https://api.typesafe.ai/v1/models');
    await setSecret('typesafe-api-key', 'ts_TEST KEY0000');
    expect(await secretsAction({ type: 'testSecret', keyId: 'typesafe-api-key' }, { fetch })).toMatchObject({ kind: 'refused', code: 'invalid_key' });
    expect(calls).toHaveLength(1);
  });
});
