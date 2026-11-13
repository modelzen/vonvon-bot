import { expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, groupIdSchema, membershipIdSchema,
  type Agent, type DesktopSnapshot, type LibraryProject, type Membership, type ProjectRecord,
} from '@vonvon/protocol';
import { rpcErrorKind } from '../src/cli/command-error';
import { runningBot, setCliContext, withDaemon, type Daemon } from '../src/cli/daemon-client';
import { NOT_DM_MESSAGE } from '../src/agent/entry/registry';
import { folderPath, runGroupBind, runGroupCreate, runGroupSet, runGroupShow, runGroupUnbind } from '../src/cli/commands/group';
import { CLI_PARITY_ALLOWLIST } from '../src/cli/parity-allowlist';
import {runFeishuGroupIdentity} from '../src/cli/commands/feishu';
import { loadCommands } from './helpers/cli-commands';

/** cli-3-groups: group create / show / set / unbind and the changed group bind, through a fake client behind the real withDaemon. */
const agent = (id: string, name = 'Vonvon Bot', extra: Partial<Agent> = {}): Agent => ({ id: agentIdSchema.parse(id), name, enabled: true, running: true, connection: 'connected', activation: 'active', ...extra });
const member = (agentId: string, groupId: string, name: string, extra: Partial<Membership> = {}): Membership => ({
  id: membershipIdSchema.parse(JSON.stringify([agentId, groupId])), agentId: agentIdSchema.parse(agentId), groupId: groupIdSchema.parse(groupId), name, directory: `/work/${name}`,
  backend: 'codex-appserver', conversation: 'threads', response: 'all', permission: { administrator: 'qa', member: 'qa', network: false }, stale: false, ...extra,
});
const snapshot = (agents: Agent[], memberships: Membership[] = []): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents, groups: [{ id: groupIdSchema.parse('oc_dev'), name: '研发群' }], memberships, tools: [], jobs: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
const record = (extra: Partial<ProjectRecord> = {}): ProjectRecord => ({ name: '研发', chatId: groupIdSchema.parse('oc_dev'), cwd: '/work/研发', kind: 'multi', backend: 'codex-appserver', enabled: true, revision: 'r1', ...extra });
const library = (extra: Partial<LibraryProject> = {}): LibraryProject => ({
  id: 'prj_0000000a' as LibraryProject['id'], name: '官网', revision: 3, workspace: { primary: '/work/site', additional: [] }, bindings: [], ...extra,
});
const token = '7d1f1a6e-3b8e-4d0c-9a51-2f6a0e4b9c11';
const host = { cwd: '/here', home: '/home/u', platform: 'linux' as const };
const WARNING = '完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。';

type Fake = Partial<Record<'snapshot' | 'run' | 'collaboration' | 'directory' | 'library' | 'settings' | 'admin', (request: never) => unknown>>;
function harness(client: Fake) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({
    close, snapshot: async () => snapshot([agent('cli_a')], [member('cli_a', 'oc_dev', '研发')]),
    settings: async () => ({ kind: 'view', view: { scope: { kind: 'project', botId: 'cli_a', projectName: '研发' }, sections: {}, identity: {} } }),
    library: async () => ({ kind: 'list', projects: [library()], unlinked: 0 }),
    ...client,
  }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, connect, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const failure = (kind: string, extra: object = {}) => expect.objectContaining({ kind, ...extra });
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string; partial?: Record<string, unknown> });
const chooser = () => vi.fn(async (request: { type: string; path: string }) => ({ kind: 'folderChosen', folder: { token, displayPath: request.path } }));
const created = () => vi.fn(async (_request: { action: string }) => ({ kind: 'applied', project: record() }));

// main 必败: there was no group create
it('group create makes the group in the default folder, sends no folder pick and ends with the 完全访问 sentence', async () => {
  const collaboration = created();
  const directory = chooser();
  const h = harness({ collaboration, directory });
  await runGroupCreate('研发', { conversation: 'multi' }, h.io(), h.daemon, host);
  expect(collaboration).toHaveBeenCalledWith({ action: 'createProject', agentId: 'cli_a', name: '研发', folder: { kind: 'default' }, tool: 'codex', conversation: 'threads' });
  expect(directory).not.toHaveBeenCalled();
  const lines = h.out().trimEnd().split('\n');
  expect(lines).toEqual(['已建群并绑定 研发（oc_dev）→ /work/研发 · Codex · 多会话（@ 我开新会话） · 免 @ 开', WARNING]);
  h.clear(); await runGroupCreate('研发', { conversation: 'single', tool: 'claude' }, h.io(true), h.daemon, host);
  // 单会话's default 免@ goes on the wire: a daemon from before s21 made every group with 免@ on (the web page's sentResponse)
  expect(collaboration).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'claude', conversation: 'shared', response: 'mention' }));
  expect(JSON.parse(h.out())).toEqual({ ok: true, group: { groupId: 'oc_dev', name: '研发', folder: '/work/研发', tool: 'codex', conversation: 'threads', response: 'mention', enabled: true, revision: 'r1' }, warning: WARNING });
});

