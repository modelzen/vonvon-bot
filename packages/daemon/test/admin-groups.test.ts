import { createPendingGroups, pendingGroupsFile, readPendingGroups } from '../src/project/pending-groups';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGroupExecutor as createOwnedGroupExecutor, describeGroupFailure, parseBindGroupInput, parseJoinedGroups, parseGroupMembers, UNNAMED_GROUP, type BindGroupInput } from '../src/admin/groups';
import { log } from '../src/core/logger';
import { createAdminIpcCaller, createAdminIpcResponder } from '../src/admin/ipc';
import { addProject, listProjects, listProjectsIn } from '../src/project/registry';
import { createProject, joinExistingGroup as joinOwnedGroup, type JoinGroupInput } from '../src/project/lifecycle';
import type { RegistryLocation } from '../src/project/registry';
import { paths } from '../src/config/paths';
import { fakeLark } from './helpers/fake-lark-http';
import { effectiveDefaultBackend } from '../src/agent';
import type { ModelInfo } from '../src/agent/types';

const provider = vi.hoisted(() => ({ models: [{ id: 'fixture-model', displayName: 'Fixture', description: '', isDefault: true, hidden: false, supportedEfforts: ['medium'], defaultEffort: 'medium' }] as ModelInfo[] }));
// Binding exercises the real model admission using a test Provider, independent of a host Codex install.
vi.mock('../src/agent', async original => ({
  ...await original<object>(),
  createBackend: (id: string) => ({ id, listModels: async () => provider.models, peekModels: () => provider.models,
    doctor: async () => ({ ok: true, version: 'fixture' }), loginStatus: async () => ({ state: 'signedIn' }) }),
  effectiveDefaultBackend: async () => 'codex-appserver',
}));

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'groups-fixture-')));
  return { paths: { appDir: root, botsFile: join(root, 'bots.json'), projectsFile: join(root, 'projects.json'), projectsRootDir: join(root, 'projects'), backendsDir: join(root, 'backends') },
    botPaths: () => ({ projectsFile: join(root, 'projects.json'), configFile: join(root, 'config.json') }) };
});
const bot = { appId: 'cli_fixture', tenant: 'feishu' as const, name: 'fixture', createdAt: 1, registrationId: 'original' };
beforeAll(() => writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [bot] })));
const createGroupExecutor = (channel: LarkChannel, welcomeCard?: Parameters<typeof createOwnedGroupExecutor>[3]) => createOwnedGroupExecutor(channel, bot, undefined, welcomeCard);
const joinExistingGroup = (channel: LarkChannel, request: Omit<JoinGroupInput, 'bot'>, target?: RegistryLocation) => joinOwnedGroup(channel, { ...request, bot }, target);
afterAll(async () => { await rm(paths.appDir, { recursive: true, force: true }); });

async function workspace(): Promise<string> {
  await mkdir(paths.projectsRootDir, { recursive: true });
  return mkdtemp(join(paths.projectsRootDir, 'workspace-'));
}

function channelFixture() {
  const message = vi.fn(async () => ({ code: 0, data: { message_id: 'message' } }));
  const membership = vi.fn(async () => ({ code: 0, data: { is_in_chat: true } }));
  const list = vi.fn(async () => ({ code: 0, data: { items: [{ chat_id: 'oc_a', name: 'Group A' }], has_more: true, page_token: 'page2' } }));
  const members = vi.fn(async () => ({ code: 0, data: { items: [{ member_id: 'ou_person', name: 'Person' }], has_more: true, page_token: 'members2' } }));
  const create = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_created' } }));
  const managers = vi.fn(async () => ({ code: 0 }));
  const channel = { rawClient: { im: { v1: { message: { create: message }, chatMembers: { isInChat: membership, get: members }, chat: { list, create }, chatManagers: { addManagers: managers } } } } } as unknown as LarkChannel;
  return { channel, message, membership, members, list, create, managers };
}
/** A thrown SDK (axios) error carrying the Feishu body in `response.data`. */
function axiosError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}
const input = (directory: string): BindGroupInput => ({ chatId: 'oc_a', projectName: 'First', directory, backend: 'codex-appserver', kind: 'multi' });

