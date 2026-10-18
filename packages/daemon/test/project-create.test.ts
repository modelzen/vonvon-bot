import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths } from '../src/config/paths';
import { CREATION_UNKNOWN, CreatedButUnsavedError, CreationOutcomeUnknownError, CreationRefusedError, createProject, type CreateProjectInput } from '../src/project/lifecycle';
import { listProjects } from '../src/project/registry';
import { fakeLark, httpError, networkError, stall, type Answer } from './helpers/fake-lark-http';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-create-')));
  return { paths: { appDir: root, botsFile: join(root, 'bots.json'), projectsFile: join(root, 'projects.json'), projectsRootDir: join(root, 'projects'), backendsDir: join(root, 'backends') },
    botPaths: () => ({ projectsFile: join(root, 'projects.json'), configFile: join(root, 'config.json') }) };
});
// The effective default stands for whatever this machine detected; a group left without a pick is written with it.
vi.mock('../src/agent/detect', async original => ({ ...await original<object>(), effectiveDefaultBackend: async () => 'claude-agent' }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));

const bot = { appId: 'cli_fixture', tenant: 'feishu' as const, createdAt: 1, registrationId: 'original' };
beforeAll(() => writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [{ ...bot, name: 'fixture' }] })));
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

const groups = () => join(paths.projectsRootDir, 'fixture', 'groups');
let serial = 0;
function input(name: string, patch: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return { requestId: `request-${++serial}`, bot, name, ownerOpenId: 'ou_owner', kind: 'multi', ...patch };
}
/** chat.create answered by `create`; every other call by Feishu's plain success. */
function only(create: Answer): Answer {
  return request => request.method === 'POST' && request.path === '/open-apis/im/v1/chats' ? create(request) : undefined;
}
async function allocations(): Promise<Record<string, { chatId: string; state: string; namespaceRoot: string }>> {
  return JSON.parse(await readFile(paths.botsFile, 'utf8')).groupAllocations ?? {};
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('s36d1 createProject', () => {
  it('saves a new group in a stable directory under the bot, before the admin, announcement and welcome', async () => {
    let savedAtAdmin: unknown;
    const fake = fakeLark(request => {
      if (request.path.endsWith('/managers/add_managers')) savedAtAdmin = JSON.parse(readFileSync(paths.projectsFile, 'utf8')).projects.some((p: { name: string }) => p.name === 'Stable');
      return undefined;
    });
    const value = input('Stable');
    const project = await createProject({ rawClient: fake.client }, value);
    const cwd = join(groups(), 'Stable');
    expect(project).toMatchObject({ cwd, blank: true, directories: { workspaces: { primary: cwd, additional: [] } }, origin: 'created', mode: 'full',
      backend: 'claude-agent', network: false, creationRequestId: value.requestId, kind: 'multi', noMention: true });
    expect((await listProjects()).find(p => p.chatId === project.chatId)).toEqual(project);
    expect(Object.values(await allocations()).find(a => a.chatId === project.chatId)).toMatchObject({ state: 'ready', namespaceRoot: cwd });
    expect(fake.creates()).toHaveLength(1);
    expect(fake.creates()[0]).toMatchObject({ params: { user_id_type: 'open_id', uuid: value.requestId }, data: { name: 'Stable', user_id_list: ['ou_owner'] } });
    expect(savedAtAdmin).toBe(true);
    expect(fake.requests.map(r => r.path)).toEqual(expect.arrayContaining(['/open-apis/im/v1/messages', `/open-apis/docx/v1/chats/${project.chatId}/announcement/blocks`]));
    expect(fake.open()).toBe(0);
  });

  it('adds a suffix beside an existing directory and keeps every odd name below groups', async () => {
    await mkdir(join(groups(), 'Taken'), { recursive: true });
    await writeFile(join(groups(), 'Taken', 'keep.txt'), 'mine');
    const taken = await createProject({ rawClient: fakeLark().client }, input('Taken'));
    expect(taken.cwd).toMatch(new RegExp(`^${groups()}/Taken-[0-9a-f]{8}$`));
    expect(await readFile(join(groups(), 'Taken', 'keep.txt'), 'utf8')).toBe('mine');
    expect(await readdir(taken.cwd)).toEqual([]);
    for (const name of ['..', '.', 'a/b']) {
      const project = await createProject({ rawClient: fakeLark().client }, input(name));
      expect(project.cwd.startsWith(`${groups()}/`)).toBe(true);
      expect(await realpath(project.cwd)).toBe(project.cwd);
    }
  });

  it('touches no directory or allocation when Feishu refuses, and sends nothing for a stale or missing bot', async () => {
    const before = await allocations();
    const refused = fakeLark(only(() => { throw httpError(400, { code: 232001, msg: 'invalid name' }); }));
    await expect(createProject({ rawClient: refused.client }, input('Refused'))).rejects.toThrow(new CreationRefusedError('飞书拒绝建群 code=232001：invalid name'));
    expect(existsSync(join(groups(), 'Refused'))).toBe(false);
    expect(await allocations()).toEqual(before);
    const silent = fakeLark();
    const dir = join(paths.projectsRootDir, 'explicit-stale');
    await mkdir(dir, { recursive: true });
    for (const patch of [{ bot: { ...bot, registrationId: 'stale' } }, { bot: { ...bot, registrationId: 'stale' }, existingPath: dir }]) {
      await expect(createProject({ rawClient: silent.client }, input('Stale', patch))).rejects.toThrow('重新注册');
    }
    await expect(createProject({ rawClient: silent.client }, input('No bot', { bot: undefined as never }))).rejects.toThrow('缺少机器人注册身份');
    await expect(createProject({ rawClient: silent.client }, input('Long', { requestId: 'r'.repeat(51) }))).rejects.toThrow('建群请求标识无效');
    await expect(createProject({ rawClient: silent.client }, input('Elsewhere'), { file: join(paths.appDir, 'other', 'projects.json'), dataRoot: paths.appDir })).rejects.toThrow('机器人项目目录不匹配');
    await expect(createProject({ rawClient: silent.client }, input('Elsewhere'), { file: paths.projectsFile, dataRoot: join(paths.appDir, 'other') })).rejects.toThrow('机器人项目目录不匹配');
    expect(silent.requests).toEqual([]);
    expect((await listProjects()).some(p => ['Refused', 'Stale', 'No bot', 'Long', 'Elsewhere'].includes(p.name))).toBe(false);
  });

  it('says a group may exist when chat.create never answers within the budget, and leaves no request open', async () => {
    const fake = fakeLark(only(stall));
    const started = Date.now();
    const failure = await createProject({ rawClient: fake.client }, input('Stalled', { timeoutMs: 300 })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CreationOutcomeUnknownError);
    expect((failure as Error).message).toBe(CREATION_UNKNOWN);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(fake.creates()).toHaveLength(1);
    expect(fake.open()).toBe(0);
    expect(existsSync(join(groups(), 'Stalled'))).toBe(false);
  });

  it.each([
    ['HTTP 5xx', () => { throw httpError(502, '<html>bad gateway</html>'); }],
    ['code 232068 thrown', () => { throw httpError(400, { code: 232068, msg: 'chat is creating' }); }],
    ['code 232068 resolved', () => ({ code: 232068, msg: 'chat is creating' })],
    ['a reset connection', () => { throw networkError('ECONNRESET'); }],
    ['code 0 without a chat id', () => ({ code: 0, data: {} })],
    ['an error it cannot read', () => { throw new Error('unexpected'); }],
  ] as const)('says a group may exist after %s', async (_label, create) => {
    await expect(createProject({ rawClient: fakeLark(only(create)).client }, input('Unknown'))).rejects.toBeInstanceOf(CreationOutcomeUnknownError);
  });

  it.each([
    ['a refusal with HTTP 200', () => ({ code: 232011, msg: 'operator is not in the chat' }), '飞书拒绝建群 code=232011：operator is not in the chat'],
    ['a host that never resolved', () => { throw networkError('ENOTFOUND'); }, '没有发出建群请求：ENOTFOUND'],
  ] as const)('says nothing was created after %s', async (_label, create, message) => {
    await expect(createProject({ rawClient: fakeLark(only(create)).client }, input('Refused twice'))).rejects.toThrow(new CreationRefusedError(message));
  });

  it('says nothing was created when the token fails or the scope closes before chat.create is sent', async () => {
    const token = fakeLark(request => request.path.includes('tenant_access_token') ? { code: 10014, msg: 'app secret invalid' } : undefined);
    await expect(createProject({ rawClient: token.client }, input('No token'))).rejects.toThrow(new CreationRefusedError('没有发出建群请求：failed to get tenant_access_token, code: 10014, msg: app secret invalid'));
    expect(token.creates()).toEqual([]);
    const stop = new AbortController();
    const closing = fakeLark(request => request.path.includes('tenant_access_token') ? stall() : undefined);
    const pending = createProject({ rawClient: closing.client }, input('Closed early', { signal: stop.signal }));
    await vi.waitFor(() => expect(closing.requests).toHaveLength(1), { timeout: 10_000 });
    stop.abort();
    await expect(pending).rejects.toBeInstanceOf(CreationRefusedError);
    expect(closing.creates()).toEqual([]);
    expect(closing.open()).toBe(0);
  });

  it('saves before addManagers is sent, and a stuck addManagers ends with the creation\'s stop', async () => {
    const fake = fakeLark(request => request.path.endsWith('/managers/add_managers') ? stall() : undefined);
    const stop = new AbortController();
    const creating = createProject({ rawClient: fake.client }, input('Stuck admin', { signal: stop.signal }));
    await vi.waitFor(() => expect(fake.requests.some(r => r.path.endsWith('/managers/add_managers'))).toBe(true), { timeout: 10_000 });
    // The row is on disk while the admin call is still out, so a kill during it cannot lose the group.
    expect((await listProjects()).some(p => p.name === 'Stuck admin')).toBe(true);
    stop.abort();
    const outcome = await Promise.race([creating, wait(3_000).then(() => 'hung' as const)]);
    expect(outcome).toMatchObject({ name: 'Stuck admin', origin: 'created' });
    expect(fake.open()).toBe(0);
  });

  it('cuts the announcement and welcome at the budget instead of retrying them', async () => {
    const fake = fakeLark(request => {
      if (request.method === 'POST' && request.path === '/open-apis/im/v1/chats') return wait(300).then(() => ({ code: 0, data: { chat_id: 'oc_slow' } }));
      if (request.path.endsWith('/announcement/blocks')) return stall();
      return undefined;
    });
    const started = Date.now();
    const project = await createProject({ rawClient: fake.client }, input('Slow create', { timeoutMs: 2_000 }));
    // Retrying would add 8 s of backoff on top of the 2 s budget.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(project.chatId).toBe('oc_slow');
    expect(fake.requests.filter(r => r.path.endsWith('/announcement/blocks'))).toHaveLength(1);
    expect(fake.requests.filter(r => r.path === '/open-apis/im/v1/messages')).toEqual([]);
  });

  it('tells where to bind a created group that was not saved, never to retry', async () => {
    const fake = fakeLark(only(request => {
      // Another writer takes the name while the group is being created.
      const stored = existsSync(paths.projectsFile) ? JSON.parse(readFileSync(paths.projectsFile, 'utf8')) : { version: 1, projects: [] };
      stored.projects.push({ name: 'Raced', chatId: 'oc_other', cwd: paths.appDir, blank: false, createdAt: 1 });
      writeFileSync(paths.projectsFile, JSON.stringify(stored));
      return { code: 0, data: { chat_id: `oc_${String(request.params?.uuid)}` } };
    }));
    const failure = await createProject({ rawClient: fake.client }, input('Raced')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CreatedButUnsavedError);
    expect((failure as CreatedButUnsavedError).chatId).toMatch(/^oc_request-/);
    expect((failure as Error).message).toMatch(/^群「Raced」已建好，但没存上：.*加入现有飞书群.*不要再建$/);
    expect((failure as Error).message).not.toContain('相同请求重试');
  });

  it('admits an explicit directory as before and allocates no stable one for it', async () => {
    const dir = join(paths.projectsRootDir, 'explicit');
    await mkdir(dir, { recursive: true });
    const before = await allocations();
    const project = await createProject({ rawClient: fakeLark().client }, input('Explicit', { existingPath: dir, backend: 'claude-agent' }));
    expect(project).toMatchObject({ cwd: await realpath(dir), blank: false, directories: { workspaces: { primary: await realpath(dir), additional: [] } }, backend: 'claude-agent', origin: 'created' });
    expect(await allocations()).toEqual(before);
    await expect(createProject({ rawClient: fakeLark().client }, input('Protected', { existingPath: paths.appDir }))).rejects.toThrow('directories.workspaces.primary');
  });
});
