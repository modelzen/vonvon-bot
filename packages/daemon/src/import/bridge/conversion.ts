import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { secretKeyForApp, isSecretRef, type AppConfig } from '../../config/schema';
import { activeBots } from '../../config/bots';
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
const effort = z.string().trim().min(1).max(1000);
const backend = z.enum(['codex-appserver', 'claude-agent']);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const time = z.number().finite().nonnegative();
const entrySchema = z.object({ name: text, appId: id, tenant: z.enum(['feishu', 'lark']),
  botName: z.string().optional(), createdAt: time, active: z.boolean().optional() });
const referenceSchema = z.object({ source: z.enum(['env', 'file', 'exec']), id: text, provider: text.optional() }).strict().refine(isSecretRef);
const providerSchema = z.object({ source: z.enum(['env', 'file', 'exec']), allowlist: z.array(text).optional(),
  path: text.optional(), command: text.optional(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(),
  passEnv: z.array(text).optional(), noOutputTimeoutMs: time.optional(), maxOutputBytes: time.optional() }).strict();
const secretsSchema = z.object({ providers: z.record(z.string(), providerSchema).optional(),
  defaults: z.object({ env: text.optional(), file: text.optional(), exec: text.optional() }).strict().optional() }).strict();
export const BridgeSecretSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy-keystore'), id: text }).strict(),
  z.object({ kind: z.literal('plaintext') }).strict(),
  z.object({ kind: z.literal('external'), reference: referenceSchema }).strict(),
]);
const configSchema = z.object({
  accounts: z.object({ app: z.object({ id, tenant: z.enum(['feishu', 'lark']),
    // A source descriptor only: s61 decrypts or reads plaintext after conversion.
    secret: BridgeSecretSourceSchema }) }),
  secrets: secretsSchema.optional(),
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
const registrySchema = z.object({ version: z.literal(1), current: id.optional(), bots: z.array(entrySchema).min(1).max(128) });
const botSchema = z.object({ appId: id, config: configSchema,
  projects: z.object({ version: z.literal(1), projects: z.array(projectSchema).max(4096) }),
  sessions: z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]), sessions: z.array(sessionSchema).max(32768), titleJobs: z.array(titleJobSchema).max(32768).optional() }).refine(s => s.version !== 3 || s.titleJobs !== undefined),
  commentInstructions: z.string().nullable(), outboundFilesPresent: z.boolean(),
});
export const BridgeSnapshotSchema = z.object({ destinationSecretsGetter: path, registry: registrySchema, bots: z.array(botSchema).min(1).max(128) });
export type BridgeSnapshot = z.infer<typeof BridgeSnapshotSchema>;
// Parse individual bot payloads later so one damaged config never hides valid siblings.
const envelopeSchema = z.object({ destinationSecretsGetter: z.unknown(), registry: z.unknown(), bots: z.array(z.unknown()).min(1).max(128) });
const registryEnvelopeSchema = registrySchema.extend({ bots: z.array(z.unknown()).min(1).max(128) });
export const idleTimeoutMigrationMessage = '空闲超时：旧版的 120 秒是当时的默认值，改成现在的默认 10 分钟；要 120 秒请到设置里改回';
export type ConversionNote = { appId: string; message: string } & (
  | { kind: 'idle-timeout-default'; message: string }
  | { kind: 'permission-merged'; chatId: string; mode: Project['mode'] }
  | { kind: 'automatic-compaction'; chatId: string }
  | { kind: 'retired-sessions'; count: number });
