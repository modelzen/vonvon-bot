import { z } from "zod";
import { agentIdSchema, permissionSchema } from "./domain.js";
import { API_KEY_MAX, keyIdSchema, secretServiceSchema, secretTestOutcomeSchema } from "./secrets.js";

export const adminProjectSchema = z.object({
  avatarDataUrl: z.string().optional(),
  name: z.string(), chatId: z.string(), cwd: z.string(), blank: z.boolean(),
  branch: z.string().optional(), kind: z.enum(["multi", "single", "smart"]),
  origin: z.enum(["created", "joined"]), noMention: z.boolean(),
  mode: permissionSchema,
  /** @deprecated since s15c always equal to the group's one tier; kept so clients from before s15c still parse */
  guestMode: permissionSchema,
  network: z.boolean(), backend: z.string(), allowedUsersCount: z.number(),
  sessionCount: z.number(), createdAt: z.number(),
});
export type AdminProject = z.infer<typeof adminProjectSchema>;

export const adminBotSchema = z.object({
  name: z.string(), appId: z.string(), tenant: z.enum(["feishu", "lark"]),
  botName: z.string().optional(), avatarDataUrl: z.string().optional(),
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
   * only warns; missingOptional is the 3.11 optional scopes the 状态与诊断 page lists. All undefined when the grants could not be read. */
  scopes: z.object({
    missingRequired: z.array(z.string()).optional(), missingJoinScopes: z.array(z.string()).optional(),
    missingOptional: z.array(z.string()).optional(), grantUrl: z.string(),
  }),
  eventConfigUrl: z.string(),
  /** The app's page on the developer console (versions and publishing are there). */
  consoleUrl: z.string(),
  /** card.action.trigger has no read API, so the owner ticks it by hand (s04). */
  cardCallback: z.object({ confirmed: z.boolean() }),
});
export type AdminSetupStatus = z.infer<typeof adminSetupStatusSchema>;

export const daemonStatusSchema = z.object({
  distribution: z.object({kind:z.enum(["global-npm", "bundled", "development", "unknown"]), cliPath:z.string()}).optional(),
  platformName: z.string().optional(), installed: z.boolean(), running: z.boolean(),
  selfHosted: z.boolean(), pid: z.number().optional(), lastExit: z.string().optional(),
  version: z.string(), uptimeMs: z.number().optional(), servicePath: z.string().optional(),
  stdoutPath: z.string().optional(), stderrPath: z.string().optional(), supported: z.boolean(),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const codexSetupSchema = z.object({
  installation: z.enum(["missing", "installed", "unknown"]),
  authentication: z.enum(["signedOut", "signedIn", "notRequired", "unknown"]),
  version: z.string().nullable(), executable: z.string().nullable(), message: z.string().optional(),
});
export type CodexSetup = z.infer<typeof codexSetupSchema>;

export const adminRequestSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("state")}).strict(),
  z.object({type:z.literal("diagnosis"),agentId:agentIdSchema.optional()}).strict(),
  z.object({type:z.literal("hostDoctor")}).strict(),
  z.object({type:z.literal("setupStatus"),agentId:agentIdSchema}).strict(),
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
]);
export type AdminRequest = z.infer<typeof adminRequestSchema>;

export const adminReplySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("state"),state:adminStateSchema}),
  z.object({kind:z.literal("diagnosis"),bot:z.string().optional(),backends:z.array(adminBackendStatusSchema),event:eventDiagnosisSchema.optional(),eventConfigUrl:z.string().optional()}),
  z.object({kind:z.literal("hostDoctor"),doctor:adminHostDoctorSchema}),
  z.object({kind:z.literal("setupStatus"),status:adminSetupStatusSchema}),
  z.object({kind:z.literal("daemonStatus"),status:daemonStatusSchema}),
  z.object({kind:z.literal("codexSetup"),setup:codexSetupSchema}),
  z.object({kind:z.literal("logs"),text:z.string()}),
  z.object({kind:z.literal("following"),follow:z.boolean()}),
  z.object({kind:z.literal("applied"),revision:z.number()}),
  /** `unreadBots`: bots whose settings could not be read, so their choices are not in `inUse`; `removed` answers
   * removeSecret (false: there was no key) */
  z.object({kind:z.literal("secrets"),services:z.array(secretServiceSchema),unreadBots:z.number().int().nonnegative(),removed:z.boolean().optional()}),
  z.object({kind:z.literal("secretTested"),keyId:z.string(),outcome:secretTestOutcomeSchema,message:z.string(),status:z.number().int().optional()}),
  z.object({kind:z.literal("refused"),code:z.string(),message:z.string()}),
]);
export type AdminReply = z.infer<typeof adminReplySchema>;
