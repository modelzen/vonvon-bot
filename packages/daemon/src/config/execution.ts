import { realpath } from 'node:fs/promises';
import type { SessionProfile } from '../agent/session-profile';
import { admitDirectorySettings } from './directories';
import { paths } from './paths';
import { catalogById } from '../agent/catalog';
import { permissionTable } from '../agent/permission';
import { TIER_NETWORK, type Tier, type PermissionEffect } from '../agent/permission/types';
import { DEFAULT_BACKEND_ID, type PermissionMode, type ReasoningEffort, type ModelInfo } from '../agent/types';
import { effectiveMode, type Project, type ProjectModelAccess } from '../project/registry';
import { resolveBotDefaults } from './defaults';
import type { AppPreferences, PendingPolicy } from './schema';
import { log } from '../core/logger';

// What a session actually runs with (product.md 3.2, s36d2): one place reads the bot defaults
// (`preferences.defaults`, `preferences.directories`) and a group's row together. No config reads
// or model list; invalid native settings only emit a warning once per group. A group's tier,
// network and backend are written when it is set up and never
// follow the bot defaults (3.2, 3.8, 3.11); the bot defaults are for places with no group
// (私聊 from s49). Callers check a model preference against the live list with pickDefault.

/** Where a value came from. */
export type ExecutionSource = 'group' | 'bot' | 'builtin';

/** The model a new session starts from, before pickDefault checks it against the live list. */
export interface ModelPreference {
  model: string;
  effort?: ReasoningEffort;
  /** A hand-typed id (3.11): used as is, not checked against the list. */
  custom: boolean;
  source: 'group' | 'bot' | 'comments';
}

export interface ResolvedExecution {
  backend: string;
  permission: PermissionMode;
  network: boolean;
  custom?: Record<string, unknown>;
  /** `primary` is the group's cwd; with no group, the bot's (undefined when it has none). */
  workspaces: { primary?: string; additional: string[] };
  repositories: string[];
  /** 运行中来了消息. Not by backend: a running Claude thread queues by itself (supportsSteer). */
  pendingPolicy: PendingPolicy;
  /** For a new session on {@link backend}; see {@link resolveModelPreference}. */
  model?: ModelPreference;
  sources: Record<'backend' | 'permission' | 'network' | 'workspaces' | 'repositories' | 'pendingPolicy', ExecutionSource>;
}

export type GroupLayer = Pick<Project,
  'backend' | 'mode' | 'network' | 'custom' | 'cwd' | 'directories' | 'pendingPolicy' | 'defaultModel' | 'defaultEffort' | 'defaultModelCustom' | 'modelAccess'> & Partial<Pick<Project, 'chatId'>>;
export type ExecutionLayers = { bot?: AppPreferences; group?: GroupLayer };

/** A backend id still in the catalog; a removed one counts as unset, as backendFor does. */
function known(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed && catalogById(trimmed) ? trimmed : undefined;
}

/** A group's backend: its own, else Codex (old rows). Never the bot default (3.2, 3.11). */
export function groupBackendId(group: Pick<Project, 'backend' | 'modelAccess'> | undefined): string {
  return known(group?.modelAccess?.backend ?? group?.backend) ?? DEFAULT_BACKEND_ID;
}

export interface GroupPermission {
  tier: Tier;
  custom?: Record<string, unknown>;
  legacy?: true;
  invalid?: true;
  effect: PermissionEffect;
}

type PermissionGroup = Pick<Project, 'mode' | 'network' | 'custom' | 'backend' | 'modelAccess'> & Partial<Pick<Project, 'chatId'>>;
const warnedInvalidCustom = new Set<string>();
const warnedAnonymousCustom = new WeakSet<object>();

