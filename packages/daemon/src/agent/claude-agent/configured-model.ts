import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Claude Code's user config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir || join(home, '.claude');
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

type UserSettings = { env?: Record<string, unknown>; model?: unknown };

/** The user settings.json; an unreadable or malformed file counts as empty. */
function readUserSettings(env: NodeJS.ProcessEnv, home: string): UserSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(claudeConfigDir(env, home), 'settings.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as UserSettings;
  } catch {
    // missing / unreadable / not JSON: fall through to the process env
  }
  return {};
}

function settingsEnvOf(settings: UserSettings): Record<string, unknown> {
  return settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
}

/**
 * The `env` block of the user settings.json, string values only (the CLI copies it over its own
 * environment). The judge (s23) reads `ANTHROPIC_BASE_URL` and the small-model variables from it.
 */
export function readClaudeUserEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settingsEnvOf(readUserSettings(env, home)))) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * The model Claude Code itself would start on when no `--model` is given, read
 * the way the CLI does for the user layer: `env.ANTHROPIC_MODEL` in the user
 * settings.json (the CLI copies that `env` over its own environment), then the
 * daemon's own `ANTHROPIC_MODEL`, then the settings' `model`. This is how
 * DeepSeek or Kimi users point Claude Code at their model.
 *
 * Needed because bot sessions always pass an explicit model: the SDK's
 * "default" row (and `setModel(undefined)`) resolves to the account default and
 * ignores ANTHROPIC_MODEL, measured on SDK 0.3.296. Managed and project settings
 * are not read; an unreadable or malformed file counts as unset.
 */
export function readConfiguredClaudeModel(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | undefined {
  const settings = readUserSettings(env, home);
  const settingsEnv = settingsEnvOf(settings);
  return nonEmpty(settingsEnv.ANTHROPIC_MODEL) ?? nonEmpty(env.ANTHROPIC_MODEL) ?? nonEmpty(settings.model);
}
