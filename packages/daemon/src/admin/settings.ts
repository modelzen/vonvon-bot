import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_BACKEND_ID, type AgentBackend, type ReasoningEffort } from '../agent/types';
import { backendIds } from '../agent';
import { parseModelId } from '../agent/model-id';
import { getCompletionReminderConfig, getMaxConcurrentRuns, getModelDisplay, getPendingPolicy, getRunIdleTimeoutMs, getSessionTitleConfig, getSessionTitleEfforts, getShowToolCalls, resolveOwner, type AppConfig, type AppPreferences } from '../config/schema';
import { paths } from '../config/paths';
import { resolveProjectsRootDir } from '../project/lifecycle';
import { effectiveMode, getProjectByName, listProjects, mutateProject, noMentionOf, pendingPolicyOf, ruleKind, type Project } from '../project/registry';
import { getSession, isRetiredKey, mutateSession, RETIRED_KEY_TEXT, type SessionRecord } from '../bot/session-store';
import { DEFAULT_COMMENT_INSTRUCTIONS, saveCommentInstructions, syncAllCommentInstructions } from '../bot/comments';
import { voiceView } from '../voice/view';
import { parseStoredJudge, resolveJudgeModel } from '../judge/model';
import { JUDGE_CODEX_NOTE, JUDGE_FORMAT_LINES, JUDGE_INPUT_EXAMPLE } from '../judge/prompt';
import { readSmartPrompt, SMART_MAX_CHARS, SmartPromptError } from '../judge/smart-file';
import type { JudgeSelectionStored } from '../judge/types';
import type { VoiceAction } from '../voice/types';
import { probeBackends, type AppPreferencesWriter } from './ops';
import { parseSettingsAction, parseSettingsEdit, SettingsInputError } from './settings-parse';
import type * as T from './settings-types';
export type * from './settings-types';
export { parseSettingsAction, parseSettingsEdit, parseSettingsScope, parseModelQuery, SettingsInputError } from './settings-parse';
export function settingsRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const writable: T.SettingsAccess = {
  kind: 'writable'
};
export const offlineSettings: T.SettingsAccess = {
  kind: 'readonly',
  reason: 'owner-offline',
  message: '请先启动此 Agent，再编辑设置'
};
export interface SettingsOwnerDeps {
  cfg: AppConfig;
  writePreferences: AppPreferencesWriter;
  backendFor: (id: string) => AgentBackend;
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
  voiceAction?: (action: VoiceAction) => Promise<void>;
  refreshCompletionReminders?: () => void;
  access?: T.SettingsAccess;
  runningConcurrency?: number;
  readProject?: typeof getProjectByName;
  listProjects?: typeof listProjects;
  readSession?: typeof getSession;
  mutateProject?: typeof mutateProject;
  mutateSession?: typeof mutateSession;
  /** tests point it at a temporary bot directory */
  readSmartPrompt?: (appId: string, chatId?: string) => ReturnType<typeof readSmartPrompt>;
  instructions?: {
    read(): Promise<string>;
    save(text: string): Promise<void>;
    sync(text: string): Promise<number>;
  };
}
function effect(fields: string[], when: T.ApplyEffect['when'], detail: string): T.ApplyEffect[] {
  return [{
      fields,
      when,
      detail
    }];
}
const agentEffects: {
  [K in keyof T.AgentSections]: T.ApplyEffect[];
} = {
  cards: effect(['showToolCalls', 'showModel'], 'next-message', '后续任务卡片输出生效'),
  run: [...effect(['maxConcurrentRuns'], 'restart', '已保存的并发上限在 Host 重启后生效'), ...effect(['pendingPolicy'], 'next-message', '下一条消息生效'), ...effect(['runIdleTimeoutSeconds'], 'next-turn', '下一次超时检测生效')],
  completion: effect(['mode', 'longTaskMinutes'], 'task-completion', '任务结束时读取最新策略'),
  comments: effect(['backend', 'selection'], 'new-comment', '下一条评论使用新设置'),
  titles: effect(['byBackend'], 'new-session', '仅影响之后由 Bridge 新建的会话'),
  paths: effect(['projectsRootDir'], 'new-project', '仅影响之后新建的空白项目'),
  access: effect(['allowedChats'], 'next-message', '下一条消息使用新权限'),
  judge: effect(['selection'], 'next-message', '智能模式的下一次判断就用新模型'),
};
/** A stored judge setting, or nothing when unset or unusable (the judge ignores those too). */
function storedJudge(value: unknown): JudgeSelectionStored | undefined {
  return parseStoredJudge(value, backendIds()).value;
}
function selection(model?: string, effort?: ReasoningEffort, custom?: boolean): T.ModelSelection {
  return model ? {
    kind: 'explicit',
    model,
    effort: effort ?? 'medium',
    ...(custom ? { custom: true } : {})
  } : {
    kind: 'default'
  };
}
function applySelection(target: {
  model?: string;
  effort?: ReasoningEffort;
}, value: T.ModelSelection): void {
  if (value.kind === 'default') {
    delete target.model;
    delete target.effort;
  }
  else {
    target.model = value.model;
    target.effort = value.effort;
  }
}
function agentData(cfg: AppConfig): T.AgentSections {
  const p = cfg.preferences ?? {};
  const titles: Record<string, T.TitlePolicy> = {};
  for (const id of new Set([...backendIds(), ...Object.keys(p.sessionTitles?.byBackend ?? {})]))
    titles[id] = getSessionTitleConfig(cfg, id);
  return {
    cards: {
      showToolCalls: getShowToolCalls(cfg),
      showModel: getModelDisplay(cfg)
    },
    run: {
      maxConcurrentRuns: getMaxConcurrentRuns(cfg),
      pendingPolicy: getPendingPolicy(cfg),
      runIdleTimeoutSeconds: (getRunIdleTimeoutMs(cfg) ?? 0) / 1000
    },
    completion: getCompletionReminderConfig(cfg),
    comments: {
      backend: p.comments?.backend ?? DEFAULT_BACKEND_ID,
      selection: selection(p.comments?.model, p.comments?.effort)
    },
    titles: {
      byBackend: titles
    },
    paths: {
      projectsRootDir: p.projectsRootDir ?? null
    },
    access: {
      allowedChats: [...(p.access?.allowedChats ?? [])]
    },
    judge: {
      selection: storedJudge(p.judge) ?? { kind: 'default' }
    },
  };
}
function agentRaw(p: AppPreferences, section: keyof T.AgentSections): unknown {
  switch (section) {
    case 'cards': return [p.showToolCalls, p.showModel];
    case 'run': return [p.maxConcurrentRuns, p.runIdleTimeoutSeconds, p.pendingPolicy];
    case 'completion': return [p.completionReminder?.mode, p.completionReminder?.longTaskMinutes];
    case 'comments': return [p.comments?.backend, p.comments?.model, p.comments?.effort];
    case 'titles': return Object.entries(p.sessionTitles?.byBackend ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => [id, v?.enabled, v?.model, v?.effort]);
    case 'paths': return p.projectsRootDir ?? null;
    case 'access': return p.access?.allowedChats ?? [];
    case 'judge': return p.judge;
  }
}
function projectData(p: Project): T.ProjectSections {
  return {
    permission: {
      mode: effectiveMode(p),
      guestMode: effectiveMode(p),
      network: p.network ?? false
    },
    response: {
      noMention: noMentionOf(p)
    },
    model: {
      selection: selection(p.defaultModel, p.defaultEffort, p.defaultModelCustom)
    },
    run: {
      pendingPolicy: p.pendingPolicy ?? 'default'
    },
    judge: {
      selection: storedJudge(p.judge) ?? { kind: 'default' }
    }
  };
}
function projectRaw(p: Project, section: keyof T.ProjectSections): unknown {
  const data = section === 'permission' ? [p.mode, p.network] : section === 'response' ? p.noMention : section === 'run' ? p.pendingPolicy : section === 'judge' ? p.judge : [p.defaultModel, p.defaultEffort, p.defaultModelCustom === true];
  return [p.name, p.chatId, p.cwd, p.backend, data];
}
function sessionRaw(s: SessionRecord): unknown {
  return [s.threadId, s.backend, s.sessionId, s.chatId, s.model, s.effort, s.modelCustom === true];
}
function makeSection<V>(stored: V, raw: unknown, access: T.SettingsAccess, apply: T.ApplyEffect[], effective = stored): T.SettingsSection<V> {
  return {
    stored,
    effective,
    revision: settingsRevision(raw),
    access,
    apply
  };
}
class Conflict extends Error {
}
function check(actual: unknown, revision: string): void {
  if (settingsRevision(actual) !== revision)
    throw new Conflict();
}
function rejected(error: unknown): {
  kind: 'rejected';
  fields: T.SettingsFieldError[];
} {
  return {
    kind: 'rejected',
    fields: [{
        field: 'settings',
        message: error instanceof SettingsInputError ? error.message : '保存失败，请刷新设置后重试；若配置被其他进程修改，请重启 Host'
      }]
  };
}
export function createSettingsOwner(deps: SettingsOwnerDeps): T.HostSettings {
  const cfg = deps.cfg;
  const botId = cfg.accounts.app.id;
  const access = deps.access ?? writable;
  const runningConcurrency = deps.runningConcurrency ?? getMaxConcurrentRuns(cfg);
  const readProject = deps.readProject ?? getProjectByName;
  const readSession = deps.readSession ?? getSession;
  const changeProject = deps.mutateProject ?? mutateProject;
  const changeSession = deps.mutateSession ?? mutateSession;
  const instructions = deps.instructions ?? {
    read: () => readFile(paths.commentInstructionsFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT')
        return DEFAULT_COMMENT_INSTRUCTIONS;
      throw error;
    }),
    save: (text: string) => saveCommentInstructions(paths.commentInstructionsFile, text),
    sync: (text: string) => syncAllCommentInstructions(paths.commentsRootDir, text, cfg.accounts.app.tenant),
  };
  let actionChain: Promise<unknown> = Promise.resolve();
  const own = (scope: T.SettingsScope) => {
    if (scope.kind === 'host' || scope.botId !== botId)
      throw new SettingsInputError('设置不属于此 Agent');
  };
  async function models(query: T.ModelQuery): Promise<T.ModelCatalog> {
    own({
      kind: 'agent',
      botId: query.botId
    });
    const base = {
      backend: query.backend,
      source: 'backend-provided' as const,
      observedAt: new Date().toISOString(),
      titleEfforts: [...getSessionTitleEfforts(query.backend)]
    };
    if (!backendIds().includes(query.backend))
      return {
        ...base,
        models: [],
        state: 'unavailable',
        error: '未知后端'
      };
    try {
      const backend = deps.backendFor(query.backend);
      const [status] = await probeBackends([backend]);
      if (!status?.probe?.ok)
        return {
          ...base,
          models: [],
          state: 'unavailable',
          error: '后端当前不可用，请检查安装或登录状态'
        };
      return {
        ...base,
        models: await backend.listModels(),
        state: 'fallback'
      };
    }
    catch {
      return {
        ...base,
        models: [],
        state: 'unavailable',
        error: '后端模型列表暂时不可用'
      };
    }
  }
  /** Returns the selection to store. A hand-typed id (`custom`, 3.11) is never
   * checked against the catalog, only by parseModelId (and stored trimmed), and its
   * effort only against the backend protocol; `allowCustom` is off where hand-typed
   * ids are not offered (comments). */
  async function validateSelection(backend: string, value: T.ModelSelection, allowCustom = false): Promise<T.ModelSelection> {
    if (!backendIds().includes(backend))
      throw new SettingsInputError('未知后端');
    if (value.kind === 'default')
      return value;
    if (value.custom) {
      if (!allowCustom)
        throw new SettingsInputError('这里不能手填模型 ID');
      const parsed = parseModelId(value.model);
      if (!parsed.ok)
        throw new SettingsInputError(parsed.message);
      if (!getSessionTitleEfforts(backend).includes(value.effort))
        throw new SettingsInputError('当前后端不支持这个推理强度');
      return { ...value, model: parsed.id };
    }
    const catalog = await models({
      botId,
      backend,
      purpose: 'project'
    });
    const model = catalog.models.find(item => item.id === value.model);
    if (!model || model.hidden || !model.supportedEfforts.includes(value.effort))
      throw new SettingsInputError('模型或推理强度不在当前后端支持列表中，请刷新模型列表');
    return value;
  }
  /** Returns what to store, or nothing for `default` (design 2.4). A group's setting must be for the
   * group's backend, or the judge would ignore it; the bot's is for Codex unless it says otherwise. */
  async function validateJudgeSelection(value: T.JudgeSelection, groupBackend?: string): Promise<JudgeSelectionStored | undefined> {
    if (value.kind === 'default')
      return undefined;
    const backend = value.backend ?? groupBackend ?? DEFAULT_BACKEND_ID;
    if (!backendIds().includes(backend))
      throw new SettingsInputError('未知后端');
    if (groupBackend && backend !== groupBackend) {
      const name = deps.backendFor(groupBackend).displayName;
      throw new SettingsInputError(`这个群用 ${name}，判断模型要选 ${name} 的模型`);
    }
    if (value.custom) {
      const parsed = parseModelId(value.model);
      if (!parsed.ok)
        throw new SettingsInputError(parsed.message);
      if (value.effort && !getSessionTitleEfforts(backend).includes(value.effort))
        throw new SettingsInputError('当前后端不支持这个推理强度');
      return { kind: 'llm', backend, model: parsed.id, ...(value.effort ? { effort: value.effort } : {}), custom: true };
    }
    const catalog = await models({ botId, backend, purpose: 'judge' });
    const model = catalog.models.find(item => item.id === value.model && !item.hidden);
    if (!model)
      throw new SettingsInputError('列表里没有这个模型；手填的 id 加 "custom":true');
    if (value.effort && !model.supportedEfforts.includes(value.effort))
      throw new SettingsInputError(model.supportedEfforts.length ? '这个模型不支持这个推理强度' : '这个模型不支持推理强度，effort 不能写');
    return { kind: 'llm', backend, model: model.id, ...(value.effort ? { effort: value.effort } : {}) };
  }
  const peekModels = (id: string) => {
    try {
      return deps.backendFor(id).peekModels?.();
    }
    catch {
      return undefined;
    }
  };
  /** What a group on `backend` judges with, as a selection (design 2.5). */
  function judgeEffective(backend: string, layers: { group?: JudgeSelectionStored; bot?: JudgeSelectionStored }): T.AgentSections['judge'] {
    const { model, effort } = resolveJudgeModel(backend, layers, peekModels(backend));
    return { selection: { kind: 'llm', backend, model, ...(effort ? { effort } : {}) } };
  }
  /** SMART.md of the bot (no chatId) or the group, with the read-only parts around it. */
  async function smartPromptView(chatId: string | undefined, codex: boolean): Promise<T.SmartPromptView> {
    const fixed = { formatLines: { ...JUDGE_FORMAT_LINES }, inputExample: JUDGE_INPUT_EXAMPLE, maxLength: SMART_MAX_CHARS, ...(codex ? { backendNote: JUDGE_CODEX_NOTE } : {}) };
    try {
      return { ...await (deps.readSmartPrompt ?? readSmartPrompt)(botId, chatId), ...fixed };
    }
    catch (error) {
      const known = error instanceof SmartPromptError;
      return { source: 'default', path: known && error.path || '', text: '', ...fixed, error: known ? error.message : '读不了 SMART.md' };
    }
  }
  async function effectiveSelection(backend: string, model?: string, effort?: ReasoningEffort, custom?: boolean): Promise<T.ModelSelection> {
    if (access.kind !== 'writable' || custom && model)
      return selection(model, effort, custom);
    const catalog = await models({
      botId,
      backend,
      purpose: 'project'
    });
    const preferred = model ? catalog.models.find(item => item.id === model && !item.hidden) : undefined;
    const chosen = preferred ?? catalog.models.find(item => item.isDefault && !item.hidden) ?? catalog.models.find(item => !item.hidden);
    if (!chosen)
      return selection(model, effort);
    return {
      kind: 'explicit',
      model: chosen.id,
      effort: preferred && effort && preferred.supportedEfforts.includes(effort) ? effort : chosen.defaultEffort
    };
  }
  async function read(scope: T.SettingsScope): Promise<T.SettingsView> {
    own(scope);
    if (scope.kind === 'agent') {
      const data = agentData(cfg);
      const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, makeSection(value, [botId, agentRaw(cfg.preferences ?? {}, key as keyof T.AgentSections)], access, agentEffects[key as keyof T.AgentSections])])) as T.AgentSettingsView['sections'];
      sections.paths.effective = {
        projectsRootDir: resolveProjectsRootDir(cfg.preferences?.projectsRootDir)
      };
      sections.comments.effective = {
        backend: data.comments.backend,
        selection: await effectiveSelection(data.comments.backend, cfg.preferences?.comments?.model, cfg.preferences?.comments?.effort)
      };
      sections.run.effective = {
        ...sections.run.stored,
        maxConcurrentRuns: runningConcurrency
      };
      const botJudge = storedJudge(cfg.preferences?.judge);
      sections.judge.effective = judgeEffective(botJudge?.backend ?? DEFAULT_BACKEND_ID, { bot: botJudge });
      const judgeByBackend: NonNullable<T.AgentSettingsView['judgeByBackend']> = {};
      for (const id of backendIds()) {
        const { model, effort, modelSource } = resolveJudgeModel(id, { bot: botJudge }, peekModels(id));
        judgeByBackend[id] = { model, ...(effort ? { effort } : {}), source: modelSource === 'bot' ? 'bot' : 'default' };
      }
      const text = await instructions.read();
      return {
        scope,
        sections,
        ownerOpenId: resolveOwner(cfg) ?? null,
        administrators: {
          openIds: [...(cfg.preferences?.access?.admins ?? [])],
          revision: settingsRevision([botId, resolveOwner(cfg), cfg.preferences?.access?.admins ?? []])
        },
        voice: voiceView(cfg),
        commentInstructions: {
          content: text === DEFAULT_COMMENT_INSTRUCTIONS ? {
            kind: 'default',
            text
          } : {
            kind: 'custom',
            text
          },
          revision: settingsRevision([botId, text]),
          maxEditLength: 30000
        },
        smartPrompt: await smartPromptView(undefined, true),
        judgeByBackend
      };
    }
    if (scope.kind === 'project') {
      const p = await readProject(scope.projectName);
      if (!p)
        throw new SettingsInputError('项目不存在');
      const data = projectData(p);
      const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, makeSection(value, [botId, projectRaw(p, key as keyof T.ProjectSections)], access, effect(Object.keys(value), key === 'model' ? 'new-session' : key === 'permission' ? 'session-rebind' : 'next-message', key === 'model' ? '仅新会话使用项目默认模型' : key === 'judge' ? agentEffects.judge[0]!.detail : key === 'run' && p.backend === 'claude-agent' ? 'Claude 不支持插话，运行中来的消息照样排队' : '下一条消息生效'))])) as T.ProjectSettingsView['sections'];
      const backendId = p.backend ?? DEFAULT_BACKEND_ID;
      sections.run.effective = { pendingPolicy: pendingPolicyOf(getPendingPolicy(cfg), p) };
      sections.model.effective = {
        selection: await effectiveSelection(backendId, p.defaultModel, p.defaultEffort, p.defaultModelCustom)
      };
      sections.judge.effective = judgeEffective(backendId, { group: storedJudge(p.judge), bot: storedJudge(cfg.preferences?.judge) });
      const fullOnly = deps.backendFor(backendId).fullAccessOnly?.();
      return {
        scope,
        sections,
        identity: {
          chatId: p.chatId,
          backend: backendId,
          cwd: p.cwd,
          kind: ruleKind(p),
          ...(fullOnly ? { fullOnly } : {})
        },
        members: {
          openIds: [...(p.allowedUsers ?? [])],
          revision: settingsRevision([botId, p.name, p.chatId, p.allowedUsers ?? []])
        },
        smartPrompt: await smartPromptView(p.chatId, backendId === 'codex-appserver')
      };
    }
    if (scope.kind === 'session') {
      if (isRetiredKey(scope.threadId))
        throw new SettingsInputError(RETIRED_KEY_TEXT);
      const s = await readSession(scope.threadId);
      if (!s)
        throw new SettingsInputError('会话不存在或已被删除');
      const project = (await (deps.listProjects ?? listProjects)()).find(p => p.chatId === s.chatId);
      return {
        scope,
        sections: {
          model: makeSection({
            selection: selection(s.model, s.effort, s.modelCustom)
          }, [botId, sessionRaw(s)], access, effect(['selection'], 'next-turn', '下一轮对话使用新模型'))
        },
        identity: {
          backend: s.backend,
          sessionId: s.sessionId,
          chatId: s.chatId,
          projectName: project?.name ?? null
        }
      };
    }
    throw new SettingsInputError('安装设置由 Host 管理');
  }
  async function sectionView(edit: T.BotSettingsEdit): Promise<T.SettingsSectionView> {
    const view = await read(edit.scope);
    if (view.scope.kind !== edit.scope.kind || !(edit.section in view.sections))
      throw new SettingsInputError('无效设置分区');
    return {
      scope: edit.scope,
      section: edit.section,
      value: view.sections[edit.section as keyof typeof view.sections]
    } as T.SettingsSectionView;
  }
  async function save(input: T.SettingsEdit): Promise<T.SettingsSave> {
    const parsed = parseSettingsEdit(input);
    own(parsed.scope);
    if (access.kind !== 'writable')
      return {
        kind: 'unavailable',
        reason: access
      };
    if (parsed.scope.kind === 'host')
      throw new SettingsInputError('安装设置由 Host 管理');
    const edit = parsed as T.BotSettingsEdit;
    let additionalEffects: T.ApplyEffect[] = [];
    try {
      if (edit.scope.kind === 'agent') {
        const e = edit as Extract<T.BotSettingsEdit, {
          section: keyof T.AgentSections;
        }>;
        await deps.writePreferences(async (p) => {
          check([botId, agentRaw(p, e.section as keyof T.AgentSections)], e.revision);
          switch (e.section) {
            case 'cards':
              Object.assign(p, e.patch);
              break;
            case 'run':
              Object.assign(p, e.patch);
              break;
            case 'completion':
              p.completionReminder = {
                ...p.completionReminder,
                ...e.patch
              };
              break;
            case 'comments': {
              const backend = e.patch.backend ?? p.comments?.backend ?? DEFAULT_BACKEND_ID;
              const choice = e.patch.selection ?? selection(p.comments?.model, p.comments?.effort);
              await validateSelection(backend, choice);
              p.comments = {
                ...p.comments,
                backend
              };
              applySelection(p.comments, choice);
              break;
            }
            case 'titles': {
              const [entry] = Object.entries(e.patch.byBackend ?? {});
              if (!entry)
                throw new SettingsInputError('请选择一个后端');
              const [id, policy] = entry;
              if (!backendIds().includes(id) || policy.enabled && !getSessionTitleEfforts(id).includes(policy.effort))
                throw new SettingsInputError('标题后端或推理强度无效');
              p.sessionTitles = {
                ...p.sessionTitles,
                byBackend: {
                  ...p.sessionTitles?.byBackend,
                  [id]: {
                    ...p.sessionTitles?.byBackend?.[id],
                    ...policy
                  }
                }
              };
              break;
            }
            case 'paths':
              if (e.patch.projectsRootDir === null)
                delete p.projectsRootDir;
              else if (e.patch.projectsRootDir !== undefined)
                p.projectsRootDir = e.patch.projectsRootDir;
              break;
            case 'access':
              p.access = {
                ...p.access,
                ...e.patch
              };
              break;
            case 'judge': {
              if (!e.patch.selection)
                throw new SettingsInputError('缺少模型选择');
              const chosen = await validateJudgeSelection(e.patch.selection);
              if (chosen)
                p.judge = chosen;
              else
                delete p.judge;
              break;
            }
            default: throw new SettingsInputError('无效 Agent 设置');
          }
        });
        if (e.section === 'completion')
          deps.refreshCompletionReminders?.();
      }
      else if (edit.scope.kind === 'project') {
        const e = edit as Extract<T.BotSettingsEdit, {
          scope: T.ProjectSettingsView['scope'];
        }>;
        const p = await changeProject(e.scope.projectName, async (p) => {
          check([botId, projectRaw(p, e.section)], e.revision);
          switch (e.section) {
            case 'permission': {
              const next = {
                ...p,
                ...e.patch
              };
              const backend = deps.backendFor(p.backend ?? DEFAULT_BACKEND_ID);
              const supported = backend.supportedModes;
              if (supported && !supported.includes(effectiveMode(next)))
                throw new SettingsInputError('后端不支持此权限档位');
              // Only the tier this save sets: a stored 只读 stays, and network can still change.
              const fullOnly = backend.fullAccessOnly?.();
              if (fullOnly && e.patch.mode !== undefined && e.patch.mode !== 'full')
                throw new SettingsInputError(fullOnly);
              Object.assign(p, e.patch);
              break;
            }
            case 'response':
              Object.assign(p, e.patch);
              break;
            case 'run':
              if (e.patch.pendingPolicy === 'default')
                delete p.pendingPolicy;
              else if (e.patch.pendingPolicy !== undefined)
                p.pendingPolicy = e.patch.pendingPolicy;
              break;
            case 'model': {
              if (!e.patch.selection)
                throw new SettingsInputError('缺少模型选择');
              const chosen = await validateSelection(p.backend ?? DEFAULT_BACKEND_ID, e.patch.selection, true);
              if (chosen.kind === 'default') {
                delete p.defaultModel;
                delete p.defaultEffort;
                delete p.defaultModelCustom;
              }
              else {
                p.defaultModel = chosen.model;
                p.defaultEffort = chosen.effort;
                p.defaultModelCustom = chosen.custom === true;
              }
              break;
            }
            case 'judge': {
              if (!e.patch.selection)
                throw new SettingsInputError('缺少模型选择');
              const chosen = await validateJudgeSelection(e.patch.selection, p.backend ?? DEFAULT_BACKEND_ID);
              if (chosen)
                p.judge = chosen;
              else
                delete p.judge;
            }
          }
        });
        if (e.section === 'permission') {
          try {
            await deps.evictLiveSessionsForChat(p.chatId);
          }
          catch {
            additionalEffects = effect([e.section], 'restart', '设置已保存，但活跃会话重新绑定失败。请重启 Host 使权限设置生效');
          }
        }
      }
      else {
        const e = edit as Extract<T.BotSettingsEdit, {
          scope: T.SessionSettingsView['scope'];
        }>;
        if (isRetiredKey(e.scope.threadId))
          throw new SettingsInputError(RETIRED_KEY_TEXT);
        await changeSession(e.scope.threadId, async (s) => {
          check([botId, sessionRaw(s)], e.revision);
          if (!e.patch.selection)
            throw new SettingsInputError('缺少模型选择');
          const chosen = await validateSelection(s.backend, e.patch.selection, true);
          applySelection(s, chosen);
          if (chosen.kind === 'default')
            delete s.modelCustom;
          else
            s.modelCustom = chosen.custom === true;
        });
      }
      const section = await sectionView(edit);
      return {
        kind: 'saved',
        section,
        effects: [...section.value.apply.filter(item => item.fields.some(field => Object.hasOwn(edit.patch, field))), ...additionalEffects]
      };
    }
    catch (error) {
      if (error instanceof Conflict)
        return {
          kind: 'conflict',
          current: await sectionView(edit)
        };
      return rejected(error);
    }
  }
  async function performAction(action: T.SettingsAction): Promise<T.SettingsActionResult> {
    own({
      kind: 'agent',
      botId: action.botId
    });
    if (access.kind !== 'writable')
      return {
        kind: 'unavailable',
        reason: access
      };
    const scope: T.AgentSettingsView['scope'] | T.ProjectSettingsView['scope'] = action.kind === 'projectMember' || action.kind === 'projectAudience' ? {
      kind: 'project',
      botId,
      projectName: action.projectName
    } : {
      kind: 'agent',
      botId
    };
    const actionView = async () => await read(scope) as T.AgentSettingsView | T.ProjectSettingsView;
    const warnings: string[] = [];
    try {
      switch (action.kind) {
        case 'voice':
          if (!deps.voiceAction)
            return {
              kind: 'unavailable',
              reason: offlineSettings
            };
          await deps.voiceAction(action.action);
          break;
        case 'adminMember':
          await deps.writePreferences(p => {
            check([botId, resolveOwner(cfg), p.access?.admins ?? []], action.revision);
            if (action.openId === resolveOwner(cfg) && action.membership === 'absent')
              throw new SettingsInputError('所有者不可移除');
            const admins = new Set(p.access?.admins ?? []);
            if (action.membership === 'present')
              admins.add(action.openId);
            else
              admins.delete(action.openId);
            p.access = {
              ...p.access,
              admins: [...admins]
            };
          });
          break;
        case 'projectAudience':
        case 'projectMember':
          await changeProject(action.projectName, p => {
            check([botId, p.name, p.chatId, p.allowedUsers ?? []], action.revision);
            const members = new Set(p.allowedUsers ?? []);
            if (action.kind === 'projectAudience')
              members.clear();
            else if (action.membership === 'present')
              members.add(action.openId);
            else
              members.delete(action.openId);
            p.allowedUsers = [...members];
          });
          break;
        case 'commentInstructions': {
          const current = await instructions.read();
          check([botId, current], action.revision);
          const text = action.content.kind === 'default' ? DEFAULT_COMMENT_INSTRUCTIONS : action.content.text;
          await instructions.save(text);
          try {
            await instructions.sync(text);
          }
          catch {
            warnings.push('回复规则已保存，但部分历史评论目录同步失败。可再次保存重试；新评论仍使用新规则');
          }
        }
      }
      return {
        kind: 'saved',
        view: await actionView(),
        effects: effect([], action.kind === 'commentInstructions' ? 'new-comment' : 'immediate', '设置已保存'),
        warnings
      };
    }
    catch (error) {
      if (error instanceof Conflict)
        return {
          kind: 'conflict',
          view: await actionView()
        };
      return rejected(error);
    }
  }
  return {
    read,
    save,
    models,
    act(input) {
      const action = parseSettingsAction(input);
      const result = actionChain.then(() => performAction(action));
      actionChain = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}