function invalidGroupPermission(group: PermissionGroup): GroupPermission {
  const warned = group.chatId ? warnedInvalidCustom.has(group.chatId) : warnedAnonymousCustom.has(group);
  if (!warned) {
    if (group.chatId) warnedInvalidCustom.add(group.chatId);
    else warnedAnonymousCustom.add(group);
    // Rejected settings and parse errors can contain arbitrary private values.
    log.warn('permission', 'custom-invalid');
  }
  return { tier: 'qa', invalid: true, effect: { mode: 'qa', network: false } };
}

/** Read native settings or preserve a legacy tier/network pair without rewriting stored rows. */
export function groupPermission(group: PermissionGroup): GroupPermission {
  // Corrupt tiers must never become workspace-write through fromLegacy's fallback.
  if (group.mode !== undefined && group.mode !== 'qa' && group.mode !== 'write' && group.mode !== 'full') {
    return { tier: 'qa', effect: { mode: 'qa', network: false } };
  }
  const tier = effectiveMode(group);
  const backend = groupBackendId(group);
  const table = permissionTable(backend);
  if (group.custom?.backend === backend) {
    try {
      const settings = table.parseCustom(group.custom.settings);
      return { tier, custom: settings, effect: table.effect(settings) };
    } catch {
      return invalidGroupPermission(group);
    }
  }
  if (tier !== 'full' && group.network !== undefined && typeof group.network !== 'boolean') {
    return invalidGroupPermission(group);
  }
  const network = group.network ?? false;
  if (tier !== 'full' && network !== TIER_NETWORK[tier]) {
    try {
      const settings = table.fromLegacy(tier, network);
      return settings
        ? { tier, custom: settings, legacy: true, effect: table.effect(settings) }
        : { tier, effect: { mode: tier, network } };
    } catch {
      return invalidGroupPermission(group);
    }
  }
  return { tier, effect: { mode: tier, network: TIER_NETWORK[tier] } };
}

/** The bot's default backend: for places with no group, and for the bot's default model. */
export function botBackendId(bot: AppPreferences | undefined): string {
  return known(bot?.defaults?.backend) ?? DEFAULT_BACKEND_ID;
}

/**
 * The model a new session on `backendId` starts from: the group's default when the group's
 * backend is `backendId`, else the bot's default when the bot's default backend is (the bot's
 * model carries no backend, 3.2), else none (the backend's own default). An old session keeps
 * its record's backend, so a model meant for the other backend never reaches it. The backends
 * compared are the ones sessions run on and saves check against: a removed id counts as Codex.
 */
export function resolveModelPreference({ bot, group }: ExecutionLayers, backendId: string): ModelPreference | undefined {
  if (group?.modelAccess) {
    if (group.modelAccess.backend !== backendId) return undefined;
    const model = group.defaultModel && group.modelAccess.models.includes(group.defaultModel) ? group.defaultModel : group.modelAccess.models[0];
    return model ? { model, effort: group.defaultEffort && group.modelAccess.efforts.includes(group.defaultEffort) ? group.defaultEffort : group.modelAccess.efforts[0], custom: group.defaultModelCustom === true && model === group.defaultModel, source: 'group' } : undefined;
  }
  if (group?.defaultModel && groupBackendId(group) === backendId) {
    return { model: group.defaultModel, effort: group.defaultEffort, custom: group.defaultModelCustom === true, source: 'group' };
  }
  const chosen = bot?.defaults?.model;
  if (chosen && botBackendId(bot) === backendId) {
    return { model: chosen.id, effort: chosen.effort, custom: chosen.kind === 'custom', source: 'bot' };
  }
  return undefined;
}

