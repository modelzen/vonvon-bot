import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { REASONING_EFFORTS } from '../../agent/types';
import type { AppConfig } from '../../config/schema';
import type { BotEntry, BotsRegistry } from '../../config/bots';
import type { Project } from '../../project/registry';
import { effectiveMode, noMentionOf, stricterTier } from '../../project/registry';
import { BotDefaultsSchema } from '../../config/defaults';
import { DirectoriesSchema } from '../../config/directories';
import { resolveExecution } from '../../config/execution';
import { sessionTitleJobKey, type SessionRecord, type SessionTitleJob } from '../../bot/session-store';

// Source: released bridge 0.6.14 (6698118), not the redacted s59 report.
const text = z.string().min(1).max(65536);
const path = text.refine(value => isAbsolute(value) && !value.includes('\0'));
const tier = z.enum(['qa', 'write', 'full']);
const effort = z.enum(REASONING_EFFORTS);
const backend = z.enum(['codex-appserver', 'claude-agent']);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const time = z.number().finite().nonnegative();
const entrySchema = z.object({ name: text, appId: id, tenant: z.enum(['feishu', 'lark']),
  botName: z.string().optional(), createdAt: time, active: z.boolean().optional() });
const configSchema = z.object({
  accounts: z.object({ app: z.object({ id, tenant: z.enum(['feishu', 'lark']),
    // Transaction resolves/decrypts the source secret before this boundary.
    secret: text }) }),
  preferences: z.object({
    defaults: BotDefaultsSchema.optional(), directories: DirectoriesSchema.optional(),
    projectsRootDir: text.optional(), messageReply: z.enum(['card', 'markdown', 'text']).optional(),
    showToolCalls: z.boolean().optional(), showModel: z.union([z.boolean(), z.enum(['off', 'running', 'always'])]).optional(),
    maxConcurrentRuns: z.number().finite().positive().optional(), requireMentionInGroup: z.boolean().optional(),
    agentStopGraceMs: z.number().finite().nonnegative().optional(),
    completionReminder: z.object({ mode: z.enum(['manual', 'long', 'failures', 'always']).optional(), longTaskMinutes: z.number().finite().optional() }).optional(),
    access: z.object({ ownerOpenId: text.optional(), admins: z.array(text).optional(),
      allowedUsers: z.array(text).optional(), allowedChats: z.array(text).optional() }).passthrough().optional(),
    runIdleTimeoutSeconds: z.number().finite().nonnegative().optional(),
    pendingPolicy: z.enum(['steer', 'queue']).optional(),
    comments: z.object({ backend: backend.optional(), model: text.optional(), effort: effort.optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
const projectSchema = z.object({ name: text, chatId: text, cwd: path, blank: z.boolean(), createdAt: time,
  kind: z.enum(['multi', 'single']).optional(), noMention: z.boolean().optional(),
  origin: z.enum(['created', 'joined']).optional(), addedBy: text.optional(),
  mode: tier.optional(), guestMode: tier.nullable().optional(), network: z.boolean().optional(),
  allowedUsers: z.array(text).optional(), backend: backend.optional(), defaultModel: text.optional(),
  defaultEffort: effort.optional(), defaultModelCustom: z.boolean().optional(),
  pendingPolicy: z.enum(['steer', 'queue']).optional(), branch: z.string().optional(),
  autoCompact: z.boolean().optional(),
}).strict();
const sessionSchema = z.object({ threadId: text, chatId: text, cwd: path,
  sessionId: text.optional(), codexThreadId: text.optional(), backend: backend.optional(),
  model: text.optional(), effort: effort.optional(), modelCustom: z.boolean().optional(),
  titleJobKey: text.optional(), lastSeenAt: time.optional(), summary: z.string(), createdAt: time, updatedAt: time, detached: z.boolean().optional(),
}).passthrough().refine(s => s.sessionId !== undefined || s.codexThreadId !== undefined);
const titleJobSchema = z.object({
  key: text, backend, sessionId: text, cwd: path,
  phase: z.enum(['waiting_source', 'waiting_turn', 'pending', 'generating', 'prepared', 'applying', 'done', 'skipped']),
  source: z.string().optional(), candidate: z.string().optional(), finalTitle: z.string().optional(),
  policy: z.object({ strategy: z.enum(['model', 'truncate']), model: text.optional(), effort: effort.optional() }).optional(),
  claimId: text.optional(), leaseUntil: time.optional(), writeAttempted: z.boolean().optional(),
  attempts: time, nextRetryAt: time.optional(),
  outcome: z.enum(['written', 'preexisting', 'unsupported', 'excluded', 'failed']).optional(),
  lastError: z.string().optional(), createdAt: time, updatedAt: time,
}).passthrough();
const fileSchema = z.object({
  messageId: text, chatId: text, cwd: path, mode: tier, replyInThread: z.boolean(),
  requesterOpenId: text.optional(), cardId: text.optional(), sequence: time.optional(),
  files: z.array(z.object({ path, label: z.string(), size: time, mtimeMs: time,
    ino: time, dev: time, occurrences: z.array(z.object({ elementId: text, label: z.string() })),
    revision: text.optional(), error: z.string().optional(), fileKey: text.optional(),
    sendStartedAt: time.optional(), messageId: text.optional(), messageLink: text.optional(),
    sendUuid: text.optional(), needsPaint: z.boolean().optional(),
  }).strict()),
}).strict();
export const BridgeSnapshotSchema = z.object({
  registry: z.object({ version: z.literal(1), current: id.optional(), bots: z.array(entrySchema).min(1).max(128) }),
  bots: z.array(z.object({ appId: id, config: configSchema,
    projects: z.object({ version: z.literal(1), projects: z.array(projectSchema).max(4096) }),
    sessions: z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]), sessions: z.array(sessionSchema).max(32768), titleJobs: z.array(titleJobSchema).max(32768).optional() }).refine(s => s.version !== 3 || s.titleJobs !== undefined),
    commentInstructions: z.string().nullable(),
    sentFiles: z.array(z.object({ name: text.refine(value => !value.includes('/') && !value.includes('\\') && value !== '..'), data: fileSchema })).max(32768),
  })).min(1).max(128),
});
export type BridgeSnapshot = z.infer<typeof BridgeSnapshotSchema>;
export const idleTimeoutMigrationMessage = '空闲超时：旧版的 120 秒是当时的默认值，改成现在的默认 10 分钟；要 120 秒请到设置里改回';
export type ConversionDifference =
  | { kind: 'idle-timeout-default'; message: string }
  | { kind: 'permission-merged'; chatId: string; mode: Project['mode'] };
export interface ConvertedBridgeBot {
  appId: string;
  config: AppConfig;
  projects: { version: 1; projects: Project[] };
  sessions: { version: 3; sessions: SessionRecord[]; titleJobs: SessionTitleJob[] };
  /** Keep native personal instructions/skills and CODEX_HOME; no new-bot clearing. */
  personalInstructions: 'inherit-native';
  commentInstructions: string | null;
  sentFiles: BridgeSnapshot['bots'][number]['sentFiles'];
  differences: ConversionDifference[];
}
export type BridgeConversion =
  | { kind: 'converted'; registry: BotsRegistry; bots: ConvertedBridgeBot[] }
  | { kind: 'invalid'; issues: { botIndex?: number; code: string }[] };

// Reject accessors, functions, cycles, symbols, and exotic objects BEFORE Zod reads them.
// No user-supplied getter, toJSON, or proxy is intentionally invoked; callers supply JSON snapshots.
function isPlainData(value: unknown, parents = new Set<object>(), budget = { remaining: 1000000 }): boolean {
  if (--budget.remaining < 0) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || parents.has(value) || parents.size > 64) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  parents.add(value);
  const valid = Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
    'value' in descriptor && isPlainData(descriptor.value, parents, budget));
  parents.delete(value);
  return valid;
}
function duplicate(values: readonly string[]): boolean { return new Set(values).size !== values.length; }

