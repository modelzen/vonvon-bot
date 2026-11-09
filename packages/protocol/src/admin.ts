import { z } from "zod";
import { agentIdSchema, badgeNumberSchema, distributionSchema, permissionSchema } from "./domain.js";
import { API_KEY_MAX, keyIdSchema, secretServiceSchema, secretTestOutcomeSchema } from "./secrets.js";
import { principalWireSchema } from "./handshake.js";
import { scopeSchema } from "./device.js";
import { openIdSchema } from "./settings.js";

export const adminProjectSchema = z.object({
  avatarDataUrl: z.string().optional(),
  enabled: z.boolean().optional(),
  name: z.string(), chatId: z.string(), cwd: z.string(), blank: z.boolean(),
  branch: z.string().optional(), kind: z.enum(["multi", "single", "smart"]),
  origin: z.enum(["created", "joined"]), noMention: z.boolean(),
  mode: permissionSchema,
  /** @deprecated since s15c always equal to the group's one tier; kept so clients from before s15c still parse */
  guestMode: permissionSchema,
  /** The effective network access, including native custom settings. */
  network: z.boolean(), backend: z.string(), allowedUsersCount: z.number(),
  sessionCount: z.number(), createdAt: z.number(),
});
export type AdminProject = z.infer<typeof adminProjectSchema>;

export const adminBotSchema = z.object({
  name: z.string(), appId: z.string(), tenant: z.enum(["feishu", "lark"]),
  botName: z.string().optional(), avatarDataUrl: z.string().optional(),
  badgeNumber: badgeNumberSchema.optional(),
  active: z.boolean(), current: z.boolean(), running: z.boolean(),
  pid: z.number().optional(), startedAt: z.number().optional(),
  connection: z.string().optional(), completionReminder: z.object({
    mode: z.enum(["manual", "long", "failures", "always"]),
    longTaskMinutes: z.number(),
  }),
  projects: z.array(adminProjectSchema), projectsError: z.string().optional(),
});
export type AdminBot = z.infer<typeof adminBotSchema>;

export const adminStateSchema = z.object({
  version: z.string(), generatedAt: z.number(), bots: z.array(adminBotSchema),
});
export type AdminState = z.infer<typeof adminStateSchema>;

export const adminBackendStatusSchema = z.object({
  id: z.string(), name: z.string(), ok: z.boolean(), version: z.string().nullable(),
  location: z.string().optional(), hint: z.string().optional(), isDefault: z.boolean(),
});
export type AdminBackendStatus = z.infer<typeof adminBackendStatusSchema>;

export const eventDiagnosisSchema = z.object({
  state: z.enum(["unchecked", "unpublished", "missing", "ok"]),
  reason: z.string().optional(), version: z.string().optional(),
  events: z.array(z.string()).optional(), missingRequired: z.array(z.string()).optional(),
  missingOptional: z.array(z.string()).optional(),
});
export type EventDiagnosis = z.infer<typeof eventDiagnosisSchema>;

export const adminHostDoctorSchema = z.object({
  node: z.string(), platform: z.string(), arch: z.string(), osRelease: z.string(),
  appDir: z.string(), logsDir: z.string(), logBytes: z.number(), version: z.string(),
  backends: z.array(adminBackendStatusSchema),
});
export type AdminHostDoctor = z.infer<typeof adminHostDoctorSchema>;

export const adminSetupStatusSchema = z.object({
  appId: z.string(), tenant: z.enum(["feishu", "lark"]), botName: z.string().optional(),
  credentials: z.object({ ok: z.boolean(), reason: z.string().optional(), unreachable: z.boolean().optional() }),
  connection: z.object({ running: z.boolean(), connection: z.string().optional() }),
  event: eventDiagnosisSchema,
  /** missingRequired gates the checklist step; missingJoinScopes (im:chat:readonly and the leave-group scope)
   * only warns; missingOptional is the 3.11 optional scopes the 状态与诊断 page lists; missingTools is what the Bot's Feishu
   * tools lack, with toolsGrantUrl pre-selecting just those. All undefined when the grants could not be read. */
  scopes: z.object({
    missingRequired: z.array(z.string()).optional(), missingJoinScopes: z.array(z.string()).optional(),
    missingOptional: z.array(z.string()).optional(), missingTools: z.array(z.string()).optional(), grantUrl: z.string(),
    toolsGrantUrl: z.string().optional(),
  }),
  eventConfigUrl: z.string(),
  /** The app's page on the developer console (versions and publishing are there). */
  consoleUrl: z.string(),
  /** Confirmed manually or by receiving a real callback. Only receipt supplies
   * verifiedAt (Unix milliseconds); old hosts can still return confirmed alone. */
  cardCallback: z.object({
    confirmed: z.boolean(),
    verifiedAt: z.number().int().positive().max(8_640_000_000_000_000).optional(),
    /** Current remote configuration is independent of local confirmation and past receipts. */
    configuration: z.object({
      state: z.enum(['configured', 'missing', 'wrong-mode', 'unchecked']),
      mode: z.enum(['websocket', 'webhook']).optional(),
      reason: z.string().optional(),
    }).optional(),
  }),
});
export type AdminSetupStatus = z.infer<typeof adminSetupStatusSchema>;