export function resolveExecution({ bot, group }: ExecutionLayers): ResolvedExecution {
  const defaults = resolveBotDefaults(bot?.defaults);
  const dirs = bot?.directories;
  const repositories = group?.directories?.repositories ?? dirs?.repositories;
  const botPolicy = bot?.pendingPolicy === 'queue' || bot?.pendingPolicy === 'steer' ? bot.pendingPolicy : undefined;
  const pendingPolicy = group?.pendingPolicy ?? botPolicy;
  const shared = {
    repositories: repositories ?? [],
    pendingPolicy: pendingPolicy ?? 'steer',
  };
  const sharedSources = {
    repositories: group?.directories?.repositories ? 'group' : dirs?.repositories ? 'bot' : 'builtin',
    pendingPolicy: group?.pendingPolicy ? 'group' : pendingPolicy ? 'bot' : 'builtin',
  } as const;
  if (group) {
    const backend = groupBackendId(group);
    const permission = groupPermission(group);
    const permissionSource: ExecutionSource = permission.custom || permission.invalid || group.mode ? 'group' : 'builtin';
    return {
      backend,
      permission: permission.effect.mode,
      network: permission.effect.network,
      ...(permission.custom ? { custom: permission.custom } : {}),
      // The group's own directory only, not the bot's other workspaces (v1-plan 第 5 节).
      workspaces: { primary: group.cwd, additional: group.directories?.workspaces?.additional ?? [] },
      ...shared,
      model: resolveModelPreference({ bot, group }, backend),
      sources: {
        backend: known(group.backend) ? 'group' : 'builtin',
        permission: permissionSource,
        network: permissionSource,
        workspaces: 'group',
        ...sharedSources,
      },
    };
  }
  const backend = botBackendId(bot);
  return {
    backend,
    permission: defaults.permission,
    network: defaults.network,
    workspaces: { primary: dirs?.workspaces?.primary, additional: dirs?.workspaces?.additional ?? [] },
    ...shared,
    model: resolveModelPreference({ bot }, backend),
    sources: {
      backend: known(bot?.defaults?.backend) ? 'bot' : 'builtin',
      permission: bot?.defaults?.permission ? 'bot' : 'builtin',
      network: bot?.defaults?.permission ? 'bot' : 'builtin',
      workspaces: dirs?.workspaces ? 'bot' : 'builtin',
      ...sharedSources,
    },
  };
}

/**
 * The 云文档评论 flow: the comment settings, else the bot default, else built in. The tier is not
 * set here: comments run without one (完全访问) until the owner decides otherwise (v1-plan s36d2).
 */
export function resolveCommentsExecution(bot: AppPreferences | undefined): { backend: string; model?: ModelPreference; source: 'comments' | 'bot' | 'builtin' } {
  const comments = bot?.comments;
  const own = known(comments?.backend);
  const backend = own ?? botBackendId(bot);
  const model: ModelPreference | undefined = comments?.model?.trim()
    ? { model: comments.model.trim(), effort: comments.effort, custom: false, source: 'comments' }
    : resolveModelPreference({ bot }, backend);
  return { backend, ...(model ? { model } : {}), source: own ? 'comments' : known(bot?.defaults?.backend) ? 'bot' : 'builtin' };
}

