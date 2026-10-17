import { readClaudeUserSettings } from '../agent/claude-agent/configured-model';
import { parseModelId } from '../agent/model-id';
import { getSessionTitleEfforts } from '../config/schema';
import { REASONING_EFFORTS, type ModelInfo, type ReasoningEffort } from '../agent/types';
import type { JudgeResult, JudgeSelectionStored } from './types';

// Which model judges (design 2.2, 2.3): the group's setting, else the bot's, each only for the
// backend it was stored for, else the backend's default small model.

export const CODEX_JUDGE_MODEL = 'gpt-6-luna';
/** gpt-6-luna's lowest effort (JP-VPS models_cache, client 0.163.0, 2026-10-16: low to max, no minimal). */
const CODEX_JUDGE_EFFORT: ReasoningEffort = 'low';
export const CLAUDE_JUDGE_MODEL = 'haiku';
const CLAUDE_BACKEND_ID = 'claude-agent';

/**
 * The effort a Codex judgement sends when none was chosen: the lowest the cached list gives the
 * model; none for a model that supports no effort, for a hand-typed id (a gateway model may refuse
 * the key) and for a listed model while the list is not cached yet. The default gpt-6-luna is known
 * to start at `low`, so it gets that without the list.
 */
export function judgeEffort(model: string, models: ModelInfo[] | undefined, custom = false): ReasoningEffort | undefined {
  if (custom) return undefined;
  const info = models?.find((m) => m.id === model);
  if (!info) return model === CODEX_JUDGE_MODEL ? CODEX_JUDGE_EFFORT : undefined;
  return REASONING_EFFORTS.find((effort) => info.supportedEfforts.includes(effort));
}

/** gpt-6-luna; when the cached list lacks it but has another `*-luna`, the first of those. */
export function codexJudgeDefault(models: ModelInfo[] | undefined): { model: string; effort?: ReasoningEffort } {
  const listed = models?.some((m) => m.id === CODEX_JUDGE_MODEL);
  const model = models && !listed ? models.find((m) => m.id.endsWith('-luna'))?.id ?? CODEX_JUDGE_MODEL : CODEX_JUDGE_MODEL;
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

/** The backend's default small model. Claude passes no effort: the backend turns thinking off.
 * `readClaude` reads ~/.claude/settings.json once (tests inject it). */
export function defaultJudgeModel(
  backendId: string,
  models: ModelInfo[] | undefined,
  readClaude: ClaudeUserSettings = readClaudeUserSettings,
): { model: string; effort?: ReasoningEffort } {
  if (backendId === CLAUDE_BACKEND_ID) {
    const settings = readClaude();
    return { model: claudeJudgeDefault(settings.env, process.env, settings.configuredModel) };
  }
  return codexJudgeDefault(models);
}

/**
 * A stored judge setting as read back (design 2.1): `{}` when unset, `{ why }` when it cannot be
 * used (hand-edited config.json or projects.json), which then counts as unset.
 */
export function parseStoredJudge(value: unknown, backends: readonly string[]): { value?: JudgeSelectionStored; why?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { why: '不是对象' };
  const v = value as Record<string, unknown>;
  if (v.kind !== 'llm') return { why: `不认识的 kind ${String(v.kind).slice(0, 40)}` };
  if (typeof v.backend !== 'string' || !backends.includes(v.backend)) return { why: '后端没注册' };
  const id = typeof v.model === 'string' ? parseModelId(v.model) : undefined;
  if (!id?.ok) return { why: '模型 id 不对' };
  // per backend, as the settings command checks a hand-typed id: Claude takes only low to max
  if (v.effort !== undefined && !(getSessionTitleEfforts(v.backend) as readonly unknown[]).includes(v.effort)) return { why: '推理强度这个后端不收' };
  if (v.custom !== undefined && typeof v.custom !== 'boolean') return { why: 'custom 不是 true 或 false' };
  return {
    value: {
      kind: 'llm', backend: v.backend, model: id.id,
      ...(v.effort ? { effort: v.effort as ReasoningEffort } : {}), ...(v.custom ? { custom: true as const } : {}),
    },
  };
}

/**
 * The model for a group on backend `backendId` (design 2.2): the group's setting when stored for
 * this backend, else the bot's when stored for it, else the default small model. A setting without
 * an effort gets the default rule (2.3): Codex the lowest the list gives, Claude none (thinking off).
 */
export function resolveJudgeModel(
  backendId: string,
  layers: { group?: JudgeSelectionStored; bot?: JudgeSelectionStored },
  models: ModelInfo[] | undefined,
  readClaude?: ClaudeUserSettings,
): Pick<JudgeResult, 'model' | 'effort' | 'modelSource'> {
  for (const source of ['group', 'bot'] as const) {
    const chosen = layers[source];
    if (chosen?.backend !== backendId) continue;
    const effort = chosen.effort ?? (backendId === CLAUDE_BACKEND_ID ? undefined : judgeEffort(chosen.model, models, chosen.custom));
    return { model: chosen.model, ...(effort ? { effort } : {}), modelSource: source };
  }
  return { ...defaultJudgeModel(backendId, models, readClaude), modelSource: 'default' };
}
