import { expect, it, vi } from 'vitest';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import { agentIdSchema, type Agent, type DesktopSnapshot, type LibraryProject } from '@vonvon/protocol';
import { CommandError } from '../src/cli/command-error';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runProjectList, runProjectRemove, runProjectRename, runProjectWorkspace } from '../src/cli/commands/project';
import type { LibraryOverview } from '../src/admin/library';

/** cli-3-groups: project list through the daemon, and project rename / remove / workspace, behind the real withDaemon. */
const agent = (id: string, name: string): Agent => ({ id: agentIdSchema.parse(id), name, enabled: true, running: true, connection: 'connected', activation: 'active' });
const snapshot = (): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents: [agent('cli_a', '小支')], groups: [], memberships: [], tools: [], jobs: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
const project = (extra: Partial<LibraryProject> = {}): LibraryProject => ({
  id: 'prj_0000000a' as LibraryProject['id'], name: '官网', revision: 3, workspace: { primary: '/work/site', additional: ['/work/docs'], repositories: ['/work/repo'] }, bindings: [], ...extra,
});
const bound = project({ id: 'prj_0000000b' as LibraryProject['id'], name: '支付', workspace: { primary: '/work/pay', additional: [] }, bindings: [
  { agentId: agentIdSchema.parse('cli_a'), groupId: 'oc_pay' as never, name: '支付组', enabled: true },
  { agentId: agentIdSchema.parse('cli_b'), groupId: 'oc_pay' as never, name: '支付组', enabled: false },
] });

function harness(library: (request: never) => unknown) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, library, snapshot: async () => snapshot() }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, connect, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const listed = (projects: LibraryProject[] = [project(), bound], unlinked = 0) => vi.fn(async (request: { type: string }) => request.type === 'list' ? { kind: 'list', projects, unlinked } : undefined);
const overview: LibraryOverview = { projects: [], unlinked: [], unreadable: [] };
const offline = (error: Error): Daemon => async () => { throw error; };
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string; partial?: Record<string, unknown> });

// main 必败: project list only read the files
it('project list asks the daemon when it runs, and reads no file', async () => {
  const h = harness(listed(undefined, 2));
  const read = vi.fn(async () => overview);
  await runProjectList(h.io(), read, h.daemon, {});
  expect(read).not.toHaveBeenCalled();
  expect(h.out().split('\n')).toEqual([
    '官网  prj_0000000a  /work/site', '  没有群',
    '支付  prj_0000000b  /work/pay', '  小支 在 支付组  oc_pay', '  cli_b 在 支付组  oc_pay（群已停用）',
    '还有 2 个群没有项目，daemon 下次启动时会建好。', '',
  ]);
  h.clear(); await runProjectList(h.io(true), read, h.daemon, {});
  expect(JSON.parse(h.out())).toEqual({ ok: true, source: 'daemon', projects: [project(), bound], unlinked: 2 });
});

// main 必败: project list only read the files
it('project list reads the files with no daemon to reach, but not in a Bot session', async () => {
  const read = vi.fn(async () => overview);
  let out = '';
  const io = { json: true, write: (text: string) => { out += text; } };
  await runProjectList(io, read, offline(new CommandError('connection', 'daemon 没有运行。先运行 vonvon daemon start。')), {});
  expect(JSON.parse(out)).toEqual({ ok: true, source: 'files', ...overview });
  out = ''; await runProjectList(io, read, offline(new ConnectionError(new Error('ECONNREFUSED'))), {});
  expect(JSON.parse(out)).toMatchObject({ source: 'files' });
  expect(read).toHaveBeenCalledTimes(2);
  read.mockClear(); out = '';
  await expect(runProjectList(io, read, offline(new CommandError('connection', 'daemon 没有运行。')), { VONVON_SESSION: '1' })).rejects.toMatchObject({ kind: 'connection' });
  expect(read).not.toHaveBeenCalled();
  expect(out).toBe('');
  // a refusal is not "no daemon": it is said, not read round
  await expect(runProjectList(io, read, offline(new CommandError('refused', '不行')), {})).rejects.toMatchObject({ kind: 'refused' });
  expect(read).not.toHaveBeenCalled();
});

// main 必败: there was no project rename
it('project rename finds the project by name or id and sends its revision', async () => {
  const library = vi.fn(async (request: { type: string }) => request.type === 'list'
    ? { kind: 'list', projects: [project()], unlinked: 0 }
    : { kind: 'renamed', project: { id: 'prj_0000000a', name: '主页', revision: 4, workspace: project().workspace } });
  const h = harness(library);
  await runProjectRename('官网', ' 主页 ', h.io(), h.daemon);
  expect(library).toHaveBeenLastCalledWith({ type: 'rename', projectId: 'prj_0000000a', revision: 3, name: '主页' });
  expect(h.out()).toBe('已把项目「官网」改名为「主页」。\n');
  h.clear(); await runProjectRename('prj_0000000a', '主页', h.io(true), h.daemon);
  expect(JSON.parse(h.out())).toEqual({ ok: true, project: { id: 'prj_0000000a', name: '主页', revision: 4, workspace: project().workspace } });
  expect(await caught(runProjectRename('没有', '主页', h.io(), h.daemon))).toMatchObject({ kind: 'bad-args' });
  expect(await caught(runProjectRename('官网', 'a/b', h.io(), h.daemon))).toMatchObject({ kind: 'bad-args' });
});