describe('desktop group commands in the owning bot', () => {
  it('binds a default empty workspace and keeps pending state for stale or non-member requests', async () => {
    const fixture = channelFixture();
    const execute = createGroupExecutor(fixture.channel);
    const request = { chatId: 'oc_default_web', projectName: 'Default web', backend: 'codex-appserver', kind: 'multi' } satisfies BindGroupInput;
    const pendingFile = pendingGroupsFile(paths.projectsFile);
    const queue = createPendingGroups({ file: pendingFile, eligible: async () => true, verify: async () => ({ state: 'ready', name: request.projectName, topic: false }), onError: error => { throw error; } });
    await queue.add(request.chatId, 'ou_owner'); await queue.refresh();
    const projects = await readFile(paths.projectsFile, 'utf8').catch(() => undefined);
    const registry = await readFile(paths.botsFile, 'utf8');
    const stale = createOwnedGroupExecutor(fixture.channel, { ...bot, registrationId: 'stale' });
    await expect(stale({ kind: 'bindGroup', input: request })).rejects.toThrow('重新注册');
    expect(await readPendingGroups(pendingFile)).toHaveLength(1);
    expect(await readFile(paths.projectsFile, 'utf8').catch(() => undefined)).toBe(projects);
    expect(await readFile(paths.botsFile, 'utf8')).toBe(registry);
    fixture.membership.mockResolvedValueOnce({ code: 0, data: { is_in_chat: false } });
    await expect(execute({ kind: 'bindGroup', input: request })).rejects.toThrow('不在此群');
    expect(await readPendingGroups(pendingFile)).toHaveLength(1);
    const result = await execute({ kind: 'bindGroup', input: request });
    expect(result).toMatchObject({ cwd: join(paths.projectsRootDir, 'fixture/groups/Default web'), blank: true, directories: { workspaces: { primary: join(paths.projectsRootDir, 'fixture/groups/Default web'), additional: [] } } });
    expect(await readPendingGroups(pendingFile)).toEqual([]);
    expect(await execute({ kind: 'bindGroup', input: request })).toEqual(result);
    expect(fixture.message).toHaveBeenCalledTimes(1);
    await import('../src/project/registry').then(m => m.removeProject(request.projectName));
  });

  it('commits once through IPC, sends one welcome, and retries identical bindings', async () => {
    const dir = await workspace();
    const fixture = channelFixture();
    let copy = {title: '旧标题', intro: '旧欢迎语'};
    const execute = createGroupExecutor(fixture.channel, () => copy);
    copy = {title: '研发项目群指南', intro: '欢迎加入 **研发项目群**。'};
    let receive = (_raw: unknown): void => {};
    const respond = createAdminIpcResponder(async op => {
      if (op.kind !== 'bindGroup' && op.kind !== 'joinedGroups') throw new Error('wrong op');
      return execute(op);
    }, message => receive(message));
    const caller = createAdminIpcCaller(respond);
    receive = caller.onMessage;
    const results = await Promise.all(Array.from({ length: 8 }, () => caller.call({ kind: 'bindGroup', input: input(dir) })));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(fixture.message).toHaveBeenCalledTimes(1);
    const welcome = JSON.stringify(fixture.message.mock.calls[0]);
    expect(welcome).toContain(copy.title);
    expect(welcome).toContain(copy.intro);
    expect(await listProjects()).toHaveLength(1);
    const saved = JSON.parse(await readFile(paths.projectsFile, 'utf8'));
    expect(saved.projects[0]).toMatchObject({ cwd: await realpath(dir), chatId: 'oc_a', mode: 'qa', origin: 'joined' });
    expect(saved.projects[0]).not.toHaveProperty('addedBy');
    expect(saved.projects[0]).toMatchObject({ kind: 'multi', noMention: true });
    await expect(caller.call({ kind: 'bindGroup', input: { ...input(dir), kind: 'single' } })).rejects.toThrow('不可修改');
    await expect(caller.call({ kind: 'bindGroup', input: { ...input(await workspace()), chatId: 'oc_other' } })).rejects.toThrow('项目名');
    const sharedDir = await caller.call({ kind: 'bindGroup', input: { ...input(dir), chatId: 'oc_shared_dir', projectName: 'Shared Dir' } });
    expect(sharedDir).toMatchObject({ cwd: await realpath(dir), chatId: 'oc_shared_dir', name: 'Shared Dir' });
    expect((sharedDir as { projectId?: string }).projectId).not.toBe(saved.projects[0].projectId);
    await import('../src/project/registry').then(m => m.removeProject('Shared Dir'));
    const page = await caller.call({ kind: 'joinedGroups', cursor: 'cursor1' });
    expect(page).toEqual({ groups: [{ chatId: 'oc_a', name: 'Group A', bound: true }], nextCursor: 'page2' });
    expect(fixture.list).toHaveBeenCalledWith({ params: { page_size: 50, page_token: 'cursor1' } });
  });

  it('s21: a bind writes 免@ from the pick, else 单会话 off, and checks its type', async () => {
    const dir = await workspace();
    const execute = createGroupExecutor(channelFixture().channel);
    expect(await execute({ kind: 'bindGroup', input: { ...input(dir), chatId: 'oc_s21a', projectName: 'S21 A', kind: 'single' } })).toMatchObject({ kind: 'single', noMention: false });
    expect(await execute({ kind: 'bindGroup', input: { ...input(await workspace()), chatId: 'oc_s21b', projectName: 'S21 B', kind: 'single', noMention: true } })).toMatchObject({ kind: 'single', noMention: true });
    // Binding the same group again with another 免@ is not a silent success.
    await expect(execute({ kind: 'bindGroup', input: { ...input(dir), chatId: 'oc_s21a', projectName: 'S21 A', kind: 'single', noMention: true } })).rejects.toThrow('免 @ 请在群设置里改');
    expect(await execute({ kind: 'bindGroup', input: { ...input(dir), chatId: 'oc_s21a', projectName: 'S21 A', kind: 'single', noMention: false } })).toMatchObject({ noMention: false });
    expect(parseBindGroupInput({ ...input(dir), noMention: false })).toMatchObject({ noMention: false });
    expect(() => parseBindGroupInput({ ...input(dir), noMention: 'off' })).toThrow('群绑定参数无效');
    expect(() => parseBindGroupInput({ ...input(dir), kind: 'later' })).toThrow('群绑定参数无效');
  });

  it('s25c: binds 智能 as 单会话 plus smart with 免@ off, says so in the one welcome card, and refuses a 免@ with it', async () => {
    const dir = await workspace();
    const fixture = channelFixture();
    const execute = createGroupExecutor(fixture.channel);
    const judge = {kind:'llm' as const,backend:'codex-appserver' as const,model:'fixture-judge',custom:true};
    expect(parseBindGroupInput({ ...input(dir), kind: 'smart' })).toMatchObject({kind: 'smart'});
    expect(parseBindGroupInput({ ...input(dir), kind: 'smart' })).not.toHaveProperty('judge');
    expect(parseBindGroupInput({ ...input(dir), kind: 'smart', judge })).toMatchObject({ kind: 'smart', judge });
    for (const noMention of [true, false]) expect(() => parseBindGroupInput({ ...input(dir), kind: 'smart', judge, noMention })).toThrow('没有免 @');
    const smart = { ...input(dir), chatId: 'oc_s25c', projectName: 'S25c', kind: 'smart' as const, judge };
    const bound = await execute({ kind: 'bindGroup', input: smart });
    expect(bound).toMatchObject({ kind: 'single', smart: true, noMention: false });
    expect(fixture.message).toHaveBeenCalledTimes(1);
    const welcome = JSON.stringify(fixture.message.mock.calls[0]);
    expect(welcome).toContain('智能开话题');
    expect(welcome).toContain('我会读群消息，合适时接话。');
    expect(welcome).not.toContain('可开启免@');
    // The same bind again is a retry: no second welcome.
    expect(await execute({ kind: 'bindGroup', input: smart })).toEqual(bound);
    expect(fixture.message).toHaveBeenCalledTimes(1);
    await expect(execute({ kind: 'bindGroup', input: { ...smart, kind: 'single' } })).rejects.toThrow('不可修改');
    // A 免@ reaching the entry with 智能 (a DM card's shared form) is dropped, never stored on.
    const picked = await joinExistingGroup(fixture.channel, { name: 'S25c picked', chatId: 'oc_s25c_picked', existingPath: await workspace(), kind: 'smart', judge, noMention: true });
    expect(picked).toMatchObject({ kind: 'single', smart: true, noMention: false });
  });

  it('refuses invalid directories and non-members without welcome or persistence', async () => {
    const fixture = channelFixture();
    const execute = createGroupExecutor(fixture.channel);
    const file = join(paths.appDir, 'plain-file');
    await writeFile(file, 'x');
    await expect(execute({ kind: 'bindGroup', input: input(file) })).rejects.toThrow('不是目录');
    const pendingFile = pendingGroupsFile(paths.projectsFile);
    const queue = createPendingGroups({ file: pendingFile, eligible: async () => true, verify: async () => ({ state: 'ready', name: 'Unbound', topic: false }), onError: error => { throw error; } });
    await queue.add('oc_a', 'ou_admin');
    fixture.membership.mockResolvedValue({ code: 0, data: { is_in_chat: false } });
    await expect(execute({ kind: 'bindGroup', input: input(await workspace()) })).rejects.toThrow('不在此群');
    expect(fixture.message).not.toHaveBeenCalled();
    expect(await readPendingGroups(pendingFile)).toHaveLength(1);
    await queue.remove('oc_a');
    fixture.membership.mockRejectedValue(new Error('upstream unavailable'));
    await expect(execute({ kind: 'bindGroup', input: input(await workspace()) })).rejects.toMatchObject({ code: 'GROUP_UPSTREAM' });
  });

  it('keeps a committed binding when welcome fails and preserves actual DM operator', async () => {
    const fixture = channelFixture();
    fixture.message.mockRejectedValue(new Error('welcome unavailable'));
    const execute = createGroupExecutor(fixture.channel);
    const dir = await workspace();
    const value = { ...input(dir), projectName: 'Second', chatId: 'oc_second' };
    await execute({ kind: 'bindGroup', input: value });
    await execute({ kind: 'bindGroup', input: value });
    expect(fixture.message).toHaveBeenCalledTimes(1);
    const queue = createPendingGroups({ file: pendingGroupsFile(paths.projectsFile), eligible: async () => true, verify: async () => ({ state: 'ready', name: 'DM', topic: false }), onError: error => { throw error; } });
    await queue.add('oc_dm', 'ou_actual_sender');
    await queue.refresh();
    const dmDir = await workspace();
    const dm = await joinExistingGroup(fixture.channel, { name: 'DM', chatId: 'oc_dm', existingPath: dmDir, addedBy: 'ou_actual_sender', kind: 'multi' });
    expect(dm.addedBy).toBe('ou_actual_sender');
    expect(dm.noMention).toBe(true); // 3.4: 多会话 defaults 免@ on, written down at bind
    expect(await readPendingGroups(pendingGroupsFile(paths.projectsFile))).toEqual([]);
    const retried = await execute({ kind: 'bindGroup', input: { ...input(dmDir), projectName: 'DM', chatId: 'oc_dm' } });
    expect(retried).toEqual(dm);
    expect(fixture.message).toHaveBeenCalledTimes(2);
  });

  it('keeps successful DM and desktop bindings when pending cleanup cannot read its file', async () => {
    const dir = await workspace();
    const pendingFile = pendingGroupsFile(paths.projectsFile);
    await writeFile(pendingFile, '{');
    const fixture = channelFixture();
    try {
      const dm = await joinExistingGroup(fixture.channel, { name: 'Corrupt queue DM', chatId: 'oc_corrupt_dm', existingPath: dir, addedBy: 'ou_admin', kind: 'multi' });
      expect(dm.chatId).toBe('oc_corrupt_dm');
      expect((await listProjects()).find(project => project.chatId === dm.chatId)).toEqual(dm);
      const execute = createGroupExecutor(fixture.channel);
      const value = { ...input(await workspace()), projectName: 'Corrupt queue desktop', chatId: 'oc_corrupt_desktop' };
      const desktop = await execute({ kind: 'bindGroup', input: value });
      expect(desktop).toMatchObject({ chatId: value.chatId });
      expect(await execute({ kind: 'bindGroup', input: value })).toEqual(desktop);
      expect(fixture.message).toHaveBeenCalledTimes(2);
      expect(await readFile(pendingFile, 'utf8')).toBe('{');
    } finally { await rm(pendingFile); }
  });

  it('returns the same binding through DM retries and the desktop', async () => {
    const dir = join(paths.projectsRootDir, 'dm-retry');
    await mkdir(dir, { recursive: true });
    const fixture = channelFixture();
    const value = { name: 'DM retry', chatId: 'oc_dm_retry', existingPath: dir, backend: 'codex-appserver', kind: 'multi' as const, addedBy: 'ou_first' };
    const first = await joinExistingGroup(fixture.channel, value);
    const bytes = await readFile(paths.projectsFile, 'utf8');
    expect(await joinExistingGroup(fixture.channel, { ...value, addedBy: 'ou_later' })).toEqual(first);
    expect(await createGroupExecutor(fixture.channel)({ kind: 'bindGroup', input: { ...input(dir), projectName: value.name, chatId: value.chatId } })).toEqual(first);
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(bytes);
    expect(fixture.message).toHaveBeenCalledTimes(1);
  });

  it.each([['qa', false], ['write', true], ['full', true]] as const)('joining an existing group writes %s with network %s', async (mode, network) => {
    const fixture = channelFixture();
    const project = await joinExistingGroup(fixture.channel, { name: `Tier ${mode}`, chatId: `oc_tier_${mode}`, existingPath: await workspace(), kind: 'multi', mode });
    expect(project).toMatchObject({ mode, network });
    expect((await listProjects()).find(row => row.chatId === project.chatId)).toMatchObject({ mode, network });
  });

  it('rejects protected explicit workspaces before binding or creating a group', async () => {
    const fixture = channelFixture();
    const value = { name: 'Protected', existingPath: paths.appDir, kind: 'multi' as const };
    // s36c2d (review R5-2): said in Chinese, without the path or the internal field name.
    const refused = (error: unknown) => error instanceof Error && error.message.includes('不能当工作目录') && !error.message.includes(paths.appDir) && !error.message.includes('directories.');
    await expect(joinExistingGroup(fixture.channel, { ...value, chatId: 'oc_protected' }).catch(refused)).resolves.toBe(true);
    await expect(createGroupExecutor(fixture.channel)({ kind: 'bindGroup', input: { ...input(paths.appDir), projectName: value.name, chatId: 'oc_protected_web' } }).catch(refused)).resolves.toBe(true);
    await expect(createProject(fixture.channel, { ...value, invitee: { idType: 'open_id', id: 'ou_owner' }, requestId: 'protected-request', bot }).catch(refused)).resolves.toBe(true);
    expect(fixture.message).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect((await listProjects()).some(project => project.name === value.name)).toBe(false);
  });

  it('commits one canonical binding and welcome across eight mixed DM and web callers', async () => {
    const dir = await workspace();
    const alias = `${dir}-alias`;
    await symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const fixture = channelFixture();
    const value = { ...input(alias), projectName: 'Mixed bind', chatId: 'oc_mixed' };
    const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2
      ? createGroupExecutor(fixture.channel)({ kind: 'bindGroup', input: value })
      : joinExistingGroup(fixture.channel, { name: value.projectName, chatId: value.chatId, existingPath: dir, kind: value.kind, backend: value.backend })));
    expect(replies.every(reply => JSON.stringify(reply) === JSON.stringify(replies[0]))).toBe(true);
    expect(replies[0]).toMatchObject({ cwd: await realpath(dir), blank: false, directories: { workspaces: { primary: await realpath(dir), additional: [] } } });
    expect(replies[0]).not.toHaveProperty('directories.repositories');
    expect((await listProjects()).filter(project => project.chatId === value.chatId)).toHaveLength(1);
    expect(fixture.message).toHaveBeenCalledTimes(1);
    expect(fixture.membership).toHaveBeenCalledTimes(4);
  });

  it('rejects every binding identity conflict while retaining mutable settings and operator', async () => {
    const fixture = channelFixture();
    const dir = await workspace();
    const value = { name: 'Conflicts', chatId: 'oc_conflicts', existingPath: dir, kind: 'multi' as const, backend: 'codex-appserver', addedBy: 'ou_original' };
    const first = await joinExistingGroup(fixture.channel, value);
    const bytes = await readFile(paths.projectsFile, 'utf8');
    for (const patch of [{ name: 'Different' }, { existingPath: await workspace() }, { backend: 'claude-agent' }, { kind: 'single' as const }, { noMention: false }]) {
      await expect(joinExistingGroup(fixture.channel, { ...value, ...patch })).rejects.toThrow('不可修改');
    }
    await expect(joinExistingGroup(fixture.channel, { ...value, chatId: 'oc_name_conflict', existingPath: await workspace() })).rejects.toThrow('项目名');
    expect(await joinExistingGroup(fixture.channel, { ...value, name: ' Conflicts ', mode: 'full', addedBy: 'ou_changed', noMention: true })).toEqual(first);
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(bytes);
    expect(fixture.message).toHaveBeenCalledTimes(1);
  });

  it('returns legacy protected bindings unchanged, even with an unavailable backend', async () => {
    const fixture = channelFixture();
    const legacy = { name: 'Legacy retry', chatId: 'oc_legacy_retry', cwd: paths.appDir, blank: false, createdAt: 1,
      kind: 'single' as const, backend: 'claude-agent' as const, origin: 'joined' as const, addedBy: 'ou_legacy',
      mode: 'full' as const, network: true, enabled: false, future: { keep: true } };
    await addProject(legacy);
    const bytes = await readFile(paths.projectsFile, 'utf8');
    const value = { name: legacy.name, chatId: legacy.chatId, existingPath: paths.appDir, kind: legacy.kind, backend: legacy.backend, noMention: false };
    expect(await joinExistingGroup(fixture.channel, value)).toEqual(legacy);
    const execute = createGroupExecutor(fixture.channel);
    const web = { ...input(paths.appDir), projectName: legacy.name, chatId: legacy.chatId, backend: legacy.backend, kind: legacy.kind };
    expect(await execute({ kind: 'bindGroup', input: web })).toEqual(legacy);
    fixture.membership.mockResolvedValueOnce({ code: 0, data: { is_in_chat: false } });
    await expect(execute({ kind: 'bindGroup', input: web })).rejects.toThrow('不在此群');
    fixture.membership.mockRejectedValueOnce(new Error('offline'));
    await expect(execute({ kind: 'bindGroup', input: web })).rejects.toMatchObject({ code: 'GROUP_UPSTREAM' });
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(bytes);
    expect(fixture.message).not.toHaveBeenCalled();
    const smartLegacy = { ...legacy, name: 'Smart legacy', chatId: 'oc_smart_legacy', smart: true };
    await addProject(smartLegacy);
    // A hand-written 智能 row binds again as 智能 (s25c); 单会话 is another 会话方式.
    expect(await joinExistingGroup(fixture.channel, { ...value, name: 'Smart legacy', chatId: 'oc_smart_legacy', kind: 'smart' })).toEqual(smartLegacy);
    await expect(joinExistingGroup(fixture.channel, { ...value, name: 'Smart legacy', chatId: 'oc_smart_legacy' })).rejects.toThrow('不可修改');
    expect(fixture.message).not.toHaveBeenCalled();
  });

  it('retries default-directory bindings without recreating their directory', async () => {
    const fixture = channelFixture();
    const value = { name: 'Default retry', chatId: 'oc_default_retry', kind: 'multi' as const };
    const first = await joinExistingGroup(fixture.channel, value);
    expect(first.cwd).toBe(join(paths.projectsRootDir, bot.name, 'groups', value.name));
    expect(first.directories?.workspaces).toEqual({ primary: first.cwd, additional: [] });
    await rm(first.cwd, { recursive: true });
    const bytes = await readFile(paths.projectsFile, 'utf8');
    expect(await joinExistingGroup(fixture.channel, value)).toEqual(first);
    await expect(stat(first.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(bytes);
    expect(fixture.message).toHaveBeenCalledTimes(1);
  });

  it('allocates a stable empty group workspace below the bot namespace', async () => {
    const fixture = channelFixture();
    const row = await joinExistingGroup(fixture.channel, { name: 'Allocated group', chatId: 'oc_allocated', kind: 'multi' });
    expect(row.cwd).toBe(join(paths.projectsRootDir, bot.name, 'groups', 'Allocated group'));
    expect(row.directories?.workspaces).toEqual({ primary: row.cwd, additional: [] });
    expect(JSON.parse(await readFile(paths.botsFile, 'utf8')).groupAllocations).toBeDefined();
  });

  it.each(['join', 'create'] as const)('captures %s inputs and registry target before asynchronous preparation', async action => {
    const fixture = channelFixture();
    const fake = fakeLark();
    const dir = await workspace();
    const target = { file: paths.projectsFile, dataRoot: paths.appDir };
    const value = { name: `Captured ${action}`, chatId: `oc_captured_${action}`, invitee: { idType: 'open_id' as const, id: 'ou_owner' }, requestId: 'original-request', requestSignature: 'original-signature', existingPath: dir, kind: 'multi' as const, backend: 'codex-appserver', bot: { ...bot } };
    const pending = action === 'join' ? joinOwnedGroup(fixture.channel, value, target) : createProject({ rawClient: fake.client }, value, target);
    value.name = 'mutated'; value.existingPath = paths.appDir; value.backend = 'unavailable'; value.invitee.id = 'ou_changed'; value.requestId = 'changed-request'; value.requestSignature = 'changed-signature'; value.bot.registrationId = 'changed';
    target.file = join(paths.appDir, `wrong-${action}`, 'projects.json'); target.dataRoot = dir;
    const result = await pending;
    expect(result).toMatchObject({ name: `Captured ${action}`, cwd: await realpath(dir), backend: 'codex-appserver' });
    expect((await listProjectsIn(paths.projectsFile)).find(row => row.chatId === result.chatId)).toMatchObject(result);
    await expect(readFile(target.file)).rejects.toMatchObject({ code: 'ENOENT' });
    if (action === 'create') {
      expect(result.creationRequestSignature).toBe('original-signature');
      expect(fake.creates()).toMatchObject([{ params: { user_id_type: 'open_id', uuid: 'original-request' }, data: { name: 'Captured create', user_id_list: ['ou_owner'] } }]);
    }
  });

  it('captures web input and owning bot before its membership request returns', async () => {
    const fixture = channelFixture();
    const originalFile = paths.projectsFile;
    const wrongFile = join(paths.appDir, 'other-bot', 'projects.json');
    const value = { ...input(await workspace()), projectName: 'Captured web', chatId: 'oc_captured_web' };
    const pending = createGroupExecutor(fixture.channel)({ kind: 'bindGroup', input: value });
    value.projectName = 'mutated'; value.chatId = 'oc_mutated'; value.directory = paths.appDir;
    Object.assign(paths, { projectsFile: wrongFile });
    try {
      expect(await pending).toMatchObject({ name: 'Captured web', chatId: 'oc_captured_web' });
      expect((await listProjectsIn(originalFile)).some(project => project.chatId === 'oc_captured_web')).toBe(true);
      await expect(readFile(wrongFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { Object.assign(paths, { projectsFile: originalFile }); }
  });

  it.each(['internal', 'file', 'missing'] as const)('rejects %s explicit paths in both binding entries and before remote creation', async kind => {
    const dir = join(paths.appDir, kind === 'internal' ? 'bots' : `invalid-${kind}`);
    if (kind === 'internal') await mkdir(dir, { recursive: true });
    if (kind === 'file') await writeFile(dir, 'file');
    const fixture = channelFixture();
    const bytes = await readFile(paths.projectsFile, 'utf8');
    const value = { name: `Invalid ${kind}`, existingPath: dir, kind: 'multi' as const };
    await expect(joinExistingGroup(fixture.channel, { ...value, chatId: `oc_invalid_${kind}` })).rejects.toThrow();
    await expect(createGroupExecutor(fixture.channel)({ kind: 'bindGroup', input: { ...input(dir), projectName: value.name, chatId: `oc_invalid_web_${kind}` } })).rejects.toThrow();
    await expect(createProject(fixture.channel, { ...value, invitee: { idType: 'open_id', id: 'ou_owner' }, requestId: `invalid-${kind}`, bot })).rejects.toThrow(kind === 'internal' ? '不能当工作目录' : '不存在或不是目录');
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(bytes);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.managers).not.toHaveBeenCalled();
    expect(fixture.message).not.toHaveBeenCalled();
  });

  it('s36d1: binds a group the bot itself owns as joined and read-only, without asking Feishu who owns it', async () => {
    // Feishu leaves owner_id out when a bot owns the group (2026-10-18), the same as for another app's bot's group.
    const fixture = channelFixture();
    const chatInfo = vi.fn(async (chatId: string) => ({ chatId, chatType: 'group' as const }));
    const channel = Object.assign(fixture.channel, { botIdentity: { openId: 'ou_bot', name: 'Bot' }, getChatInfo: chatInfo });
    const unsaved = await createGroupExecutor(channel)({ kind: 'bindGroup', input: { chatId: 'oc_bot_owned', projectName: 'Bot owned', backend: 'codex-appserver', kind: 'multi' } });
    expect(unsaved).toMatchObject({ origin: 'joined', mode: 'qa', network: false });
    // A bind with no backend picked writes the one it runs on, so it never follows a later default.
    expect(await joinExistingGroup(channel, { name: 'Not owned', chatId: 'oc_not_owned', kind: 'multi', addedBy: 'ou_admin' })).toMatchObject({ origin: 'joined', mode: 'qa', addedBy: 'ou_admin',
      backend: await effectiveDefaultBackend() });
    expect(chatInfo).not.toHaveBeenCalled();
  });

  it('registry rejects duplicate races while preserving unrelated existing projects', async () => {
    const values = await Promise.allSettled(['A', 'B'].map(name => addProject({ name, chatId: 'oc_race', cwd: paths.appDir, blank: false, createdAt: 1 })));
    expect(values.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect((await listProjects()).filter(project => project.chatId === 'oc_race')).toHaveLength(1);
    expect((await listProjects()).find(project => project.chatId === 'oc_dm')?.addedBy).toBe('ou_actual_sender');
    const invalid = join(paths.appDir, 'invalid.json');
    await writeFile(invalid, '{}');
    await expect(listProjectsIn(invalid)).rejects.toThrow('格式无效');
  });

  it('turns Feishu failures into readable text and logs the raw error with its phase', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    try {
      const fixture = channelFixture();
      const execute = createGroupExecutor(fixture.channel);
      const denied = axiosError(400, { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:chat, im:chat:readonly]' });
      fixture.list.mockRejectedValueOnce(denied);
      const missing = '缺少飞书权限 im:chat:readonly（读取群信息）。在 Bot 设置点「一键开权限」，再到开发者后台创建版本并发布。';
      await expect(execute({ kind: 'joinedGroups' })).rejects.toMatchObject({ code: 'GROUP_UPSTREAM', message: missing });
      expect(fail).toHaveBeenLastCalledWith('groups', denied, { phase: 'joined-groups' });
      fixture.list.mockResolvedValueOnce({ code: 99991672, msg: 'scopes is required: [im:chat:readonly]' } as never);
      await expect(execute({ kind: 'joinedGroups' })).rejects.toThrow(missing);
      expect(fail).toHaveBeenLastCalledWith('groups', expect.objectContaining({ message: missing }), { phase: 'joined-groups', code: 99991672, msg: 'scopes is required: [im:chat:readonly]' });
      const notMember = axiosError(400, { code: 232011, msg: 'operator is not in the chat' });
      fixture.membership.mockRejectedValueOnce(notMember);
      await expect(execute({ kind: 'bindGroup', input: input(await workspace()) })).rejects.toThrow('飞书接口出错 code=232011：operator is not in the chat');
      expect(fail).toHaveBeenLastCalledWith('groups', notMember, { phase: 'bind-group' });
      fixture.membership.mockResolvedValueOnce({ code: 0, data: {} } as never);
      await expect(execute({ kind: 'bindGroup', input: input(await workspace()) })).rejects.toThrow('无法确认机器人群成员身份');
      expect(fail).toHaveBeenLastCalledWith('groups', expect.any(Error), { phase: 'bind-group' });
    } finally { fail.mockRestore(); }
  });

  it('names the scopes Feishu accepts when the granted one would not do, and keeps plain errors readable', () => {
    expect(describeGroupFailure(axiosError(400, { code: 99991672, msg: 'required: [im:chat:read, im:chat]' })))
      .toBe('缺少飞书权限 im:chat:read 或 im:chat（读取群信息）。到开发者后台开通其中一项，再创建版本并发布。');
    expect(describeGroupFailure(axiosError(400, { code: 99991672, msg: 'Access denied.' }))).toContain('im:chat:readonly（读取群信息）');
    expect(describeGroupFailure({ code: 99991663, msg: '' })).toBe('飞书接口出错 code=99991663：没有说明');
    expect(describeGroupFailure(axiosError(502, '<html>bad gateway</html>'))).toBe('飞书群接口调用失败：Request failed with status code 502');
  });

  it('lists a chat without a name instead of failing the whole page, and skips one without an id', async () => {
    const fixture = channelFixture();
    fixture.list.mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: 'oc_named', name: 'Named' }, { chat_id: 'oc_blank', name: ' ' }, { chat_id: 'oc_none' }, { name: 'No id' }], has_more: false } } as never);
    const page = await createGroupExecutor(fixture.channel)({ kind: 'joinedGroups' });
    expect(page).toEqual({ groups: [
      { chatId: 'oc_named', name: 'Named', bound: false },
      { chatId: 'oc_blank', name: UNNAMED_GROUP, bound: false },
      { chatId: 'oc_none', name: '（未命名群）', bound: false },
    ] });
  });

  it('s36c2d: binds an old group again in the directory it had before it was unbound (review R6-3)', async () => {
    const fixture = channelFixture();
    const { removeProject } = await import('../src/project/registry');
    const legacy = join(paths.projectsRootDir, 'Legacy group');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'notes.md'), 'keep');
    await addProject({ name: 'Legacy group', chatId: 'oc_legacy_group', cwd: legacy, blank: true, createdAt: 1 });
    const request = { name: 'Legacy group', chatId: 'oc_legacy_group', kind: 'multi' as const };
    expect(await joinExistingGroup(fixture.channel, request)).toMatchObject({ cwd: legacy, createdAt: 1 });
    await removeProject('Legacy group');
    // Before s36c2d: a new empty projects/fixture/groups/Legacy group, the notes left behind in the old one.
    const again = await joinExistingGroup(fixture.channel, request);
    expect(again).toMatchObject({ cwd: legacy, blank: true, origin: 'joined' });
    expect(again).not.toHaveProperty('directories');
    expect(await readFile(join(again.cwd, 'notes.md'), 'utf8')).toBe('keep');
    expect(await joinExistingGroup(fixture.channel, request)).toEqual(again);
    expect(fixture.message).toHaveBeenCalledTimes(1);
    await removeProject('Legacy group');
    expect(await joinExistingGroup(fixture.channel, { ...request, name: 'Renamed legacy' })).toMatchObject({ cwd: legacy });
    await removeProject('Renamed legacy');
  });

  it('s36c2d: does not go back to an old directory that is now refused or in the wrong place', async () => {
    const fixture = channelFixture();
    const { removeProject } = await import('../src/project/registry');
    // The bot's own directory is a workspace admission lets through; the bot has one after the first default binding.
    for (const [chatId, cwd] of [['oc_legacy_data', paths.appDir], ['oc_legacy_root', paths.projectsRootDir], ['oc_legacy_bot', join(paths.projectsRootDir, 'fixture')]] as const) {
      await addProject({ name: chatId, chatId, cwd, blank: true, createdAt: 1 });
      await removeProject(chatId);
      const bound = await joinExistingGroup(fixture.channel, { name: chatId, chatId, kind: 'multi' });
      expect(bound.cwd).toBe(join(paths.projectsRootDir, 'fixture/groups', chatId));
      await removeProject(chatId);
    }
  });

  it('parses the exact supported binding shape', () => {
    expect(parseBindGroupInput({ ...input(paths.appDir), projectName: ' Trim ' }).projectName).toBe('Trim');
    for (const patch of [{ backend: 'unknown' }, { directory: 'relative' }, { kind: 'new' }, { chatId: '../escape' }, { extra: true }]) expect(() => parseBindGroupInput({ ...input(paths.appDir), ...patch })).toThrow();
  });

  it('refuses a Provider with no models before creating or persisting a binding', async () => {
    const fixture = channelFixture();
    const models = provider.models;
    const projects = await readFile(paths.projectsFile, 'utf8');
    const bots = await readFile(paths.botsFile, 'utf8');
    const directory = await workspace();
    provider.models = [];
    try {
      await expect(createGroupExecutor(fixture.channel)({ kind: 'bindGroup', input: { ...input(directory), chatId: 'oc_no_models', projectName: 'No models' } })).rejects.toThrow('未读取到可用模型');
      await expect(createProject(fixture.channel, { name: 'No models', existingPath: directory, kind: 'multi', invitee: { idType: 'open_id', id: 'ou_owner' }, requestId: 'no-models', bot })).rejects.toThrow('未读取到可用模型');
      expect(await readFile(paths.projectsFile, 'utf8')).toBe(projects);
      expect(await readFile(paths.botsFile, 'utf8')).toBe(bots);
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.managers).not.toHaveBeenCalled();
      expect(fixture.message).not.toHaveBeenCalled();
    } finally { provider.models = models; }
  });
});