export const daemonStatusSchema = z.object({
  distribution: distributionSchema.optional(),
  platformName: z.string().optional(), installed: z.boolean(), running: z.boolean(),
  selfHosted: z.boolean(), pid: z.number().optional(), lastExit: z.string().optional(),
  version: z.string(), uptimeMs: z.number().optional(), servicePath: z.string().optional(),
  stdoutPath: z.string().optional(), stderrPath: z.string().optional(), supported: z.boolean(),
  /** When this daemon process started (epoch ms): a reconnecting client compares it to tell a restart (devices 4.7). */
  startedAt: z.number().int(),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const codexSetupSchema = z.object({
  installation: z.enum(["missing", "installed", "unknown"]),
  authentication: z.enum(["signedOut", "signedIn", "notRequired", "unknown"]),
  version: z.string().nullable(), executable: z.string().nullable(), message: z.string().optional(),
});
export type CodexSetup = z.infer<typeof codexSetupSchema>;

/** Daily smart-mode calls actually sent to a language or decision model. */
export const judgeUsageDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), total: z.number().int().nonnegative(),
  sources: z.array(z.object({ kind: z.enum(["llm", "decision"]), id: z.string(), label: z.string(), count: z.number().int().nonnegative() })),
  // `sources` splits a Bot's count by judge (older daemons omit it, so only `count`, the sum, is known).
  bots: z.array(z.object({ agentId: z.string(), agentName: z.string(), count: z.number().int().nonnegative(),
    sources: z.array(z.object({ kind: z.enum(["llm", "decision"]), id: z.string(), count: z.number().int().nonnegative() })).optional() })),
});
export type JudgeUsageDay = z.infer<typeof judgeUsageDaySchema>;

/** Feishu's limit for one image message. */
export const SHARE_GIF_MAX_BYTES = 10 * 1024 * 1024;
export const SHARE_PART_BYTES = 1024 * 1024;
export const shareTargetSchema = z.object({
  agentId: agentIdSchema, name: z.string(), connected: z.boolean(),
  /** the Bot's admin list in order; `name` as Feishu gives it (the 管理员 page's), absent when Feishu would not name them */
  recipients: z.array(z.object({ openId: openIdSchema, name: z.string().optional(), creator: z.boolean() })),
});
export type ShareTarget = z.infer<typeof shareTargetSchema>;

