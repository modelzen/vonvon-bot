import { readClaudeUserEnv, readConfiguredClaudeModel } from '../agent/claude-agent/configured-model';
import { REASONING_EFFORTS, type ModelInfo, type ReasoningEffort } from '../agent/types';

// The judge model when nothing is set (design 2.3). s23c layers the bot and group settings on top.

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

function value(key: string, settingsEnv: Record<string, string | undefined>, processEnv: NodeJS.ProcessEnv): string | undefined {
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
  const baseUrl = value('ANTHROPIC_BASE_URL', settingsEnv, processEnv);
  if (!baseUrl) return CLAUDE_JUDGE_MODEL;
  let host: string | undefined;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = undefined;
  }
  if (host === 'api.anthropic.com') return CLAUDE_JUDGE_MODEL;
  if (value('ANTHROPIC_DEFAULT_HAIKU_MODEL', settingsEnv, processEnv)) return CLAUDE_JUDGE_MODEL;
  return value('ANTHROPIC_SMALL_FAST_MODEL', settingsEnv, processEnv) ?? configuredModel ?? CLAUDE_JUDGE_MODEL;
}

/** The backend's default small model. Claude passes no effort: the backend turns thinking off. */
export function defaultJudgeModel(backendId: string, models: ModelInfo[] | undefined): { model: string; effort?: ReasoningEffort } {
  if (backendId === CLAUDE_BACKEND_ID) {
    return { model: claudeJudgeDefault(readClaudeUserEnv(), process.env, readConfiguredClaudeModel()) };
  }
  return codexJudgeDefault(models);
}