it('s28c: joined-group hints use observed bot counts and survive the IPC parser', async () => {
  for (const count of ['2', '1', undefined]) {
    const fixture = channelFixture();
    Object.assign(fixture.channel.rawClient.im.v1.chat, {get: async () => ({code: 0, data: {bot_count: count}})});
    const result = await createGroupExecutor(fixture.channel)({kind: 'joinedGroups'});
    expect(parseJoinedGroups(result)).toMatchObject({groups: [{chatId: 'oc_a', ...(count === undefined ? {} : {hasOtherBots: count === '2'})}]});
    if (count === undefined && 'groups' in result) expect(result.groups[0]).not.toHaveProperty('hasOtherBots');
  }
});

it('s28c: pending groups persist and clear an observed other-bot hint', async () => {
  const file = join(paths.appDir, 'pending-hint.json');
  let hasOtherBots: boolean | undefined = true;
  const queue = createPendingGroups({file, eligible: async () => true, verify: async () => ({state: 'ready', name: 'Hint group', topic: false, hasOtherBots}), onError: error => {throw error;}});
  await queue.add('oc_hint', 'ou_owner');
  await queue.refresh();
  expect(await readPendingGroups(file)).toMatchObject([{state: 'ready', hasOtherBots: true}]);
  hasOtherBots = undefined;
  await queue.refresh();
  expect((await readPendingGroups(file))[0]).not.toHaveProperty('hasOtherBots');
});


