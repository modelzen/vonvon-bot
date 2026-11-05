import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Claude Code's user config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir || join(home, '.claude');
}

const accountConfig = z.object({
  oauthAccount: z.object({ accountUuid: z.string().nullish(), organizationUuid: z.string().nullish() }).nullish(),
  primaryApiKey: z.string().nullish(),
  customApiKeyResponses: z.unknown().optional(),
});

/** Claude rewrites its global config at every startup (feature flags, model caches,
 * usage counters). Only account identity and API-key configuration are inputs to
 * discovery; including the file's mtime makes a successful probe invalidate itself.
 * Keep secrets out of cache keys, and follow the CLI's custom/legacy config paths. */
export function claudeAccountConfigKey(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const legacy = join(claudeConfigDir(env, home), '.config.json');
  const file = existsSync(legacy) ? legacy : join(env.CLAUDE_CONFIG_DIR?.trim() || home, '.claude.json');
  try {
    const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    return JSON.stringify([file, createHash('sha256').update(JSON.stringify(accountConfig.parse(parsed))).digest('hex')]);
  } catch { return JSON.stringify([file, 'unreadable']); }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

/** The user settings.json, read once: its `env` block (string values only; the CLI copies it over
 * its own environment) and {@link readConfiguredClaudeModel}'s answer. The judge (s23c) needs both. */
export function readClaudeUserSettings(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { env: Record<string, string>; configuredModel: string | undefined } {
  let settings: { env?: unknown; model?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(claudeConfigDir(env, home), 'settings.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as typeof settings;
  } catch {
    // missing / unreadable / not JSON: fall through to the process env
  }
  const raw = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
  const settingsEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') settingsEnv[key] = value;
  return {
    env: settingsEnv,
    configuredModel: nonEmpty(settingsEnv.ANTHROPIC_MODEL) ?? nonEmpty(env.ANTHROPIC_MODEL) ?? nonEmpty(settings.model),
  };
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
  return readClaudeUserSettings(env, home).configuredModel;
}
