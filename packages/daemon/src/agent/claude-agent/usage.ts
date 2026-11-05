import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { UsageError, type AccountUsageBundle, type RateWindow } from '../types';
import { claudeConfigDir, readClaudeUserSettings } from './configured-model';

const credentialsSchema = z.object({ claudeAiOauth: z.object({
  accessToken: z.string().min(1), subscriptionType: z.string().max(80).nullish(),
}) });
const windowSchema = z.object({ utilization: z.number(), resets_at: z.string().nullish() });
const usageSchema = z.object({
  five_hour: windowSchema.nullish(), seven_day: windowSchema.nullish(),
  seven_day_opus: windowSchema.nullish(), seven_day_sonnet: windowSchema.nullish(),
  limits: z.array(z.object({
    kind: z.string(), percent: z.number(), resets_at: z.string().nullish(),
    scope: z.object({
      model: z.object({ display_name: z.string().nullish() }).nullish(),
      surface: z.object({ display_name: z.string().nullish() }).nullish(),
    }).nullish(),
  })).optional(),
});
type Auth = { accessToken: string; planType?: string };

/** Read only: token rotation belongs to Claude Code. Never refresh or rewrite its credentials. */
async function readAuth(): Promise<Auth> {
  const home = homedir();
  const env = { ...process.env, ...readClaudeUserSettings(process.env, home).env };
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()
    || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => env[key] === '1')
    || (env.ANTHROPIC_BASE_URL?.trim() && env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') !== 'https://api.anthropic.com')) {
    throw new UsageError('api-key-mode', 'Claude 当前使用 API 接入。');
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { accessToken: env.CLAUDE_CODE_OAUTH_TOKEN.trim() };
  try {
    const raw: unknown = JSON.parse(await readFile(join(claudeConfigDir(env, home), '.credentials.json'), 'utf8'));
    const parsed = credentialsSchema.safeParse(raw);
    if (!parsed.success) throw new Error('missing OAuth credentials');
    return { accessToken: parsed.data.claudeAiOauth.accessToken, planType: parsed.data.claudeAiOauth.subscriptionType ?? undefined };
  } catch {
    throw new UsageError('no-auth', '无法读取 Claude 订阅凭据。');
  }
}

function rateWindow(percent: number, seconds: number, reset?: string | null): RateWindow {
  const at = reset ? Date.parse(reset) : NaN;
  return { usedPercent: Math.min(100, Math.max(0, percent)), windowSeconds: seconds, ...(Number.isFinite(at) ? { resetAt: at / 1000 } : {}) };
}
function mapUsage(raw: unknown, auth: Auth): AccountUsageBundle {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) throw new UsageError('transient', 'Claude 用量响应格式无法识别。');
  const data = parsed.data;
  const session = data.limits?.find(limit => limit.kind === 'session');
  const weekly = data.limits?.find(limit => limit.kind === 'weekly_all');
  const primary = session ? rateWindow(session.percent, 18000, session.resets_at)
    : data.five_hour ? rateWindow(data.five_hour.utilization, 18000, data.five_hour.resets_at) : undefined;
  const secondary = weekly ? rateWindow(weekly.percent, 604800, weekly.resets_at)
    : data.seven_day ? rateWindow(data.seven_day.utilization, 604800, data.seven_day.resets_at) : undefined;
  const scoped = data.limits?.filter(limit => limit.kind === 'weekly_scoped') ?? [];
  const extras = scoped.length ? scoped.map(limit => ({ name: [limit.scope?.model?.display_name, limit.scope?.surface?.display_name].filter(Boolean).join(' · ') || '额外限额', secondary: rateWindow(limit.percent, 604800, limit.resets_at) }))
    : Object.entries({ Opus: data.seven_day_opus, Sonnet: data.seven_day_sonnet }).flatMap(([name, window]) => window ? [{ name, secondary: rateWindow(window.utilization, 604800, window.resets_at) }] : []);
  if (!primary && !secondary && !extras.length) throw new UsageError('transient', 'Claude 没有返回可用的额度。');
  return {
    profile: { topInvocations: [], dailyBuckets: [] },
    usage: { planType: auth.planType, main: { primary, secondary }, extras, fetchedAt: Date.now() },
  };
}

const CACHE_MS = 60_000;
let cache: { key: string; data: AccountUsageBundle } | undefined;
let cooldown: { key: string; until: number } | undefined;
const pending = new Map<string, Promise<AccountUsageBundle>>();
const authKey = (auth: Auth): string => createHash('sha256').update(auth.accessToken).digest('hex');

/** Uses the connected host's credentials; a token change invalidates cached quota. */
export async function fetchClaudeUsageBundle(force = false): Promise<AccountUsageBundle> {
  return fetchForAuth(await readAuth(), force, true);
}

async function fetchForAuth(auth: Auth, force: boolean, retryRotation: boolean): Promise<AccountUsageBundle> {
  const key = authKey(auth);
  if (cooldown?.key === key && Date.now() < cooldown.until) throw new UsageError('transient', 'Claude 用量接口请求过于频繁，请稍后重试。');
  if (!force && cache?.key === key && Date.now() - cache.data.usage.fetchedAt < CACHE_MS) return cache.data;
  const running = pending.get(key);
  if (running) return running;
  const read = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const request = () => fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: controller.signal,
    });
    try {
      const response = await request();
      if (response.status === 401 && retryRotation) {
        const fresh = await readAuth();
        if (fresh.accessToken !== auth.accessToken) {
          // This token's HTTP attempt ended; retaining its retry promise could form A → B → A.
          pending.delete(key);
          return fetchForAuth(fresh, false, false);
        }
      }
      if (response.status === 401) throw new UsageError('need-relogin', 'Claude 订阅凭据已过期。');
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after')) * 1000;
        cooldown = { key: authKey(auth), until: Date.now() + Math.max(CACHE_MS, Math.min(300_000, Number.isFinite(retry) ? retry : 0)) };
      }
      if (!response.ok) throw new UsageError('transient', 'Claude 用量接口暂不可用。');
      const raw: unknown = await response.json();
      const data = mapUsage(raw, auth);
      cache = { key: authKey(auth), data };
      return data;
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError('transient', '无法连接 Claude 用量接口。');
    } finally { clearTimeout(timer); }
  })();
  pending.set(key, read);
  try { return await read; } finally { if (pending.get(key) === read) pending.delete(key); }
}