export interface ConvertedBridgeBot {
  kind: 'converted';
  appId: string;
  entry: { appId: string; tenant: AppConfig['accounts']['app']['tenant']; botName?: string; desiredName: string; active: boolean };
  config: AppConfig;
  secret: z.infer<typeof BridgeSecretSourceSchema>;
  projects: { version: 1; projects: Project[] };
  sessions: { version: 3; sessions: SessionRecord[]; titleJobs: SessionTitleJob[] };
  /** Keep native personal instructions/skills and CODEX_HOME; no new-bot clearing. */
  personalInstructions: 'inherit-native';
  commentInstructions: string | null;
  copy: ('comment-instructions.md' | 'outbound-files/**')[];
  notes: ConversionNote[];
}
interface ConversionIssue { botIndex?: number; code: string }
export interface InvalidBridgeBot { kind: 'invalid'; appId?: string; botIndex: number; issues: ConversionIssue[] }
export type BridgeConversion =
  | { kind: 'converted'; bots: ConvertedBridgeBot[] }
  | { kind: 'invalid'; issues: ConversionIssue[]; bots: (ConvertedBridgeBot | InvalidBridgeBot)[] };

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
function convertSnapshot(raw: unknown): BridgeConversion {
  if (!isPlainData(raw)) return { kind: 'invalid', issues: [{ code: 'not-json-data' }], bots: [] };
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', issues: [{ code: 'invalid-top-level' }], bots: [] };
  const input = parsed.data;
  const destination = path.safeParse(input.destinationSecretsGetter);
  if (!destination.success) return { kind: 'invalid', issues: [{ code: 'invalid-destination-getter' }], bots: [] };
  const parsedRegistry = registryEnvelopeSchema.safeParse(input.registry);
  if (!parsedRegistry.success) return { kind: 'invalid', issues: [{ code: 'invalid-registry' }], bots: [] };
  const issues: ConversionIssue[] = [];
  const entries = parsedRegistry.data.bots.flatMap((rawEntry, botIndex) => {
    const result = entrySchema.safeParse(rawEntry);
    if (result.success) return [result.data];
    issues.push({ botIndex, code: 'invalid-registry-entry' });
    return [];
  });
  // Any bad registry entry blocks consumption of the entire result, even though
  // valid siblings retain their preview information. Allocation never happens here.
  const registry = { ...parsedRegistry.data, bots: entries };
  if (duplicate(entries.map(b => b.appId)) || duplicate(entries.map(b => b.name))
    || entries.length !== input.bots.length
    || (registry.current !== undefined && !entries.some(b => b.appId === registry.current))) {
    issues.push({ code: 'inconsistent-registry' });
  }
  const bots: (ConvertedBridgeBot | InvalidBridgeBot)[] = [];
  const active = new Set(activeBots(registry).map(entry => entry.appId));
  const seen = new Set<string>();
  for (const [botIndex, payload] of input.bots.entries()) {
    const identity = z.object({ appId: id }).safeParse(payload);
    const parsedBot = botSchema.safeParse(payload);
    if (!parsedBot.success) {
      const failure: InvalidBridgeBot = { kind: 'invalid', botIndex, ...(identity.success ? { appId: identity.data.appId } : {}), issues: [{ botIndex, code: 'invalid-schema' }] };
      bots.push(failure); issues.push(...failure.issues); continue;
    }
    const bot = parsedBot.data;
    const botIssues: ConversionIssue[] = [];
    if (seen.has(bot.appId)) botIssues.push({ botIndex, code: 'duplicate-bot' });
    seen.add(bot.appId);
    const entry = entries.find(b => b.appId === bot.appId);
    if (!entry || bot.config.accounts.app.id !== bot.appId || bot.config.accounts.app.tenant !== entry.tenant) {
      botIssues.push({ botIndex, code: 'inconsistent-bot' });
    }
    if (duplicate(bot.projects.projects.map(p => p.chatId))) botIssues.push({ botIndex, code: 'duplicate-group' });
    if (duplicate(bot.sessions.sessions.map(s => s.threadId))) botIssues.push({ botIndex, code: 'duplicate-session-key' });
    for (const job of bot.sessions.titleJobs ?? []) {
      if (job.key !== sessionTitleJobKey(job.backend, job.sessionId)) botIssues.push({ botIndex, code: 'invalid-title-job-key' });
    }
    if (duplicate((bot.sessions.titleJobs ?? []).map(job => sessionTitleJobKey(job.backend, job.sessionId)))) botIssues.push({ botIndex, code: 'duplicate-title-job-host' });
    if (duplicate((bot.sessions.titleJobs ?? []).map(job => job.key))) botIssues.push({ botIndex, code: 'duplicate-title-job' });
    const notes: ConversionNote[] = [];
    const split = new Set<string>();
    const projects: Project[] = bot.projects.projects.map(row => {
      const { guestMode, autoCompact, ...rest } = row;
      if (autoCompact === false) notes.push({ appId: bot.appId, kind: 'automatic-compaction', chatId: row.chatId, message: '旧版关闭的自动压缩已改为开启。' });
      const mode = guestMode == null ? effectiveMode(rest) : stricterTier(effectiveMode(rest), guestMode);
      if (guestMode != null && guestMode !== effectiveMode(rest)) {
        split.add(row.chatId);
        notes.push({ appId: bot.appId, kind: 'permission-merged', chatId: row.chatId, mode, message: '这个群的管理员档和访客档不同，已取两档中更严格的权限。' });
      }
      const resolved = resolveExecution({ group: { ...rest, mode } });
      return { ...rest, kind: row.kind ?? 'multi', noMention: noMentionOf(rest), mode,
        network: rest.network ?? false, backend: resolved.backend };
    });
    const sessions: SessionRecord[] = [];
    for (const row of bot.sessions.sessions) {
      const { codexThreadId, ...rest } = row;
      const sessionId = row.sessionId ?? codexThreadId;
      if (!sessionId || (row.sessionId && codexThreadId && row.sessionId !== codexThreadId)) {
        botIssues.push({ botIndex, code: 'conflicting-session-id' });
        continue;
      }
      if (row.titleJobKey !== undefined && row.titleJobKey !== sessionTitleJobKey(row.backend ?? 'codex-appserver', sessionId)) {
        botIssues.push({ botIndex, code: 'invalid-session-title-job-reference' });
      }
      const threadId = !row.detached && split.has(row.chatId) && row.threadId.endsWith('#admin')
        ? row.threadId.slice(0, -'#admin'.length) : row.threadId;
      sessions.push({ ...rest, sessionId, backend: row.backend ?? 'codex-appserver', threadId });
    }
    if (duplicate(sessions.map(s => s.threadId))) botIssues.push({ botIndex, code: 'session-key-conflict' });
    const source = bot.config.accounts.app.secret;
    if (source.kind === 'external') {
      const reference = source.reference;
      const providerName = reference.provider ?? bot.config.secrets?.defaults?.[reference.source] ?? 'default';
      const provider = bot.config.secrets?.providers?.[providerName];
      if ((provider && provider.source !== reference.source) || (reference.source === 'exec' && !provider?.command)) {
        botIssues.push({ botIndex, code: 'invalid-external-provider' });
      }
    }
    const config: AppConfig = { ...bot.config, accounts: { app: { ...bot.config.accounts.app,
      secret: source.kind === 'external' ? source.reference : { source: 'exec', provider: 'bridge', id: secretKeyForApp(bot.appId) },
    } } };
    if (source.kind !== 'external') config.secrets = { ...config.secrets, providers: { ...config.secrets?.providers,
      bridge: { source: 'exec', command: destination.data, args: [] },
    } };
    if (config.preferences?.runIdleTimeoutSeconds === 120) {
      delete config.preferences.runIdleTimeoutSeconds;
      notes.push({ appId: bot.appId, kind: 'idle-timeout-default', message: idleTimeoutMigrationMessage });
    }
    const retiredCount = sessions.filter(session => /#(?:guest|admin)$/.test(session.threadId)).length;
    if (retiredCount) notes.push({ appId: bot.appId, kind: 'retired-sessions', count: retiredCount, message: '旧版访客及未接管的管理员会话记录已保留为停用记录，未覆盖其他会话。' });
    if (botIssues.length || !entry) {
      issues.push(...botIssues); bots.push({ kind: 'invalid', appId: bot.appId, botIndex, issues: botIssues }); continue;
    }
    bots.push({ kind: 'converted', appId: bot.appId,
      entry: { appId: bot.appId, tenant: entry.tenant, ...(entry.botName === undefined ? {} : { botName: entry.botName }), desiredName: entry.name, active: active.has(entry.appId) },
      config, secret: source, projects: { version: 1, projects },
      sessions: { version: 3, sessions, titleJobs: bot.sessions.version === 3 ? bot.sessions.titleJobs ?? [] : [] }, personalInstructions: 'inherit-native',
      commentInstructions: bot.commentInstructions, copy: [
        ...(bot.commentInstructions === null ? [] : ['comment-instructions.md' as const]),
        ...(bot.outboundFilesPresent ? ['outbound-files/**' as const] : []),
      ], notes });
  }
  for (const entry of entries) {
    if (!input.bots.some(payload => { const identity = z.object({ appId: id }).safeParse(payload); return identity.success && identity.data.appId === entry.appId; })) {
      const botIndex = bots.length; const missingIssues = [{ botIndex, code: 'missing-bot-snapshot' }];
      bots.push({ kind: 'invalid', appId: entry.appId, botIndex, issues: missingIssues }); issues.push(...missingIssues);
    }
  }
  if (issues.length) return { kind: 'invalid', issues, bots };
  return { kind: 'converted', bots: bots.filter((bot): bot is ConvertedBridgeBot => bot.kind === 'converted') };
}

/** Unknown caller objects (including hostile reflection traps) cannot escape as exceptions. */
export function convertBridgeSnapshot(raw: unknown): BridgeConversion {
  try { return convertSnapshot(raw); }
  catch { return { kind: 'invalid', issues: [{ code: 'not-json-data' }], bots: [] }; }
}
