import { catalogById } from '../agent/catalog';
import { DEFAULT_BACKEND_ID, type PermissionMode, type ReasoningEffort } from '../agent/types';
import { effectiveMode, type Project } from '../project/registry';
import { resolveBotDefaults } from './defaults';
import type { AppPreferences, PendingPolicy } from './schema';

// What a session actually runs with (product.md 3.2, s36d2): one place reads the bot defaults
// (`preferences.defaults`, `preferences.directories`) and a group's row together. Pure: no disk,
// no model list. A group's tier, network and backend are written when it is set up and never
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
  'backend' | 'mode' | 'network' | 'cwd' | 'directories' | 'pendingPolicy' | 'defaultModel' | 'defaultEffort' | 'defaultModelCustom'>;
export type ExecutionLayers = { bot?: AppPreferences; group?: GroupLayer };

/** A backend id still in the catalog; a removed one counts as unset, as backendFor does. */
function known(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed && catalogById(trimmed) ? trimmed : undefined;
}

/** A group's backend: its own, else Codex (old rows). Never the bot default (3.2, 3.11). */
export function groupBackendId(group: Pick<Project, 'backend'> | undefined): string {
  return known(group?.backend) ?? DEFAULT_BACKEND_ID;
}

/** The bot's default backend: for places with no group, and for the bot's default model. */
export function botBackendId(bot: AppPreferences | undefined): string {
  return known(bot?.defaults?.backend) ?? DEFAULT_BACKEND_ID;
}

/**
 * The model a new session on `backendId` starts from: the group's default when the group's
 * backend is `backendId`, else the bot's default when the bot's default backend is (the bot's
 * model carries no backend, 3.2), else none (the backend's own default). An old session keeps
 * its record's backend, so a model meant for the other backend never reaches it.
 */
export function resolveModelPreference({ bot, group }: ExecutionLayers, backendId: string): ModelPreference | undefined {
  if (group?.defaultModel && (group.backend ?? DEFAULT_BACKEND_ID) === backendId) {
    return { model: group.defaultModel, effort: group.defaultEffort, custom: group.defaultModelCustom === true, source: 'group' };
  }
  const chosen = bot?.defaults?.model;
  if (chosen && (bot?.defaults?.backend ?? DEFAULT_BACKEND_ID) === backendId) {
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
    return {
      backend,
      permission: effectiveMode(group),
      network: group.network ?? false,
      // The group's own directory only, not the bot's other workspaces (v1-plan 第 5 节).
      workspaces: { primary: group.cwd, additional: group.directories?.workspaces?.additional ?? [] },
      ...shared,
      model: resolveModelPreference({ bot, group }, backend),
      sources: {
        backend: known(group.backend) ? 'group' : 'builtin',
        permission: group.mode ? 'group' : 'builtin',
        network: group.network === undefined ? 'builtin' : 'group',
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
      network: bot?.defaults?.network === undefined ? 'builtin' : 'bot',
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
