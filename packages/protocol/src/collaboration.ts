import { z } from "zod";
import {groupDecisionSchema} from "./group-decision.js";
import {modelCatalogSchema} from "./settings.js";
import { agentIdSchema, conversationSchema, folderTokenSchema, folderSelectionSchema, groupIdSchema, projectIdSchema, replyModeSchema, toolSchema } from "./domain.js";

const projectName = z.string().trim().min(1).max(100).regex(/^[^/\\\x00-\x1f]+$/);
const threadId = z.string().min(1).max(1000);
const sessionId = z.string().min(1).max(1000);
const revision = z.string().min(1).max(256);
const target = { agentId: agentIdSchema, projectName, groupId: groupIdSchema };
export const usageShareSectionSchema = z.enum(["stats", "heatmap", "insights", "limits", "plan"]);
export type UsageShareSection = z.infer<typeof usageShareSectionSchema>;
const sessionTarget = { ...target, threadId };
const backend = z.enum(["codex-appserver", "claude-agent"]);
const conversation = conversationSchema;
const folder = folderSelectionSchema;

export const createProjectRequestSchema = z.object({ action: z.literal("createProject"), requestId: z.string().uuid().optional(), agentId: agentIdSchema, name: projectName, folder, project: projectIdSchema.optional(), tool: toolSchema, conversation, judge: groupDecisionSchema.optional(), response: replyModeSchema.optional() }).strict();

export const collaborationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("providerModels"), backend, refresh: z.boolean().optional() }).strict(),
  createProjectRequestSchema,
  z.object({ action: z.literal("project"), ...target }).strict(),
  z.object({ action: z.literal("editProject"), ...target, expectedRevision: revision, folderToken: folderTokenSchema.optional(), project: projectIdSchema.optional(), conversation: conversation.optional(), enabled: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("removeProject"), ...target, expectedRevision: revision }).strict(),
  z.object({ action: z.literal("history"), ...target }).strict(),
  z.object({ action: z.literal("context"), ...sessionTarget }).strict(),
  z.object({ action: z.literal("clear"), ...sessionTarget }).strict(),
  z.object({ action: z.literal("compact"), ...sessionTarget }).strict(),
  z.object({ action: z.literal("resume"), ...target, sessionId, backend: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("startGoal"), ...sessionTarget, objective: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("stop"), ...sessionTarget, runId: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("stopSubagent"), ...sessionTarget, runId: z.string().min(1).max(256), subagentId: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("endGoal"), ...sessionTarget, runId: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("reminder"), ...sessionTarget, runId: z.string().min(1).max(256), requested: z.boolean() }).strict(),
  z.object({ action: z.literal("usage"), force: z.boolean(), backend: backend.optional() }).strict(),
  z.object({ action: z.literal("shareUsage"), ...target, sections: z.array(usageShareSectionSchema).max(5).optional() }).strict(),
]);
export type CollaborationRequest = z.infer<typeof collaborationRequestSchema>;

export const projectRecordSchema = z.object({
  name: projectName,
  chatId: groupIdSchema,
  cwd: z.string(),
  kind: z.enum(["single", "multi", "smart"]),
  backend: z.string(),
  enabled: z.boolean(),
  revision,
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

const boundSession = z.object({
  detached: z.boolean().optional(),
  threadId,
  chatId: groupIdSchema,
  sessionId,
  summary: z.string(),
  backend: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const resumableThread = z.object({
  sessionId,
  preview: z.string(),
  name: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const usageWindow = z.object({ usedPercent: z.number(), windowSeconds: z.number().optional(), resetAt: z.number().optional() });
const usageBucket = z.object({ name: z.string().optional(), primary: usageWindow.optional(), secondary: usageWindow.optional() });
const usageBundle = z.object({
  profile: z.object({
    displayName: z.string().optional(), lifetimeTokens: z.number().optional(), peakDailyTokens: z.number().optional(),
    currentStreakDays: z.number().optional(), longestStreakDays: z.number().optional(), longestTurnSec: z.number().optional(),
    totalThreads: z.number().optional(), fastModePct: z.number().optional(), totalSkillsUsed: z.number().optional(),
    uniqueSkillsUsed: z.number().optional(), mostUsedEffort: z.string().optional(), mostUsedEffortPct: z.number().optional(),
    topInvocations: z.array(z.object({ name: z.string(), count: z.number(), kind: z.enum(["plugin", "skill"]) })),
    dailyBuckets: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: z.number(), messages: z.number().optional() })),
    statsAsOf: z.string().optional(),
    // Claude Code's own /usage → Stats, computed by the daemon from the host's local Claude Code transcripts.
    // Older daemons omit these; Codex never sends them.
    localStats: z.object({
      state: z.enum(["ready", "scanning", "unavailable"]),
      models: z.array(z.object({ id: z.string(), tokens: z.number() })),
      sessions: z.number(), messages: z.number(), activeDays: z.number(),
      longestSessionSec: z.number().optional(), longestSessionMessages: z.number().optional(),
      hourCounts: z.array(z.number()).length(24).optional(),
    }).optional(),
  }),
  usage: z.object({
    planType: z.string().optional(), main: usageBucket, extras: z.array(usageBucket), fetchedAt: z.number(),
    // Why Claude's quota is empty while its local stats still come back: `reason` is a daemon UsageErrorKind
    // (no-auth, api-key-mode, need-relogin, transient), left open for later ones; `message` is what the quota column
    // says. Older daemons fail the read instead, and older clients see empty windows.
    unavailable: z.object({ reason: z.string().min(1).max(40), message: z.string().min(1).max(200) }).optional(),
  }),
});

export const collaborationReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("providerModels"), backend, state: z.enum(["ready", "unavailable"]), models: modelCatalogSchema.shape.models, message: z.string().optional() }),
  z.object({ kind: z.literal("project"), project: projectRecordSchema }),
  z.object({ kind: z.literal("history"), sessions: z.array(boundSession), threads: z.array(resumableThread), backend: z.string(), threadsError: z.string().optional() }),
  z.object({ kind: z.literal("context"), threadId, usage: z.object({ used: z.number(), window: z.number().nullable() }).nullable(), run: z.object({ id: z.string(), goal: z.boolean(), canStop: z.boolean(), canEndGoal: z.boolean(), canRemind: z.boolean(), reminderRequested: z.boolean(), subagents: z.array(z.object({ id: z.string(), name: z.string(), task: z.string(), status: z.enum(["running", "completed", "failed", "stopped"]), stoppable: z.boolean() })).optional() }).nullable() }),
  z.object({ kind: z.literal("usage"), data: usageBundle }),
  z.object({ kind: z.literal("applied"), project: projectRecordSchema.optional(), threadId: threadId.optional(), messageId: z.string().optional(), groupEffect: z.enum(["left", "transferred", "failed"]).optional(), warning: z.string().optional(), message: z.string().optional() }),
  z.object({ kind: z.literal("opened") }),
  z.object({ kind: z.literal("refused"), code: z.string(), message: z.string() }),
]);
export type CollaborationReply = z.infer<typeof collaborationReplySchema>;
export type CollaborationClient = (request: CollaborationRequest) => Promise<CollaborationReply>;