// main 必败: there was no group create
it('group create picks the folder through the daemon and stops when the daemon says it is not there', async () => {
  const collaboration = created();
  const directory = chooser();
  const h = harness({ collaboration, directory });
  await runGroupCreate('研发', { conversation: 'multi', folder: '~/x' }, h.io(), h.daemon, host);
  expect(directory).toHaveBeenCalledWith({ type: 'choose', path: '/home/u/x' });
  expect(collaboration).toHaveBeenCalledWith(expect.objectContaining({ folder: { kind: 'existing', folderToken: token } }));
  const missing = vi.fn(async () => { throw new RpcError('invalid_directory', '找不到这个目录，请检查路径。'); });
  const m = harness({ collaboration: created(), directory: missing });
  const error = await caught(runGroupCreate('研发', { conversation: 'multi', folder: 'nope' }, m.io(), m.daemon, host));
  expect(error).toEqual(failure('bad-args', { reason: 'invalid_directory' }));
  expect(error.message).toContain('找不到这个目录，请检查路径。');
  expect(missing).toHaveBeenCalledWith({ type: 'choose', path: '/here/nope' });
});

// main 必败: there was no group create
it('group create joins a project by name, and refuses a project with a folder path before connecting', async () => {
  const collaboration = created();
  const h = harness({ collaboration });
  await runGroupCreate('研发', { conversation: 'smart', project: '官网', folder: 'default' }, h.io(true), h.daemon, host);
  expect(collaboration).toHaveBeenCalledWith({ action: 'createProject', agentId: 'cli_a', name: '研发', folder: { kind: 'default' }, project: 'prj_0000000a', tool: 'codex', conversation: 'smart' });
  const offline = harness({});
  expect(await caught(runGroupCreate('研发', { conversation: 'multi', project: '官网', folder: '~/x' }, offline.io(), offline.daemon, host))).toEqual(failure('bad-args'));
  expect(await caught(runGroupCreate('研发', { conversation: 'smart', response: 'all' }, offline.io(), offline.daemon, host))).toEqual(failure('bad-args'));
  expect(await caught(runGroupCreate('a/b', { conversation: 'multi' }, offline.io(), offline.daemon, host))).toEqual(failure('bad-args'));
  expect(await caught(runGroupCreate('研发', {}, offline.io(), offline.daemon, host))).toEqual(failure('bad-args'));
  expect(offline.connect).not.toHaveBeenCalled();
  expect(await caught(runGroupCreate('研发', { conversation: 'multi', project: '没有' }, h.io(), h.daemon, host))).toEqual(failure('bad-args', { message: '没有找到项目「没有」。用 vonvon project list 查看。' }));
});

// main 必败: there was no group create
it('group create: made but not saved is 1, maybe made is 6, and a bot not running is refused before anything is sent', async () => {
  const unsaved = harness({ collaboration: vi.fn(async () => { throw new RpcError('created_unsaved', '群已经建好，但没有保存绑定。在飞书里找到这个群，用 vonvon group bind 绑定。'); }) });
  const error = await caught(runGroupCreate('研发', { conversation: 'multi' }, unsaved.io(), unsaved.daemon, host));
  expect(error).toEqual(failure('failed', { reason: 'created_unsaved' }));
  expect(error.message).toContain('群已经建好，但没有保存绑定。');
  const unknown = harness({ collaboration: vi.fn(async () => { throw new RpcError('outcome_unknown', '不确定群有没有建好。'); }) });
  expect(await caught(runGroupCreate('研发', { conversation: 'multi' }, unknown.io(), unknown.daemon, host))).toEqual(failure('outcome-unknown'));
  const silent = harness({ collaboration: () => new Promise(() => {}) });
  expect((await caught(runGroupCreate('研发', { conversation: 'multi' }, silent.io(), silent.daemon, host))).message).toContain('群可能已经建好，运行 vonvon group list 查看。');
  const collaboration = created();
  const stopped = harness({ collaboration, snapshot: async () => snapshot([agent('cli_a', '研发助手', { running: false })]) });
  expect(await caught(runGroupCreate('研发', { conversation: 'multi' }, stopped.io(), stopped.daemon, host))).toEqual(failure('refused', {
    reason: 'bot_not_running', message: 'Bot「研发助手」没在运行。运行 vonvon bot enable cli_a，或者 vonvon bot status cli_a 看原因。',
  }));
  expect(collaboration).not.toHaveBeenCalled();
  expect(() => runningBot([agent('cli_a')])).not.toThrow();
});

