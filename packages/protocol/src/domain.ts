import { z } from "zod";

export const agentIdSchema = z
  .string()
  .regex(/^cli_[A-Za-z0-9_-]{1,200}$/)
  .brand<"AgentId">();
export const groupIdSchema = z
  .string()
  .regex(/^oc_[A-Za-z0-9_-]{1,200}$/)
  .brand<"GroupId">();
export const membershipIdSchema = z
  .string()
  .min(1)
  .max(700)
  .brand<"MembershipId">();
export const jobIdSchema = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"JobId">();
export const folderTokenSchema = z.string().uuid().brand<"FolderToken">();
export const permissionSchema = z.enum(["qa", "write", "full"]);
export const toolSchema = z.enum(["codex", "claude"]);
export const conversationSchema = z.enum(["threads", "shared"]);
export type AgentId = z.infer<typeof agentIdSchema>;
export type GroupId = z.infer<typeof groupIdSchema>;
export type MembershipId = z.infer<typeof membershipIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export type FolderToken = z.infer<typeof folderTokenSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type Tool = z.infer<typeof toolSchema>;

const empty = <T extends string>(type: T) =>
  z.object({ type: z.literal(type) }).strict();
export const commandSchema = z.discriminatedUnion("type", [
  empty("refresh"),
  z.object({type: z.literal("listPendingGroups"), agentId: agentIdSchema}).strict(),
  z.object({type: z.literal("openEventSettings"), url: z.string().regex(/^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/app\/cli_[\w-]{1,200}\/event$/)}).strict(),
  empty("registerAgent"),
  z.object({type: z.literal("refreshAgentCredentials"), agentId: agentIdSchema}).strict(),
  empty("installCodex"),
  empty("startCodexLogin"),
  empty("restartHost"),
  z
    .object({
      type: z.literal("listJoinedGroups"),
      agentId: agentIdSchema,
      cursor: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("bindGroup"),
      agentId: agentIdSchema,
      groupId: groupIdSchema,
      projectName: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[^/\\\x00-\x1f]+$/),
      folderToken: folderTokenSchema,
      tool: toolSchema,
      conversation: conversationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("setResponse"),
      membershipId: membershipIdSchema,
      response: z.enum(["mention", "all"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("setPermission"),
      membershipId: membershipIdSchema,
      administrator: permissionSchema,
      member: permissionSchema,
      network: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("setAgentEnabled"),
      agentId: agentIdSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z.object({type:z.literal("deleteAgent"),agentId:agentIdSchema}).strict(),
  z.object({ type: z.literal("cancelJob"), jobId: jobIdSchema }).strict(),
  z
    .object({ type: z.literal("openJobAuthorization"), jobId: jobIdSchema })
    .strict(),
  z
    .object({ type: z.literal("copyJobAuthorization"), jobId: jobIdSchema })
    .strict(),
  z
    .object({ type: z.literal("inspectAgent"), agentId: agentIdSchema })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const hostStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("connected"), ownership: z.enum(["owned", "attached"]), version: z.string() }),
  z.object({ kind: z.literal("blocked"), message: z.string() }),
  z.object({ kind: z.literal("disconnected"), message: z.string() }),
]);
export type HostState = z.infer<typeof hostStateSchema>;
export const agentSchema = z.object({
  id: agentIdSchema, name: z.string(), avatarDataUrl: z.string().optional(),
  enabled: z.boolean(), running: z.boolean(), connection: z.string(),
  activation: z.enum(["active", "restartRequired"]), readError: z.string().optional(),
});
export type Agent = z.infer<typeof agentSchema>;
export const membershipSchema = z.object({
  avatarDataUrl: z.string().optional(), id: membershipIdSchema, agentId: agentIdSchema,
  groupId: groupIdSchema, name: z.string(), directory: z.string(), backend: z.string(),
  conversation: conversationSchema, response: z.enum(["mention", "all"]),
  permission: z.object({ administrator: permissionSchema, member: permissionSchema, network: z.boolean() }),
  stale: z.boolean(),
});
export type Membership = z.infer<typeof membershipSchema>;
export const groupSchema = z.object({ id: groupIdSchema, name: z.string(), avatarDataUrl: z.string().optional() });
export type Group = z.infer<typeof groupSchema>;
/** Codex only: how its version compares with the minimum and the tested version. */
export const codexCompatibilitySchema = z.object({ status: z.enum(["ok", "tooOld", "newer", "unknown"]), minimum: z.string(), verified: z.string() });
export const toolStateSchema = z.object({
  tool: toolSchema, installation: z.enum(["missing", "installed", "unknown"]),
  authentication: z.enum(["signedOut", "signedIn", "notRequired", "unknown"]),
  version: z.string().nullable(), message: z.string().optional(),
  compatibility: codexCompatibilitySchema.optional(),
});
export type ToolState = z.infer<typeof toolStateSchema>;
export const serviceStateSchema = z.enum(["not-installed", "running", "stopped", "disabled", "detached", "conflict", "unknown"]);
export type ServiceState = z.infer<typeof serviceStateSchema>;
/** Why a service install or uninstall failed, read from the transaction's detail (daemon service/action-report.ts). */
export const serviceActionReasonSchema = z.enum(["busy", "turned-off", "replace-running", "distribution", "translocated", "interrupted", "other-root", "manager-unavailable", "other"]);
export type ServiceActionReason = z.infer<typeof serviceActionReasonSchema>;
export const serviceOutcomeKindSchema = z.enum([
  "installed", "already-installed", "uninstalled", "not-installed",
  "install_refused", "install_rolled_back", "install_incomplete", "uninstall_refused", "uninstall_rolled_back", "uninstall_incomplete",
]);
/** The last `vonvon service install|uninstall`: running while its helper lives, then its result. */
export const serviceActionReportSchema = z.object({
  action: z.enum(["install", "uninstall"]), phase: z.enum(["running", "done"]),
  ok: z.boolean().optional(), kind: serviceOutcomeKindSchema.optional(), reason: serviceActionReasonSchema.optional(), detail: z.string().optional(),
  startedAt: z.number(), finishedAt: z.number().optional(),
  /** The bot was started again, detached, on the port it had before (`--keep-running`). */
  restarted: z.object({ pid: z.number() }).optional(), restartError: z.string().optional(),
});
export type ServiceActionReport = z.infer<typeof serviceActionReportSchema>;
/** The login-time service as the daemon sees it (3.10): the manager's state, why installing is impossible, and the user's choices. */
export const applicationServiceSchema = z.object({
  state: serviceStateSchema, detail: z.string().optional(),
  blocked: z.enum(["development", "translocated"]).optional(),
  skipped: z.boolean(),
  action: serviceActionReportSchema.optional(),
});
export type ApplicationService = z.infer<typeof applicationServiceSchema>;
const jobBase = { id: jobIdSchema, type: z.enum(["registerAgent", "installCodex", "loginCodex"]) };
export const jobSchema = z.discriminatedUnion("phase", [
  z.object({ ...jobBase, phase: z.literal("running"), message: z.string() }),
  z.object({ ...jobBase, phase: z.literal("unresolved"), message: z.string() }),
  z.object({ ...jobBase, phase: z.literal("qr"), image: z.string(), url: z.string(), expiresAt: z.number(), status: z.string().optional() }),
  z.object({ ...jobBase, phase: z.literal("authorizing"), userCode: z.string(), verificationUrl: z.string().optional() }),
  z.object({ ...jobBase, phase: z.literal("activating"), message: z.string() }),
  z.object({ ...jobBase, phase: z.literal("succeeded"), message: z.string(), agentId: agentIdSchema.optional() }),
  z.object({ ...jobBase, phase: z.literal("failed"), message: z.string(), code: z.string().optional() }),
  z.object({ ...jobBase, phase: z.literal("cancelled"), message: z.string() }),
]);
export type Job = z.infer<typeof jobSchema>;
export const diagnosticSchema = z.object({ title: z.string(), message: z.string(), status: z.enum(["ok", "warning", "error"]), eventConfigUrl: z.string().optional() });
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export const desktopSnapshotSchema = z.object({
  revision: z.number(), observedAt: z.number(), stale: z.boolean(), host: hostStateSchema,
  agents: z.array(agentSchema), groups: z.array(groupSchema), memberships: z.array(membershipSchema),
  tools: z.array(toolStateSchema), jobs: z.array(jobSchema), diagnostics: z.array(diagnosticSchema),
  application: z.object({ platform: z.enum(["macos", "windows", "unsupported"]), version: z.string(), loginItem: z.boolean(), dataPath: z.string(), service: applicationServiceSchema.optional() }),
});
export type DesktopSnapshot = z.infer<typeof desktopSnapshotSchema>;
export const folderChoiceSchema = z.object({ token: folderTokenSchema, displayPath: z.string() });
export type FolderChoice = z.infer<typeof folderChoiceSchema>;
export const pendingGroupSchema = z.object({chatId: groupIdSchema, name: z.string().min(1).max(1000), addedAt: z.number().finite().nonnegative()});
export const pendingGroupsSchema = z.object({groups: z.array(pendingGroupSchema).max(1000)});
export type PendingGroup = z.infer<typeof pendingGroupSchema>;
export const commandResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pendingGroups"), groups: z.array(pendingGroupSchema) }),
  z.object({ kind: z.literal("applied"), revision: z.number() }),
  z.object({ kind: z.literal("started"), jobId: jobIdSchema }),
  z.object({ kind: z.literal("folderChosen"), folder: folderChoiceSchema }),
  z.object({ kind: z.literal("groups"), groups: z.array(z.object({ id: groupIdSchema, name: z.string(), bound: z.boolean() })), nextCursor: z.string().optional() }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("activationPending"), message: z.string() }),
  z.object({ kind: z.literal("refused"), code: z.string(), message: z.string() }),
  z.object({ kind: z.literal("outcomeUnknown"), message: z.string() }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;
export const commandReplySchema = z.object({ command: z.custom<Command["type"]>(value => typeof value === "string" && commandSchema.optionsMap.has(value)), result: commandResultSchema });
export type CommandReply = z.infer<typeof commandReplySchema>;
