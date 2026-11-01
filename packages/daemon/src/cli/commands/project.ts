import { ConnectionError } from '@vonvon/client';
import type { LibraryProject } from '@vonvon/protocol';
import type { LibraryOverview } from '../../admin/library';
import { inBotSession } from '../../config/session-env';
import { badArgs, CommandError } from '../command-error';
import { print, want, withDaemon, type Daemon, type Io } from '../daemon-client';
import { folderPath, libraryProjects, pickProject, projectName, thisHost, type Host } from './group';

const readOverview = async (): Promise<LibraryOverview> => (await import('../../admin/library')).libraryOverview();
const NO_PROJECTS = '还没有项目。绑定群以后，daemon 启动时给每个群建好项目。';

/**
 * Asks the daemon when it runs (devices 8.3); with no daemon to reach it reads the files, where a group bound since the
 * last start has no project yet. Not in a Bot's session: the files would go round what the daemon lets the session see.
 */
export async function runProjectList(io: Io, read: () => Promise<LibraryOverview> = readOverview, daemon: Daemon = withDaemon, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let live: { projects: LibraryProject[]; unlinked: number; bots: Map<string, string> } | undefined;
  try {
    live = await daemon(async call => {
      const library = want('读取项目', await call('读取项目', c => c.library({ type: 'list' })), 'list');
      // the bots' names only; without them a binding shows its bot's id
      const agents = await call('读取快照', c => c.snapshot()).then(snapshot => snapshot.agents, () => []);
      return { projects: library.projects, unlinked: library.unlinked, bots: new Map(agents.map(agent => [agent.id, agent.name])) };
    });
  } catch (error) {
    const unreachable = (error instanceof CommandError && error.kind === 'connection') || error instanceof ConnectionError;
    if (!unreachable || inBotSession(env)) throw error;
  }
  if (live) {
    const { bots } = live;
    const human: string[] = [];
    for (const project of live.projects) {
      human.push(`${project.name}  ${project.id}  ${project.workspace.primary}`);
      if (!project.bindings.length) human.push('  没有群');
      for (const binding of project.bindings) human.push(`  ${bots.get(binding.agentId) ?? binding.agentId} 在 ${binding.name}  ${binding.groupId}${binding.enabled ? '' : '（群已停用）'}`);
    }
    if (!live.projects.length && !live.unlinked) human.push(NO_PROJECTS);
    if (live.unlinked) human.push(`还有 ${live.unlinked} 个群没有项目，daemon 下次启动时会建好。`);
    print(io, human, { source: 'daemon', projects: live.projects, unlinked: live.unlinked });
    return;
  }
  const overview = await read();
  const human: string[] = [];
  for (const project of overview.projects) {
    human.push(`${project.name}  ${project.id}  ${project.workspace.primary}`);
    // A project outlives its last group (owner D4); the owner deletes it by hand.
    if (!project.bindings.length) human.push('  没有群');
    for (const binding of project.bindings) human.push(`  ${binding.botName} 在 ${binding.name}  ${binding.chatId}${binding.enabled ? '' : '（群已停用）'}`);
  }
  if (!overview.projects.length && !overview.unlinked.length) human.push(NO_PROJECTS);
  if (overview.unlinked.length) {
    human.push(`还有 ${overview.unlinked.length} 个群没有项目，daemon 下次启动时会建好：${overview.unlinked.map(binding => `${binding.botName} 在 ${binding.name}`).join('、')}`);
  }
  for (const bot of overview.unreadable) human.push(`读不了 ${bot.botName}（${bot.botId}）的群：${bot.error}`);
  // devices 8.3: read from the files, not the daemon
  print(io, human, { source: 'files', ...overview });
}

const changedMaybe = '可能已经改了，运行 vonvon project list 查看。';

/** `vonvon project rename`: a project's own name, which does not follow its groups' names (§5.3). */
export async function runProjectRename(wanted: string, rawName: string, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const name = projectName(rawName);
  const { from, project } = await daemon(async call => {
    const project = pickProject(await libraryProjects(call), wanted);
    const reply = await call('项目改名', c => c.library({ type: 'rename', projectId: project.id, revision: project.revision, name }), { unknown: changedMaybe });
    return { from: project.name, project: want('项目改名', reply, 'renamed').project };
  });
  print(io, [`已把项目「${from}」改名为「${project.name}」。`], { project });
}