describe('group member transport', () => {
  it('preserves member ids, names and pagination through IPC', async () => {
    const fixture = channelFixture();
    let receive: (raw: unknown) => void = () => undefined;
    const caller = createAdminIpcCaller(message => receive(message));
    receive = createAdminIpcResponder(op => {
      if (op.kind !== 'groupMembers') throw new Error('unexpected command');
      return createGroupExecutor(fixture.channel)(op);
    }, caller.onMessage);
    expect(parseGroupMembers(await caller.call({ kind: 'groupMembers', chatId: 'oc_a', cursor: 'members1' }))).toEqual({ members: [{ openId: 'ou_person', name: 'Person' }], nextCursor: 'members2' });
    expect(fixture.members).toHaveBeenCalledWith({ path: { chat_id: 'oc_a' }, params: { member_id_type: 'open_id', page_size: 100, page_token: 'members1' } });
  });
  it('refuses reading a group the bot has not joined', async () => {
    const fixture = channelFixture();
    fixture.membership.mockResolvedValue({ code: 0, data: { is_in_chat: false } });
    await expect(createGroupExecutor(fixture.channel)({ kind: 'groupMembers', chatId: 'oc_a' })).rejects.toThrow('机器人不在此群中');
    expect(fixture.members).not.toHaveBeenCalled();
  });
  it('does not turn upstream failure or broken pagination into empty success', async () => {
    const fixture = channelFixture();
    fixture.members.mockResolvedValueOnce({ code: 999, data: { items: [], has_more: false, page_token: '' } });
    await expect(createGroupExecutor(fixture.channel)({ kind: 'groupMembers', chatId: 'oc_a' })).rejects.toThrow('999');
    fixture.members.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: '' } });
    await expect(createGroupExecutor(fixture.channel)({ kind: 'groupMembers', chatId: 'oc_a' })).rejects.toThrow('缺少下一页游标');
    expect(() => parseGroupMembers({ members: [{ name: 'No id' }] })).toThrow('群成员响应无效');
  });
});