// main 必败: there was no project remove
it('project remove refuses a project in use and deletes nothing without --yes', async () => {
  const library = vi.fn(async (request: { type: string }) => request.type === 'list' ? { kind: 'list', projects: [project(), bound], unlinked: 0 } : { kind: 'deleted', projectId: 'prj_0000000a' });
  const h = harness(library);
  expect(await caught(runProjectRemove('支付', { yes: true }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'project_in_use', message: '这个项目还有群在用（支付组），先解绑或换到别的项目。' });
  const unconfirmed = await caught(runProjectRemove('官网', {}, h.io(true), h.daemon));
  expect(unconfirmed).toMatchObject({ kind: 'bad-args', reason: 'confirm_required', message: '删除项目会一起删掉它的项目记忆和记录，不能撤销。确认后加 --yes 再运行一次。', partial: { id: 'prj_0000000a', name: '官网', workspace: project().workspace } });
  expect(library.mock.calls.map(([request]) => request.type)).toEqual(['list', 'list']);
  await runProjectRemove('官网', { yes: true }, h.io(true), h.daemon);
  expect(library).toHaveBeenLastCalledWith({ type: 'delete', projectId: 'prj_0000000a', revision: 3 });
  expect(JSON.parse(h.out())).toEqual({ ok: true, removed: { id: 'prj_0000000a', name: '官网' } });
});

// main 必败: there was no project workspace
it('project workspace changes what it is now: --add appends, --default-repos drops the repositories', async () => {
  const host = { cwd: '/work', home: '/home/u', platform: 'linux' as const };
  const library = vi.fn(async (request: { type: string; workspace?: unknown }) => request.type === 'list'
    ? { kind: 'list', projects: [project({ bindings: bound.bindings })], unlinked: 0 }
    : { kind: 'workspace', project: { id: 'prj_0000000a', name: '官网', revision: 4, workspace: request.workspace }, changed: true,
      rebound: [{ agentId: 'cli_a', groupId: 'oc_pay', state: 'archived' }, { agentId: 'cli_b', groupId: 'oc_pay', state: 'failed' }] });
  const h = harness(library);
  await runProjectWorkspace('官网', { add: ['~/y'], defaultRepos: true }, h.io(), h.daemon, host);
  expect(library).toHaveBeenLastCalledWith({ type: 'workspace', projectId: 'prj_0000000a', revision: 3, workspace: { primary: '/work/site', additional: ['/work/docs', '/home/u/y'] } });
  expect(h.out()).toBe('已改项目「官网」的工作区：主文件夹 /work/site，附加文件夹 2 个。\n1 个群的会话已归档，下一轮重新开场。\n群「支付组」没跟上，daemon 下次启动时会补。\n');
  // the new main folder leaves the extra ones; repositories not named stay as they are
  await runProjectWorkspace('官网', { primary: 'docs', remove: [] }, h.io(), h.daemon, host);
  expect(library).toHaveBeenLastCalledWith({ type: 'workspace', projectId: 'prj_0000000a', revision: 3, workspace: { primary: '/work/docs', additional: [], repositories: ['/work/repo'] } });
  await runProjectWorkspace('官网', { remove: ['/work/docs'], repos: ['a', 'b'] }, h.io(), h.daemon, host);
  expect(library).toHaveBeenLastCalledWith({ type: 'workspace', projectId: 'prj_0000000a', revision: 3, workspace: { primary: '/work/site', additional: [], repositories: ['/work/a', '/work/b'] } });
  expect(await caught(runProjectWorkspace('官网', { remove: ['/work/elsewhere'] }, h.io(), h.daemon, host))).toMatchObject({ kind: 'bad-args' });
  const calls = library.mock.calls.length;
  for (const options of [{}, { repos: ['a'], defaultRepos: true }]) {
    expect(await caught(runProjectWorkspace('官网', options, h.io(), h.daemon, host))).toMatchObject({ kind: 'bad-args' });
  }
  expect(library.mock.calls.length).toBe(calls);
  const same = harness(async (request: { type: string }) => request.type === 'list' ? { kind: 'list', projects: [project()], unlinked: 0 }
    : { kind: 'workspace', project: { id: 'prj_0000000a', name: '官网', revision: 3, workspace: project().workspace }, changed: false, rebound: [] });
  await runProjectWorkspace('官网', { add: ['/work/docs'] }, same.io(), same.daemon, host);
  expect(same.out()).toBe('项目「官网」的工作区没有变化。\n');
});

// main 必败: library, memory and contextPreview requests went out unchecked, and a bad one read as 版本不一致
it('checks library, memory and contextPreview requests before sending them, a bad one an argument error', async () => {
  const sent = vi.fn(async () => ({ kind: 'list', projects: [], unlinked: 0 }));
  const connect = vi.fn(async () => ({ close: async () => {}, library: sent, memory: sent, contextPreview: sent }) as unknown as VonvonClient);
  const bad = { type: 'nope' } as never;
  const sends: Array<(c: VonvonClient) => Promise<unknown>> = [c => c.library(bad), c => c.memory(bad), c => c.contextPreview(bad)];
  for (const send of sends) {
    await expect(withDaemon(call => call('读取', send), connect)).rejects.toMatchObject({ kind: 'bad-args', message: expect.stringContaining('读取没有发出：命令行给的参数不对') });
  }
  expect(sent).not.toHaveBeenCalled();
  await withDaemon(call => call('读取项目', c => c.library({ type: 'list' })), connect);
  expect(sent).toHaveBeenCalledWith({ type: 'list' });
});