/**
 * `vonvon project remove`: a project no group uses, with its memory and records. One still in use is refused before
 * anything is sent (4), and without --yes nothing is deleted (2, with what would go).
 */
export async function runProjectRemove(wanted: string, options: { yes?: boolean }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const removed = await daemon(async call => {
    const project = pickProject(await libraryProjects(call), wanted);
    if (project.bindings.length) {
      const groups = [...new Set(project.bindings.map(binding => binding.name))].join('、');
      throw new CommandError('refused', `这个项目还有群在用（${groups}），先解绑或换到别的项目。`, { reason: 'project_in_use' });
    }
    if (!options.yes) {
      throw new CommandError('bad-args', '删除项目会一起删掉它的项目记忆和记录，不能撤销。确认后加 --yes 再运行一次。', {
        reason: 'confirm_required', partial: { id: project.id, name: project.name, workspace: project.workspace },
      });
    }
    want('删除项目', await call('删除项目', c => c.library({ type: 'delete', projectId: project.id, revision: project.revision }), { unknown: '可能已经删了，运行 vonvon project list 查看。' }), 'deleted');
    return { id: project.id, name: project.name };
  });
  print(io, [`已删除项目「${removed.name}」。`], { removed });
}

export type WorkspaceOptions = { primary?: string; add?: string[]; remove?: string[]; repos?: string[]; defaultRepos?: boolean };

/**
 * `vonvon project workspace` (cli-3-groups 4.2): the project page's 工作区, changed from what it is now. Every group of
 * the project follows and its sessions are archived; the daemon says which folders it takes (`admitDirectorySettings`).
 */
export async function runProjectWorkspace(wanted: string, options: WorkspaceOptions, io: Io, daemon: Daemon = withDaemon, host: Host = thisHost()): Promise<void> {
  const paths = (raw: string[] | undefined) => [...new Set((raw ?? []).map(path => folderPath(path, host)))];
  const [add, remove, repos] = [paths(options.add), paths(options.remove), paths(options.repos)];
  if (repos.length && options.defaultRepos) throw badArgs('--repos 和 --default-repos 只能选一个。');
  const primary = options.primary === undefined ? undefined : folderPath(options.primary, host);
  if (primary === undefined && !add.length && !remove.length && !repos.length && !options.defaultRepos) {
    throw badArgs('没有要改的。给 --primary、--add、--remove、--repos 或 --default-repos 里的至少一项。');
  }
  const result = await daemon(async call => {
    const project = pickProject(await libraryProjects(call), wanted);
    const current = project.workspace;
    const absent = remove.filter(path => !current.additional.includes(path));
    if (absent.length) throw badArgs(`${absent.map(path => `「${path}」`).join('')}不在这个项目的附加文件夹里。现在的附加文件夹：${current.additional.join('、') || '没有'}`);
    const main = primary ?? current.primary;
    const additional = [...current.additional.filter(path => !remove.includes(path)), ...add.filter(path => !current.additional.includes(path))].filter(path => path !== main);
    // left out = each bot's own default repositories, as the web page leaves it out
    const repositories = options.defaultRepos ? undefined : repos.length ? repos : current.repositories;
    const reply = await call('改项目工作区', c => c.library({ type: 'workspace', projectId: project.id, revision: project.revision, workspace: { primary: main, additional, ...repositories ? { repositories } : {} } }), { feishu: true, unknown: changedMaybe });
    return { project, done: want('改项目工作区', reply, 'workspace') };
  });
  const { project, done } = result;
  const human: string[] = [];
  if (!done.changed) human.push(`项目「${project.name}」的工作区没有变化。`);
  else {
    const archived = done.rebound.filter(item => item.state === 'archived').length;
    human.push(`已改项目「${project.name}」的工作区：主文件夹 ${done.project.workspace.primary}，附加文件夹 ${done.project.workspace.additional.length} 个。`);
    if (archived) human.push(`${archived} 个群的会话已归档，下一轮重新开场。`);
  }
  for (const item of done.rebound.filter(each => each.state === 'failed')) {
    const name = project.bindings.find(binding => binding.agentId === item.agentId && binding.groupId === item.groupId)?.name ?? item.groupId ?? item.agentId;
    human.push(`群「${name}」没跟上，daemon 下次启动时会补${item.message ? `：${item.message}` : '。'}`);
  }
  print(io, human, { project: done.project, changed: done.changed, rebound: done.rebound });
}