// main 必败: there was no group show
it('group show prints one line, the revision only in --json', async () => {
  const h = harness({ collaboration: vi.fn(async () => ({ kind: 'project', project: record({ kind: 'single', enabled: false }) })) });
  await runGroupShow('研发', {}, h.io(), h.daemon);
  expect(h.out()).toBe('研发  oc_dev  Codex · 单会话 · 已停用  /work/研发\n');
  h.clear(); await runGroupShow('oc_dev', {}, h.io(true), h.daemon);
  expect(JSON.parse(h.out())).toEqual({ ok: true, group: { groupId: 'oc_dev', name: '研发', folder: '/work/研发', tool: 'codex', conversation: 'shared', response: 'all', enabled: false, revision: 'r1' } });
  expect(await caught(runGroupShow('别的', {}, h.io(), h.daemon))).toEqual(failure('bad-args'));
});

// main 必败: there was no group set
it('group set reads the revision and writes right after; --revision skips the read; a stale one is a conflict', async () => {
  const collaboration = vi.fn(async (request: { action: string }) => request.action === 'project'
    ? { kind: 'project', project: record() } : { kind: 'applied', project: record({ enabled: false, revision: 'r2' }), message: '已停用。' });
  const h = harness({ collaboration, directory: chooser() });
  await runGroupSet('研发', { disable: true }, h.io(), h.daemon, host);
  expect(collaboration.mock.calls.map(([request]) => request)).toEqual([
    { action: 'project', agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev' },
    { action: 'editProject', agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev', expectedRevision: 'r1', enabled: false },
  ]);
  expect(h.out()).toBe('已改「研发」：已停用\n研发  oc_dev  Codex · 多会话 · 已停用  /work/研发\n已停用。\n');
  collaboration.mockClear(); h.clear();
  await runGroupSet('oc_dev', { revision: 'r0', conversation: 'single', folder: '~/y' }, h.io(true), h.daemon, host);
  expect(collaboration.mock.calls.map(([request]) => request)).toEqual([
    { action: 'editProject', agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev', expectedRevision: 'r0', folderToken: token, conversation: 'shared' },
  ]);
  expect(JSON.parse(h.out())).toMatchObject({ ok: true, changed: ['conversation', 'folder'], group: { revision: 'r2' }, message: '已停用。' });
  const stale = harness({ collaboration: vi.fn(async (request: { action: string }) => {
    if (request.action === 'project') return { kind: 'project', project: record() };
    throw new RpcError('conflict', '项目设置已改变，请刷新后重试');
  }) });
  const error = await caught(runGroupSet('研发', { enable: true }, stale.io(), stale.daemon, host));
  expect(error).toEqual(failure('conflict'));
  expect(error.message).toContain('运行 vonvon group show 研发 看最新的再改。');
  const offline = harness({});
  for (const options of [{}, { enable: true, disable: true }, { folder: 'default' }, { folder: '~/y', project: '官网' }, { conversation: 'later' }]) {
    expect(await caught(runGroupSet('研发', options, offline.io(), offline.daemon, host))).toEqual(failure('bad-args'));
  }
  expect(offline.connect).not.toHaveBeenCalled();
});

// Codex review 256-3 / 257-2. main 必败: a group's session sees no bindings (s1b), so pickGroup refused its own group with
// 这个操作不能从 Bot 会话里做 before the write reached the daemon, whose answer is the not-dm sentence
it('group set in a group\'s Bot session sends the write for the daemon to refuse, with nothing read first', async () => {
  setCliContext({ env: { VONVON_SESSION: `vs1.ses_0123456789abcdef.${'a'.repeat(43)}` } });
  try {
    const collaboration = vi.fn(async (_request: { action: string }) => { throw new RpcError('not-dm', NOT_DM_MESSAGE); });
    const directory = chooser();
    const library = vi.fn(async () => { throw new Error('a group session has no library list'); });
    const h = harness({
      collaboration, directory, library,
      // the snapshot a group's session reads: no bindings, its group's project with its own binding
      snapshot: async () => ({ ...snapshot([agent('cli_a')]), projects: [{ id: 'prj_0000000a', name: '研发', revision: 1, directory: '', bindings: [{ agentId: 'cli_a', groupId: 'oc_dev' }] }] }),
      admin: async () => ({ kind: 'negotiated', principal: 'bot-session:group', scope: { bot: 'cli_a', group: 'oc_dev' } }),
    } as Fake);
    for (const [wanted, options] of [['研发', { disable: true }], ['oc_dev', { conversation: 'single', folder: '~/y', revision: 'r0' }], ['研发', { project: '官网' }]] as const) {
      collaboration.mockClear();
      const error = await caught(runGroupSet(wanted, options, h.io(true), h.daemon, host));
      expect(error, wanted).toEqual(failure('refused', { reason: 'not-dm', message: NOT_DM_MESSAGE }));
      expect(collaboration.mock.calls.map(([request]) => request.action), wanted).toEqual(['editProject']);
      expect(collaboration.mock.calls[0]?.[0], wanted).toMatchObject({ agentId: 'cli_a', groupId: 'oc_dev', projectName: '研发' });
    }
    expect(directory).not.toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();
    // a name the snapshot does not have reads as any other refused read
    expect(await caught(runGroupSet('别的', { disable: true }, h.io(true), h.daemon, host))).toEqual(failure('refused', { reason: 'permission_denied', message: '这个操作不能从 Bot 会话里做。' }));
  } finally { setCliContext({ env: process.env }); }
});

// main 必败: there was no group unbind
it('group unbind sends nothing but the read without --yes; with it a bot that could not leave still exits 0', async () => {
  const collaboration = vi.fn(async (request: { action: string }) => request.action === 'project' ? { kind: 'project', project: record() } : { kind: 'applied', groupEffect: 'failed' });
  const h = harness({ collaboration });
  const error = await caught(runGroupUnbind('研发', {}, h.io(true), h.daemon));
  expect(error).toEqual(failure('bad-args', { reason: 'confirm_required', partial: { groupId: 'oc_dev', name: '研发', folder: '/work/研发', tool: 'codex', conversation: 'threads' } }));
  expect(error.message).toBe('解除 Vonvon Bot 与「研发群」的关联。Bot 加入的群会退出；Bot 创建的群会尝试转交群主。本地目录和文件保留。确认后加 --yes 再运行一次。');
  expect(collaboration.mock.calls.map(([request]) => request.action)).toEqual(['project']);
  await runGroupUnbind('研发', { yes: true }, h.io(), h.daemon);
  expect(collaboration).toHaveBeenLastCalledWith({ action: 'removeProject', agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev', expectedRevision: 'r1' });
  expect(h.out()).toBe('已解绑「研发」（oc_dev）。\n已解绑，但 Bot 没能退出飞书群，要自己在飞书里移除。\n');
  h.clear(); await runGroupUnbind('研发', { yes: true }, h.io(true), h.daemon);
  expect(JSON.parse(h.out())).toEqual({ ok: true, unbound: { groupId: 'oc_dev', name: '研发' }, groupEffect: 'failed' });
});

// main 必败: --folder was required and stat-ed here
it('group bind without --folder takes the default folder; a folder not there is the daemon\'s to say', async () => {
  const run = vi.fn(async (command: { type: string }) => command.type === 'listPendingGroups'
    ? { kind: 'pendingGroups', groups: [{ chatId: 'oc_x', name: '新群', addedAt: 1 }] } : { kind: 'applied', revision: 7 });
  const directory = chooser();
  const after = snapshot([agent('cli_a')], [member('cli_a', 'oc_x', '新群', { directory: '/data/projects/新群' })]);
  const h = harness({ run, directory, snapshot: async () => after });
  await runGroupBind('oc_x', { conversation: 'multi' }, h.io(), h.daemon, host);
  expect(run).toHaveBeenLastCalledWith({ type: 'bindGroup', agentId: 'cli_a', groupId: 'oc_x', projectName: '新群', folder: { kind: 'default' }, tool: 'codex', conversation: 'threads' });
  expect(directory).not.toHaveBeenCalled();
  expect(h.out()).toBe('已绑定 新群（oc_x）→ /data/projects/新群 · Codex · 多会话（@ 我开新会话） · 免 @ 开\n');
  await runGroupBind('oc_x', { conversation: 'single', project: 'prj_0000000a' }, h.io(), h.daemon, host);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ folder: { kind: 'default' }, project: 'prj_0000000a' }));
  const missing = vi.fn(async () => { throw new RpcError('invalid_directory', '找不到这个目录，请检查路径。'); });
  const m = harness({ run, directory: missing });
  run.mockClear();
  const error = await caught(runGroupBind('oc_x', { conversation: 'multi', folder: '/nowhere/at/all' }, m.io(), m.daemon, host));
  expect(error).toEqual(failure('bad-args', { reason: 'invalid_directory' }));
  expect(missing).toHaveBeenCalledWith({ type: 'choose', path: '/nowhere/at/all' });
  expect(run.mock.calls.map(([command]) => command.type)).not.toContain('bindGroup');
  const offline = harness({});
  expect(await caught(runGroupBind('oc_x', { conversation: 'multi', project: '官网', folder: 'x' }, offline.io(), offline.daemon, host))).toEqual(failure('bad-args'));
  expect(offline.connect).not.toHaveBeenCalled();
});

it('expands ~ and relative paths on this computer only', () => {
  expect(folderPath('~', host)).toBe('/home/u');
  expect(folderPath('~/a', host)).toBe('/home/u/a');
  expect(folderPath('a/../b', host)).toBe('/here/b');
  expect(folderPath('/abs', host)).toBe('/abs');
  // `\` is a name character outside Windows
  expect(folderPath('~\\a', host)).toBe('/here/~\\a');
  // main 必败: Windows took ~\Docs for a folder named "~" (Windows acceptance task 205)
  const windows = { cwd: 'C:\\here', home: 'C:\\Users\\u', platform: 'win32' as const };
  expect(folderPath('~', windows)).toBe('C:\\Users\\u');
  expect(folderPath('~\\Docs', windows)).toBe('C:\\Users\\u\\Docs');
  expect(folderPath('~/Docs', windows)).toBe('C:\\Users\\u\\Docs');
  expect(folderPath('~\\..\\x', windows)).toBe('C:\\Users\\x');
  expect(folderPath('a\\..\\b', windows)).toBe('C:\\here\\b');
  expect(folderPath('D:\\abs', windows)).toBe('D:\\abs');
});

// main 必败: these were 1 (unexpected), and the folder ones came back as operation_failed anyway
it('the daemon\'s folder errors are argument errors', () => {
  for (const code of ['invalid_directory', 'outside_home', 'invalid_folder_token', 'invalid_request']) expect(rpcErrorKind(code), code).toBe('bad-args');
  expect(rpcErrorKind('created_unsaved')).toBe('failed');
});

// main 必败: the nine kinds were pending C3 in the allowlist
it('covers the nine C3 kinds, none still in the allowlist', async () => {
  const commands = await loadCommands();
  const kinds = ['collaboration.createProject', 'collaboration.project', 'collaboration.editProject', 'collaboration.removeProject', 'directory.list', 'directory.suggest', 'library.workspace', 'library.rename', 'library.delete'];
  for (const kind of kinds) {
    expect(CLI_PARITY_ALLOWLIST[kind], kind).toBeUndefined();
    expect(commands.some(command => command.covers.includes(kind)), kind).toBe(true);
  }
  expect(commands.find(command => command.path === 'group bind')?.covers).toContain('library.list');
  expect(commands.find(command => command.path === 'group bind')?.options).toContain('--project');
});


it('reads an exact platform group identity through the typed command rather than listing groups', async () => {
  const run = vi.fn(async () => ({kind: 'groupIdentity', agentId: 'cli_a', groupId: 'oc_exact', name: '平台群名'}));
  const h = harness({run});
  await runFeishuGroupIdentity('oc_exact', {bot: 'cli_a'}, h.io(true), h.daemon);
  expect(run).toHaveBeenCalledExactlyOnceWith({type: 'readGroupIdentity', agentId: 'cli_a', groupId: 'oc_exact'});
  expect(JSON.parse(h.out())).toEqual({ok: true, kind: 'groupIdentity', agentId: 'cli_a', groupId: 'oc_exact', name: '平台群名'});
  expect((await loadCommands()).find(command => command.path === 'feishu group-identity')?.covers).toEqual(['command.readGroupIdentity']);
});