/** Add admitted execution roots without changing cwd, provider ownership or existing profile fields. */
export async function executionSessionProfile({ execution, cwd, backend, scope, profile, dataDir = paths.appDir }: {
  execution: Pick<ResolvedExecution, 'workspaces' | 'repositories' | 'permission'>;
  cwd: string;
  backend: string;
  scope: 'group' | 'ungrouped';
  profile?: SessionProfile;
  dataDir?: string;
}): Promise<SessionProfile | undefined> {
  // Both providers receive admitted workspace roots through their native session adapters.
  if (backend !== DEFAULT_BACKEND_ID && backend !== 'claude-agent') return profile;
  const [firstAdditional, ...otherAdditional] = execution.workspaces.additional;
  if ((scope === 'ungrouped' || backend === 'claude-agent') && firstAdditional === undefined && execution.repositories.length === 0) return profile;
  const actualCwd = await realpath(cwd);
  // Groups admit the real execution cwd, never a configured primary substituted for a
  // stored session's cwd. Comments retain their existing bot-owned per-document cwd.
  const workspaces = scope === 'group'
    ? { primary: actualCwd, additional: execution.workspaces.additional.filter(path => path !== actualCwd) }
    : firstAdditional === undefined ? undefined : { primary: firstAdditional, additional: otherAdditional };
  const admitted = await admitDirectorySettings({ ...(workspaces ? { workspaces } : {}), repositories: execution.repositories }, { dataDir });
  const roots = new Set([
    ...(admitted?.workspaces ? [admitted.workspaces.primary, ...admitted.workspaces.additional] : []),
    ...admitted?.repositories ?? [],
  ]);
  roots.delete(actualCwd);
  if (roots.size === 0) return profile;
  const access: 'read' | 'write' = execution.permission === 'qa' ? 'read' : 'write';
  const guidance = '用某个仓库或附加工作区前，先阅读那里适用的 AGENTS.md 或 CLAUDE.md；附加根不保证原生加载其说明文件。';
  const instructions = profile?.instructions ?? '';
  return {
    // The backend adds its fixed prefix once; preserve s38's assembled instructions/env.
    instructions: roots.size && !instructions.includes(guidance)
      ? [instructions, guidance].filter(Boolean).join('\n\n') : instructions,
    env: profile?.env ?? {},
    nativeSettings: { automaticMemory: false },
    additionalRoots: [...profile?.additionalRoots ?? [], ...[...roots].map(path => ({ path, access }))],
    capabilityPackages: profile?.capabilityPackages ?? [],
    mcpServers: profile?.mcpServers ?? [],
    ...(profile?.tools ? { tools: profile.tools } : {}),
    ...(profile?.skills ? { skills: profile.skills } : {}),
  };
}

/** Legacy rows keep their current defaults until the first explicit group save freezes them. */
export function resolveProjectModelAccess({ bot, group }: { bot?: AppPreferences; group: GroupLayer }, catalog: ModelInfo[] = []): ProjectModelAccess {
  if (group.modelAccess) return { ...group.modelAccess, models: [...group.modelAccess.models], efforts: [...group.modelAccess.efforts] };
  const backend = groupBackendId(group);
  const preferred = resolveModelPreference({ bot, group }, backend);
  const chosen = preferred?.model ?? catalog.find(m => m.isDefault && !m.hidden)?.id ?? catalog.find(m => !m.hidden)?.id;
  const info = catalog.find(m => m.id === chosen);
  return { backend, models: chosen ? [chosen] : [], efforts: preferred?.effort ? [preferred.effort] : info?.supportedEfforts ?? [] };
}

/** Both command pickers and the final provider call must enforce the same group allowset. */
export function projectModelAllowed(project: Pick<Project, 'modelAccess'> | undefined, backend: string, model: string | undefined, effort?: ReasoningEffort, catalog?: ModelInfo[]): boolean {
  const access = project?.modelAccess;
  if (!access) return true;
  if (backend !== access.backend || !model || !access.models.includes(model)) return false;
  const info = catalog?.find(m => m.id === model);
  if (info?.hidden) return false;
  if (info && info.supportedEfforts.length === 0) return true;
  return effort !== undefined && access.efforts.includes(effort) && (!info || info.supportedEfforts.includes(effort));
}
export function projectModelCatalog(project: Pick<Project, 'modelAccess'> | undefined, backend: string, catalog: ModelInfo[]): ModelInfo[] {
  const access = project?.modelAccess;
  if (!access) return catalog;
  if (backend !== access.backend) return [];
  return catalog.filter(model => !model.hidden && access.models.includes(model.id)).flatMap(model => {
    const supportedEfforts = model.supportedEfforts.filter(e => access.efforts.includes(e));
    if (model.supportedEfforts.length && !supportedEfforts.length) return [];
    return [{ ...model, supportedEfforts, defaultEffort: supportedEfforts.includes(model.defaultEffort) ? model.defaultEffort : supportedEfforts[0] ?? model.defaultEffort }];
  });
}
