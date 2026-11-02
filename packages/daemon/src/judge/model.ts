import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultCodexDecisionEffort, defaultCodexDecisionModel } from '@vonvon/protocol';
import { claudeConfigDir, readClaudeUserSettings } from '../agent/claude-agent/configured-model';
import { parseModelId } from '../agent/model-id';
import { acceptsBackendEffort } from '../config/schema';
import { REASONING_EFFORTS, type ModelInfo, type ReasoningEffort } from '../agent/types';
import { decisionProvider } from './decision';
import type { JudgeResult, JudgeSelectionStored } from './types';
import { defaultJudgeProvider, JUDGE_PROVIDERS, readJudgeModelsSync, type JudgeProvider, type JudgeModels } from './global-models';

// Group choices use their own decision backend. Legacy Bot inheritance remains backend-scoped.

export const CODEX_JUDGE_MODEL = defaultCodexDecisionModel();
export const CLAUDE_JUDGE_MODEL = 'haiku';
const CLAUDE_BACKEND_ID = 'claude-agent';

/**
 * The effort a Codex judgement sends when none was chosen: disable thinking when supported,
 * otherwise low. Only models that support neither use their lowest supported level. Hand-typed
 * ids and unavailable catalogs keep the key absent, except the known Luna low fallback.
 */
export function judgeEffort(model: string, models: ModelInfo[] | undefined, custom = false): ReasoningEffort | undefined {
  const info = models?.find((m) => m.id === model);
  return defaultCodexDecisionEffort(model, info?.supportedEfforts, custom);
}

/** Prefer the small Luna model. Once discovery has a visible catalog, choose only from it. */
export function codexJudgeDefault(models: ModelInfo[] | undefined): { model: string; effort?: ReasoningEffort } {
  const model = defaultCodexDecisionModel(models);
  const effort = judgeEffort(model, models);
  return effort ? { model, effort } : { model };
}

function envValue(key: string, settingsEnv: Record<string, string | undefined>, processEnv: NodeJS.ProcessEnv): string | undefined {
  return settingsEnv[key]?.trim() || processEnv[key]?.trim() || undefined;
}

/**
 * The Claude judge model: the `haiku` alias, which the CLI resolves to the current Haiku (or
 * ANTHROPIC_DEFAULT_HAIKU_MODEL). Only a gateway, ANTHROPIC_BASE_URL on a host other than
 * api.anthropic.com, uses its own model: its small-fast model, else the configured one. A claude.ai
 * user with `"model":"opus"` in settings still judges on Haiku: one call per group message on Opus
 * would cost an order of magnitude more (product.md 3.4 控制成本).
 */
export function claudeJudgeDefault(
  settingsEnv: Record<string, string | undefined>,
  processEnv: NodeJS.ProcessEnv,
  configuredModel: string | undefined,
): string {
  const baseUrl = envValue('ANTHROPIC_BASE_URL', settingsEnv, processEnv);
  if (!baseUrl) return CLAUDE_JUDGE_MODEL;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // not a URL: the CLI cannot reach a gateway with it either, so judge as without one
    return CLAUDE_JUDGE_MODEL;
  }
  if (host === 'api.anthropic.com') return CLAUDE_JUDGE_MODEL;
  if (envValue('ANTHROPIC_DEFAULT_HAIKU_MODEL', settingsEnv, processEnv)) return CLAUDE_JUDGE_MODEL;
  return envValue('ANTHROPIC_SMALL_FAST_MODEL', settingsEnv, processEnv) ?? configuredModel ?? CLAUDE_JUDGE_MODEL;
}

export type ClaudeUserSettings = typeof readClaudeUserSettings;

let claudeSettingsCache: { key: string; value: ReturnType<ClaudeUserSettings> } | undefined;

/** {@link readClaudeUserSettings}, read again only when settings.json's path, size or mtime (or the
 * daemon's ANTHROPIC_MODEL) changed: a stat per judgement instead of a read and parse, and an edit
 * still applies without a restart. */
export function cachedClaudeUserSettings(env: NodeJS.ProcessEnv = process.env, home = homedir()): ReturnType<ClaudeUserSettings> {
  const file = join(claudeConfigDir(env, home), 'settings.json');
  let stamp = 'missing';
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat) stamp = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    stamp = 'unreadable';
  }
  const key = `${file}\n${stamp}\n${env.ANTHROPIC_MODEL ?? ''}`;
  if (claudeSettingsCache?.key !== key) claudeSettingsCache = { key, value: readClaudeUserSettings(env, home) };
  return claudeSettingsCache.value;
}

/** The backend's default small model. Claude passes no effort: the backend turns thinking off.
 * `readClaude` reads ~/.claude/settings.json, again only once it changed (tests inject it). */
export function defaultJudgeModel(
  backendId: string,
  models: ModelInfo[] | undefined,
  readClaude: ClaudeUserSettings = cachedClaudeUserSettings,
): { model: string; effort?: ReasoningEffort } {
  if (backendId === CLAUDE_BACKEND_ID) {
    const settings = readClaude();
    return { model: claudeJudgeDefault(settings.env, process.env, settings.configuredModel) };
  }
  return codexJudgeDefault(models);
}

/** A decision model's provider id; which providers exist is s23f's registry, not checked here. */
export const DECISION_PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * A chosen effort fitted to the model (Rakazo 第二轮 A6): when the cached list has the model, the
 * same level if it takes it, else the nearest lower (a judgement stays cheap), else the nearest
 * higher; none when it takes no effort. A hand-typed id, a model the list lacks, and every model
 * before the list is cached pass as stored, so an unreadable list never drops a chosen effort.
 */