/** Pure boundary for s61: no source reads, secret resolution, directory allocation or writes. */
export function convertBridgeSnapshot(raw: unknown): BridgeConversion {
  if (!isPlainData(raw)) return { kind: 'invalid', issues: [{ code: 'not-json-data' }] };
  const parsed = BridgeSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', issues: [{ code: 'invalid-schema' }] };
  const input = parsed.data;
  const issues: Extract<BridgeConversion, { kind: 'invalid' }>['issues'] = [];
  const entries = input.registry.bots;
  if (duplicate(entries.map(b => b.appId)) || duplicate(entries.map(b => b.name))
    || duplicate(input.bots.map(b => b.appId)) || entries.length !== input.bots.length
    || (input.registry.current !== undefined && !entries.some(b => b.appId === input.registry.current))) {
    issues.push({ code: 'inconsistent-registry' });
  }
  const bots: ConvertedBridgeBot[] = [];
  for (const [botIndex, bot] of input.bots.entries()) {
    const entry = entries.find(b => b.appId === bot.appId);
    if (!entry || bot.config.accounts.app.id !== bot.appId || bot.config.accounts.app.tenant !== entry.tenant) {
      issues.push({ botIndex, code: 'inconsistent-bot' });
    }
    if (duplicate(bot.projects.projects.map(p => p.chatId))) issues.push({ botIndex, code: 'duplicate-group' });
    if (duplicate(bot.sessions.sessions.map(s => s.threadId))) issues.push({ botIndex, code: 'duplicate-session-key' });
    for (const job of bot.sessions.titleJobs ?? []) {
      if (job.key !== sessionTitleJobKey(job.backend, job.sessionId)) issues.push({ botIndex, code: 'invalid-title-job-key' });
    }
    if (duplicate((bot.sessions.titleJobs ?? []).map(job => sessionTitleJobKey(job.backend, job.sessionId)))) issues.push({ botIndex, code: 'duplicate-title-job-host' });
    if (duplicate((bot.sessions.titleJobs ?? []).map(job => job.key))) issues.push({ botIndex, code: 'duplicate-title-job' });
    if (duplicate(bot.sentFiles.map(f => f.name))) issues.push({ botIndex, code: 'duplicate-file-manifest' });
    const differences: ConversionDifference[] = [];
    const split = new Set<string>();
    const projects: Project[] = bot.projects.projects.map(row => {
      const { guestMode, autoCompact: _autoCompact, ...rest } = row;
      const mode = guestMode == null ? effectiveMode(rest) : stricterTier(effectiveMode(rest), guestMode);
      if (guestMode != null && guestMode !== effectiveMode(rest)) {
        split.add(row.chatId);
        differences.push({ kind: 'permission-merged', chatId: row.chatId, mode });
      }
      const resolved = resolveExecution({ group: { ...rest, mode } });
      return { ...rest, kind: row.kind ?? 'multi', noMention: noMentionOf(rest), mode,
        network: resolved.network, backend: resolved.backend };
    });
    const sessions: SessionRecord[] = [];
    for (const row of bot.sessions.sessions) {
      const { codexThreadId, ...rest } = row;
      const sessionId = row.sessionId ?? codexThreadId;
      if (!sessionId || (row.sessionId && codexThreadId && row.sessionId !== codexThreadId)) {
        issues.push({ botIndex, code: 'conflicting-session-id' });
        continue;
      }
      if (row.titleJobKey !== undefined && row.titleJobKey !== sessionTitleJobKey(row.backend ?? 'codex-appserver', sessionId)) {
        issues.push({ botIndex, code: 'invalid-session-title-job-reference' });
      }
      const threadId = !row.detached && split.has(row.chatId) && row.threadId.endsWith('#admin')
        ? row.threadId.slice(0, -'#admin'.length) : row.threadId;
      sessions.push({ ...rest, sessionId, backend: row.backend ?? 'codex-appserver', threadId });
    }
    if (duplicate(sessions.map(s => s.threadId))) issues.push({ botIndex, code: 'session-key-conflict' });
    const config: AppConfig = bot.config;
    if (config.preferences?.runIdleTimeoutSeconds === 120) {
      delete config.preferences.runIdleTimeoutSeconds;
      differences.push({ kind: 'idle-timeout-default', message: idleTimeoutMigrationMessage });
    }
    bots.push({ appId: bot.appId, config, projects: { version: 1, projects },
      sessions: { version: 3, sessions, titleJobs: bot.sessions.version === 3 ? bot.sessions.titleJobs ?? [] : [] }, personalInstructions: 'inherit-native',
      commentInstructions: bot.commentInstructions, sentFiles: bot.sentFiles, differences });
  }
  if (issues.length) return { kind: 'invalid', issues };
  const savedEntries: BotEntry[] = entries;
  return { kind: 'converted', registry: { ...input.registry, bots: savedEntries }, bots };
}
