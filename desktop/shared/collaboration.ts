import { z } from "zod";
import { agentIdSchema, folderTokenSchema, groupIdSchema, toolSchema } from "./bridge";

const projectName = z.string().trim().min(1).max(100).regex(/^[^/\\\x00-\x1f]+$/);
const threadId = z.string().min(1).max(1000);
const sessionId = z.string().min(1).max(1000);
const revision = z.string().min(1).max(256);
const target = { agentId: agentIdSchema, projectName, groupId: groupIdSchema };
const sessionTarget = { ...target, threadId };
const backend = z.enum(["codex-appserver", "claude-agent"]);
const conversation = z.enum(["shared", "threads"]);
const folder = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("existing"), folderToken: folderTokenSchema }).strict(),
]);

export const collaborationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createProject"), agentId: agentIdSchema, name: projectName, folder, tool: toolSchema, conversation }).strict(),
  z.object({ action: z.literal("project"), ...target }).strict(),
  z.object({ action: z.literal("editProject"), ...target, expectedRevision: revision, folderToken: folderTokenSchema.optional(), conversation: conversation.optional(), enabled: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("removeProject"), ...target, expectedRevision: revision }).strict(),
  z.object({ action: z.literal("history"), ...target }).strict(),
  z.object({ action: z.literal("context"), ...sessionTarget }).strict(),
  z.object({ action: z.literal("clear"), ...sessionTarget }).strict(),
  z.object({ action: z.literal("compact"), ...sessionTarget }).strict(),
  z.object({ action: z.literal("resume"), ...target, sessionId, backend: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("startGoal"), ...sessionTarget, objective: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("stop"), ...sessionTarget, runId: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("endGoal"), ...sessionTarget, runId: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("reminder"), ...sessionTarget, runId: z.string().min(1).max(256), requested: z.boolean() }).strict(),
  z.object({ action: z.literal("usage"), agentId: agentIdSchema, force: z.boolean() }).strict(),
  z.object({ action: z.literal("shareUsage"), ...target }).strict(),
  z.object({ action: z.literal("openGroup"), ...target, threadId: threadId.optional() }).strict(),
]);
export type CollaborationRequest = z.infer<typeof collaborationRequestSchema>;

export const projectRecordSchema = z.object({
  name: projectName,
  chatId: groupIdSchema,
  cwd: z.string(),
  kind: z.enum(["single", "multi"]),
  backend: z.string(),
  enabled: z.boolean(),
  revision,
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

const boundSession = z.object({
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
  profile: z.object({ displayName: z.string().optional(), lifetimeTokens: z.number().optional(), totalThreads: z.number().optional(), statsAsOf: z.string().optional() }),
  usage: z.object({ planType: z.string().optional(), main: usageBucket, extras: z.array(usageBucket), fetchedAt: z.number() }),
});

export const collaborationReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), project: projectRecordSchema }),
  z.object({ kind: z.literal("history"), sessions: z.array(boundSession), threads: z.array(resumableThread), backend: z.string(), threadsError: z.string().optional() }),
  z.object({ kind: z.literal("context"), threadId, usage: z.object({ used: z.number(), window: z.number().nullable() }).nullable(), run: z.object({ id: z.string(), goal: z.boolean(), canStop: z.boolean(), canEndGoal: z.boolean(), canRemind: z.boolean(), reminderRequested: z.boolean() }).nullable() }),
  z.object({ kind: z.literal("usage"), data: usageBundle }),
  z.object({ kind: z.literal("applied"), project: projectRecordSchema.optional(), threadId: threadId.optional(), messageId: z.string().optional(), groupEffect: z.enum(["left", "transferred", "failed"]).optional(), warning: z.string().optional(), message: z.string().optional() }),
  z.object({ kind: z.literal("opened") }),
  z.object({ kind: z.literal("refused"), code: z.string(), message: z.string() }),
]);
export type CollaborationReply = z.infer<typeof collaborationReplySchema>;
export type CollaborationClient = (request: CollaborationRequest) => Promise<CollaborationReply>;
