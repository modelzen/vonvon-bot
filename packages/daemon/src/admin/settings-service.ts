import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackend } from '../agent';
import { botDir, botPaths, paths } from '../config/paths';
import { loadConfig } from '../config/store';
import { isComplete } from '../config/schema';
import { getProjectByChatId, listProjectsIn, mutateProject, mutateProjectByChatId } from '../project/registry';
import { listSessionsIn } from '../bot/session-store';
import { DEFAULT_COMMENT_INSTRUCTIONS } from '../bot/comments';
import { createSettingsOwner, offlineSettings, SettingsInputError, isLocalSettingsSection, workspaceRevision } from './settings';
import { admitLibraryWorkspace, type HostLibrary } from './library';
import { AdminWriteError } from './ops';
import { isProjectId, LibraryError, readLibrary } from '../project/library';
import { createHostSettings } from './host-settings';
import type { AdminServiceDeps } from './service';
import type { BotSettingsEdit, HostSettings, ProjectSettingsView, SettingsAccess, SettingsSave, SettingsActionResult, SettingsSection, SettingsSectionView, SettingsView, ModelCatalog } from './settings-types';
import type { ProjectWorkspace } from '../project/registry';
import { acquireMutex, closeMutex } from '../config/data-access';
import { loadBots } from '../config/bots';
import { acquireSingleInstanceLock, readSingleInstanceHolder } from '../core/single-instance';
import { assertBridgeImportReservation } from '../import/bridge/reservation';
export function createSettingsService(deps: AdminServiceDeps, library?: HostLibrary): HostSettings {
  const host = createHostSettings({
    readonly: deps.readonlyPreview
  });
  const unavailable = (): SettingsAccess => deps.readonlyPreview ? {
    kind: 'readonly',
    reason: 'preview',
    message: '预览模式不能改设置，请先启动 daemon'
  } : offlineSettings;
  const owned = async (botId: string) => !deps.readonlyPreview && !!deps.executeWrite && (await deps.liveStatus?.(botId))?.running === true;
  async function localOwner(botId: string, localEditing = false) {
      const cfg = await loadConfig(botPaths(botId).configFile);
      if (!isComplete(cfg)) throw new SettingsInputError('这个 Bot 不存在，或者配置不完整');
      const files = botPaths(botId);
      return createSettingsOwner({ cfg, offline: true, localEditing, access: unavailable(), backendFor: createBackend,
        writePreferences: async () => { throw new Error('只读'); },
        evictLiveSessionsForChat: async () => {},
        readProject: async name => (await listProjectsIn(files.projectsFile)).find(p => p.name === name),
        listProjects: () => listProjectsIn(files.projectsFile),
        readChatProject: chatId => getProjectByChatId(chatId, files.projectsFile),
        mutateProject: (name, change, options) => mutateProject(name, change, options, { file: files.projectsFile, dataRoot: paths.appDir }),
        mutateChatProject: (chatId, change, options) => mutateProjectByChatId(chatId, change, options, { file: files.projectsFile, dataRoot: paths.appDir }),
        readSession: async id => (await listSessionsIn(files.sessionsFile)).find(s => s.threadId === id),
        instructions: { read: () => readFile(join(botDir(botId), 'comment-instructions.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return DEFAULT_COMMENT_INSTRUCTIONS; throw error; }),
          save: async () => { throw new Error('只读'); }, sync: async () => { throw new Error('只读'); } },
      });
  }
  const stopped = async (botId: string) => {
    if (deps.readonlyPreview || !deps.executeWrite) return false;
    if ((await deps.liveStatus?.(botId))?.running === true) return false;
    // Disabled bots have no child/status entry. A stopped owner still has to prove no
    // actual process owns the files; malformed receipts fail closed.
    try {
      const file = botPaths(botId).processesFile;
      const raw = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (raw && JSON.parse(raw).pid === process.pid) return false;
      return !readSingleInstanceHolder(botId, file);
    } catch { return false; }
  };
  /**
   * A workspace save for a group of a library project: the workspace is the project's, so it is written in the
   * library and every group and bot of the project follows (admin/library.ts), instead of in the bot's own row. Left to
   * the bot when the row has no project. Same checks the bot's own save made: the revision the page read, the primary
   * among the folders; the section it answers with is read back from where the bot's files now are.
   */
  async function saveWorkspace(edit: Extract<BotSettingsEdit, { scope: { kind: 'project' } }>): Promise<SettingsSave | undefined> {
    if (!library || deps.readonlyPreview) return undefined;
    const botId = edit.scope.botId;
    const row = (await listProjectsIn(botPaths(botId).projectsFile)).find(item => item.name === edit.scope.projectName);
    if (!row || !isProjectId(row.projectId)) return undefined;
    const project = (await readLibrary()).projects.find(item => item.id === row.projectId);
    if (!project) return undefined;
    const workspaceSection = async (): Promise<SettingsSection<ProjectWorkspace>> => {
      const view = await host.read(edit.scope);
      const section = view.scope.kind === 'project' ? (view as ProjectSettingsView).sections.workspace : undefined;
      if (!section) throw new SettingsInputError('无效设置分区');
      return section;
    };
    const sectionOf = async (): Promise<SettingsSectionView> => ({ scope: edit.scope, section: 'workspace', value: await workspaceSection() });
    if (workspaceRevision(botId, row) !== edit.revision) return { kind: 'conflict', current: await sectionOf() };
    const value = { ...(await workspaceSection()).stored, ...edit.patch as Partial<ProjectWorkspace> };
    const rejected = (message: string): SettingsSave => ({ kind: 'rejected', fields: [{ field: 'settings', message }] });
    if (!value.directories.includes(value.primary)) return rejected('主目录必须在工作区目录中');
    let change;
    try {
      change = await library.workspace({ projectId: project.id,
        workspace: { primary: value.primary, additional: value.directories.filter(path => path !== value.primary), repositories: value.repositories } });
    } catch (error) {
      if (error instanceof LibraryError || error instanceof AdminWriteError) return rejected(error.message);
      throw error;
    }
    const section = await sectionOf();
    const lagging = change.rebound.filter(item => item.state === 'failed').length;
    return { kind: 'saved', section, effects: [
      ...section.value.apply.filter(item => item.fields.some(field => Object.hasOwn(edit.patch as object, field))),
      ...(lagging ? [{ fields: ['primary'], when: 'restart' as const, detail: `设置已保存，但有 ${lagging} 个绑定没跟上，下次启动 daemon 时会修好` }] : []),
    ] };
  }
  return {
    async read(scope) {
      if (scope.kind === 'host')
        return host.read(scope);
      if (deps.executeSettingsRead && await owned(scope.botId))
        return await deps.executeSettingsRead(scope.botId, {
          kind: 'settingsRead',
          scope
        }) as SettingsView;
      return (await localOwner(scope.botId, await stopped(scope.botId))).read(scope);
    },
    async save(edit) {
      if (edit.scope.kind === 'host')
        return host.save(edit);
      const botId = edit.scope.botId;
      if (edit.scope.kind === 'project' && edit.section === 'workspace') {
        const saved = await saveWorkspace(edit as Extract<BotSettingsEdit, { scope: { kind: 'project' } }>);
        if (saved) return saved;
      }
      if (!await owned(botId)) {
        if (!isLocalSettingsSection(edit.scope.kind, edit.section) || !await stopped(edit.scope.botId)) return { kind: 'unavailable', reason: unavailable() };
        // Keep registration and the actual Bot process excluded across read/CAS/write. A stale
        // supervisor status alone is not write ownership; starts use this same instance lock.
        const mutex = await acquireMutex(paths.appDir, 'bots', 3000);
        let release: (() => void) | undefined;
        try {
          const registry = await loadBots();
          if (!registry.bots.some(bot => bot.appId === botId)) throw new SettingsInputError('Bot 已移除');
          await assertBridgeImportReservation(paths.appDir, botId);
          if (!await stopped(edit.scope.botId)) return { kind: 'unavailable', reason: unavailable() };
          const files = botPaths(edit.scope.botId);
          const dir = await lstat(files.dir);
          if (!dir.isDirectory() || dir.isSymbolicLink()) throw new SettingsInputError('Bot 数据目录无效');
          const old = await readFile(files.processesFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
          if (old && JSON.parse(old).pid === process.pid) return { kind: 'unavailable', reason: unavailable() };
          release = acquireSingleInstanceLock(edit.scope.botId, files.processesFile, { createDir: false, onExit: false });
          return await (await localOwner(edit.scope.botId, true)).save(edit);
        } finally { release?.(); await closeMutex(mutex); }
      }
      return await deps.executeWrite!(edit.scope.botId, {
        kind: 'settingsPatch',
        edit: edit as import('./settings-types').BotSettingsEdit
      }) as SettingsSave;
    },
    async act(action) {
      if (!await owned(action.botId))
        return {
          kind: 'unavailable',
          reason: unavailable()
        };
      return await deps.executeWrite!(action.botId, {
        kind: 'settingsAction',
        action
      }) as SettingsActionResult;
    },
    async models(query) {
      if (!deps.executeSettingsRead || !await owned(query.botId)) {
        if (await stopped(query.botId)) return (await localOwner(query.botId, true)).models(query);
        return {
          backend: query.backend,
          models: [],
          state: 'unavailable',
          source: 'backend-provided',
          observedAt: new Date().toISOString(),
          error: '这个 Bot 没在运行',
          titleEfforts: []
        };
      }
      return await deps.executeSettingsRead(query.botId, {
        kind: 'settingsModels',
        query
      }) as ModelCatalog;
    },
  };
}