export function fitJudgeEffort(model: string, effort: ReasoningEffort, models: ModelInfo[] | undefined, custom = false): ReasoningEffort | undefined {
  const info = custom ? undefined : models?.find((m) => m.id === model);
  if (!info || info.supportedEfforts.includes(effort)) return effort;
  const at = (REASONING_EFFORTS as readonly string[]).indexOf(effort);
  if (at < 0) return info.supportedEfforts[0];
  const fits = (level: ReasoningEffort): boolean => info.supportedEfforts.includes(level);
  return REASONING_EFFORTS.slice(0, at).reverse().find(fits) ?? REASONING_EFFORTS.slice(at + 1).find(fits);
}

/**
 * A stored judge setting as read back (design 2.1): `{}` when unset, `{ why }` when it cannot be
 * used (hand-edited config.json or projects.json, or a kind from a newer vonvon), which then counts
 * as unset. A decision model is checked for its shape only.
 */
export function parseStoredJudge(value: unknown, backends: readonly string[]): { value?: JudgeSelectionStored; why?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { why: '不是对象' };
  const v = value as Record<string, unknown>;
  if (v.kind === 'default') return Object.keys(v).length === 1 ? { value: { kind: 'default' } } : { why: '默认决策设置有多余字段' };
  if (v.kind === 'provider') {
    if (typeof v.provider !== 'string' || !JUDGE_PROVIDERS.includes(v.provider as JudgeProvider)) return { why: '不认识决策 Provider' };
    return { value: { kind: 'provider', provider: v.provider as JudgeProvider } };
  }
  if (v.kind === 'decision') {
    if (typeof v.provider !== 'string' || !DECISION_PROVIDER_ID.test(v.provider)) return { why: '决策模型的 provider 不对' };
    const id = typeof v.model === 'string' ? parseModelId(v.model) : undefined;
    if (!id?.ok) return { why: '模型 id 不对' };
    return { value: { kind: 'decision', provider: v.provider, model: id.id } };
  }
  if (v.kind !== 'llm') return { why: `不认识的 kind ${String(v.kind).slice(0, 40)}` };
  if (typeof v.backend !== 'string' || !backends.includes(v.backend)) return { why: '后端没注册' };
  const id = typeof v.model === 'string' ? parseModelId(v.model) : undefined;
  if (!id?.ok) return { why: '模型 id 不对' };
  // per backend, as the settings command checks a hand-typed id: Claude takes only low to max
  if (v.effort !== undefined && !acceptsBackendEffort(v.backend, v.effort)) return { why: '推理强度这个后端不收' };
  if (v.custom !== undefined && typeof v.custom !== 'boolean') return { why: 'custom 不是 true 或 false' };
  return {
    value: {
      kind: 'llm', backend: v.backend, model: id.id,
      ...(v.effort ? { effort: v.effort as ReasoningEffort } : {}), ...(v.custom ? { custom: true as const } : {}),
    },
  };
}

/**
 * The model for a group: its independent decision choice, else the Bot's setting on the task
 * backend, else the default small model. Legacy host references are resolved until snapshotted.
 * A decision model applies on every backend (product.md 3.4). A chosen effort is fitted to the model
 * ({@link fitJudgeEffort}); a setting without one gets the default rule: Codex thinking off when
 * supported, otherwise low (or a supported fallback), Claude none (thinking off).
 */
export function resolveJudgeModel(
  backendId: string,
  layers: { group?: JudgeSelectionStored; bot?: JudgeSelectionStored },
  models: ModelInfo[] | undefined,
  readClaude?: ClaudeUserSettings,
  globalRoot?: string,
  globalModels?: JudgeModels,
): Pick<JudgeResult, 'model' | 'effort' | 'provider' | 'modelSource'> {
  for (const source of ['group', 'bot'] as const) {
    const chosen = layers[source];
    if (chosen?.kind === 'provider' || chosen?.kind === 'default') {
      const stored = globalModels ?? readJudgeModelsSync(globalRoot);
      const provider = chosen.kind === 'default' ? defaultJudgeProvider(stored) : chosen.provider;
      const selected = stored.byProvider[provider];
      const modelSource = chosen.kind === 'default' ? 'default' : source;
      const decision = decisionProvider(provider);
      if (decision) return { model: selected?.model ?? decision.models[0]!.id, provider, modelSource };
      if (!selected) return { ...defaultJudgeModel(provider, models, readClaude), modelSource };
      const effort = selected.effort ? fitJudgeEffort(selected.model, selected.effort, models, selected.custom)
        : provider === CLAUDE_BACKEND_ID ? undefined : judgeEffort(selected.model, models, selected.custom);
      return { model: selected.model, ...(effort ? { effort } : {}), modelSource };
    }
    if (chosen?.kind === 'decision') return { model: chosen.model, provider: chosen.provider, modelSource: source };
    if (!chosen || (source === 'bot' && chosen.backend !== backendId)) continue;
    const effort = chosen.effort ? fitJudgeEffort(chosen.model, chosen.effort, models, chosen.custom)
      : chosen.backend === CLAUDE_BACKEND_ID ? undefined : judgeEffort(chosen.model, models, chosen.custom);
    return { model: chosen.model, ...(effort ? { effort } : {}), modelSource: source };
  }
  return { ...defaultJudgeModel(backendId, models, readClaude), modelSource: 'default' };
}

/** The group may judge with another provider than the one running its tasks. */
export function judgeBackendId(taskBackend: string, group: JudgeSelectionStored | undefined, globalRoot?: string, globalModels?: JudgeModels): string {
  if (group?.kind === 'default') {
    const provider = defaultJudgeProvider(globalModels ?? readJudgeModelsSync(globalRoot));
    return decisionProvider(provider) ? taskBackend : provider;
  }
  return group?.kind === 'llm' ? group.backend : group?.kind === 'provider' && !decisionProvider(group.provider) ? group.provider : taskBackend;
}