export const adminRequestSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("judgeUsage")}).strict(),
  z.object({type:z.literal("state")}).strict(),
  z.object({type:z.literal("diagnosis"),agentId:agentIdSchema.optional()}).strict(),
  z.object({type:z.literal("hostDoctor")}).strict(),
  z.object({type:z.literal("setupStatus"),agentId:agentIdSchema}).strict(),
  /** Local receipt evidence only; no Feishu calls. */
  z.object({type:z.literal("cardCallbackStatus"),agentId:agentIdSchema}).strict(),
  z.object({type:z.literal("confirmCardCallback"),agentId:agentIdSchema,confirmed:z.boolean()}).strict(),
  z.object({type:z.literal("daemonStatus")}).strict(),
  z.object({type:z.literal("codexSetup")}).strict(),
  z.object({type:z.literal("logs"),maxBytes:z.number().int().optional()}).strict(),
  z.object({type:z.literal("followLogs"),follow:z.boolean()}).strict(),
  z.object({type:z.literal("switchBackend"),agentId:agentIdSchema,projectName:z.string(),backend:z.string()}).strict(),
  /** The key page (s23g): the services that take a key, and filling in, removing and trying one; the value is trimmed
   * and its shape checked by the daemon, which refuses it in a reply. */
  z.object({type:z.literal("secrets")}).strict(),
  z.object({type:z.literal("setSecret"),keyId:keyIdSchema,value:z.string().min(1).max(API_KEY_MAX)}).strict(),
  z.object({type:z.literal("removeSecret"),keyId:keyIdSchema}).strict(),
  z.object({type:z.literal("testSecret"),keyId:keyIdSchema}).strict(),
  /** devices 4.5: the first request after the handshake; the daemon takes only the first one a connection sends. */
  z.object({type:z.literal("negotiate"),capabilities:z.array(z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/)).max(32),scope:scopeSchema.optional()}).strict(),
  /** now-share N5c: the Bots that can send the 此刻 share GIF, each with the admins it can send it to. */
  z.object({type:z.literal("shareTargets")}).strict(),
  /** now-share N5c: the share GIF goes up in parts (a frame holds 4 MB, the GIF up to 10 MB, and the device shown may be
   * remote), then `agentId` sends it to `openId`, one of its admins, in their private chat. */
  z.object({type:z.literal("shareStart"),agentId:agentIdSchema,openId:openIdSchema,bytes:z.number().int().positive().max(SHARE_GIF_MAX_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
  /** `data`: base64 of at most SHARE_PART_BYTES, parts numbered from 0 in order */
  z.object({type:z.literal("sharePart"),uploadId:z.string().min(1).max(64),index:z.number().int().nonnegative(),data:z.string().min(1).max(Math.ceil(SHARE_PART_BYTES / 3) * 4)}).strict(),
  z.object({type:z.literal("shareSend"),uploadId:z.string().min(1).max(64)}).strict(),
]);
export type AdminRequest = z.infer<typeof adminRequestSchema>;

export const adminReplySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("judgeUsage"),days:z.array(judgeUsageDaySchema).max(31),unreadBots:z.number().int().nonnegative(),botsUnreadable:z.boolean().optional()}),
  z.object({kind:z.literal("state"),state:adminStateSchema}),
  z.object({kind:z.literal("diagnosis"),bot:z.string().optional(),backends:z.array(adminBackendStatusSchema),event:eventDiagnosisSchema.optional(),eventConfigUrl:z.string().optional()}),
  z.object({kind:z.literal("hostDoctor"),doctor:adminHostDoctorSchema}),
  z.object({kind:z.literal("setupStatus"),status:adminSetupStatusSchema}),
  z.object({kind:z.literal("cardCallbackStatus"),cardCallback:adminSetupStatusSchema.shape.cardCallback}),
  z.object({kind:z.literal("daemonStatus"),status:daemonStatusSchema}),
  z.object({kind:z.literal("codexSetup"),setup:codexSetupSchema}),
  z.object({kind:z.literal("logs"),text:z.string()}),
  z.object({kind:z.literal("following"),follow:z.boolean()}),
  z.object({kind:z.literal("applied"),revision:z.number()}),
  /** `unreadBots`: bots whose settings could not be read, so their choices are not in `inUse`; `botsUnreadable`: the
   * bot list itself could not be read, so `inUse` lists no one; `removed` answers removeSecret (false: there was no key) */
  z.object({kind:z.literal("secrets"),services:z.array(secretServiceSchema),unreadBots:z.number().int().nonnegative(),botsUnreadable:z.boolean().optional(),removed:z.boolean().optional()}),
  z.object({kind:z.literal("secretTested"),keyId:z.string(),outcome:secretTestOutcomeSchema,message:z.string(),status:z.number().int().optional()}),
  z.object({kind:z.literal("refused"),code:z.string(),message:z.string()}),
  z.object({kind:z.literal("negotiated"),principal:principalWireSchema,scope:scopeSchema.nullable()}),
  z.object({kind:z.literal("shareTargets"),bots:z.array(shareTargetSchema)}),
  /** `received`: bytes so far */
  z.object({kind:z.literal("shareUpload"),uploadId:z.string(),received:z.number().int().nonnegative()}),
  z.object({kind:z.literal("shareSent"),messageId:z.string()}),
]);
export type AdminReply = z.infer<typeof adminReplySchema>;
