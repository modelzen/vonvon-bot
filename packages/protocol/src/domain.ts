import { z } from "zod";
import {groupDecisionSchema} from "./group-decision.js";
import { botDiagnosticsSchema } from "./diagnostics.js";
import { applicationCrashesSchema, crashPauseSchema, lockHeldSchema } from "./crash.js";

export const agentIdSchema = z
  .string()
  .regex(/^cli_[A-Za-z0-9_-]{1,200}$/)
  .brand<"AgentId">();
export const groupIdSchema = z
  .string()
  .regex(/^oc_[A-Za-z0-9_-]{1,200}$/)
  .brand<"GroupId">();
/** A project of the library (daemon project/library.ts): `prj_` and eight hex digits. */
export const projectIdSchema = z
  .string()
  .regex(/^prj_[0-9a-f]{8}$/)
  .brand<"ProjectId">();
export type ProjectId = z.infer<typeof projectIdSchema>;
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
export const folderSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("existing"), folderToken: folderTokenSchema }).strict(),
]);
export const permissionSchema = z.enum(["qa", "write", "full"]);
export const toolSchema = z.enum(["codex", "claude"]);
/** 会话方式 on the wire: threads = 多会话（@ 我开新会话）, shared = 单会话（整群一条会话）, smart = 智能（智能开话题，s25c）. */
export const conversationSchema = z.enum(["threads", "shared", "smart"]);
export type Conversation = z.infer<typeof conversationSchema>;
/** product.md 3.4 的叫法、主标题、副标题，三个绑定入口按这个顺序列。 */
export const conversationCopy = {
  threads: { name: "多会话", title: "@ 我开新会话", subtitle: "在主区 @ 我就开一个话题，一个话题一条会话，几件事各聊各的" },
  shared: { name: "单会话", title: "整群一条会话", subtitle: "主区一条会话，上下文一直连着；想另起一件事，开个话题和我聊" },
  smart: { name: "智能", title: "智能开话题", subtitle: "主区一条会话，不用 @ 我也会看情况接话；聊到新的事，我自己开话题、起新会话" },
} as const;
/** 话题群和话题形式群没有主区：多会话、单会话合成“按话题聊”（存成多会话），和智能二选一（3.4）。 */
export const topicConversationCopy = {
  threads: { name: "按话题聊", title: "按话题聊", subtitle: "一个话题一条会话，几件事各聊各的" },
  smart: { name: "智能", title: "智能开话题", subtitle: "一个话题一条会话，不用 @ 我也会看情况接话" },
} as const;
/** 会话方式 as the daemon stores it (`sessionModeOf`): multi = 多会话, single = 单会话, smart = 智能. */
export type SessionMode = "multi" | "single" | "smart";
const MODES = { threads: "multi", shared: "single", smart: "smart" } as const satisfies Record<Conversation, SessionMode>;
export const conversationToMode = (conversation: Conversation): SessionMode => MODES[conversation];
export const modeToConversation = (mode: SessionMode): Conversation => mode === "multi" ? "threads" : mode === "single" ? "shared" : "smart";
/** 免@ on the wire: all = 开 (no @ needed), mention = 关. Left out on a bind: 多会话开，单会话关 (product.md 3.4). */
export const replyModeSchema = z.enum(["mention", "all"]);
export type AgentId = z.infer<typeof agentIdSchema>;
export type GroupId = z.infer<typeof groupIdSchema>;
export type MembershipId = z.infer<typeof membershipIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export type FolderToken = z.infer<typeof folderTokenSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type Tool = z.infer<typeof toolSchema>;

const empty = <T extends string>(type: T) =>
  z.object({ type: z.literal(type) }).strict();
export const MAX_BADGE_NUMBER_LENGTH = 7;
export const badgeNumberSchema = z.string().min(1).max(MAX_BADGE_NUMBER_LENGTH).regex(/^\d+$/);
export const bindGroupCommandSchema = z
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
      folder: folderSelectionSchema,
      /** Join this project instead of making one; with it the folder is not used and must be `default`. */
      project: projectIdSchema.optional(),
      tool: toolSchema,
      conversation: conversationSchema,
      judge: groupDecisionSchema.optional(),
      response: replyModeSchema.optional(),
    })
    .strict();

export const commandSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("refresh"), tools: z.boolean().optional()}).strict(),
  z.object({type: z.literal("listPendingGroups"), agentId: agentIdSchema}).strict(),
  empty("registerAgent"),
  z.object({type: z.literal("refreshAgentCredentials"), agentId: agentIdSchema}).strict(),
  empty("restartHost"),
  z
    .object({
      type: z.literal("listJoinedGroups"),
      agentId: agentIdSchema,
      cursor: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  z.object({type: z.literal("readGroupIdentity"), agentId: agentIdSchema, groupId: groupIdSchema}).strict(),
  z.object({ type: z.literal("listGroupMembers"), agentId: agentIdSchema, groupId: groupIdSchema, cursor: z.string().min(1).max(2048).optional() }).strict(),
  /**
   * dm-agent 7.3: a read of a Bot's Feishu tools, by the tool's name and its arguments, which the daemon checks as the tool
   * does. No `agentId`: the daemon picks the Bot, the session's or the one bound to the chat asked about.
   */
  z.object({ type: z.literal("feishuRead"), agentId: agentIdSchema.optional(), tool: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) }).strict(),
  bindGroupCommandSchema,
  z
    .object({
      type: z.literal("setResponse"),
      membershipId: membershipIdSchema,
      response: replyModeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("setPermission"),
      membershipId: membershipIdSchema,
      administrator: permissionSchema,
      /** @deprecated s31c: network is derived from the tier; a contradictory old value is rejected. */
      network: z.boolean().optional(),
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
  z.object({type: z.literal("setAgentBadgeNumber"), agentId: agentIdSchema, badgeNumber: badgeNumberSchema}).strict(),
  z.object({ type: z.literal("cancelJob"), jobId: jobIdSchema }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const hostStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("connected"), ownership: z.enum(["owned", "attached"]), version: z.string() }),
  z.object({ kind: z.literal("blocked"), message: z.string() }),
  z.object({ kind: z.literal("disconnected"), message: z.string() }),
]);
export type HostState = z.infer<typeof hostStateSchema>;
/** Remote connections only: the picture's reference on that connection. With `avatarDataUrl` it names that picture; alone,
 * the picture went out earlier on the same connection. The client library puts the picture back and drops this before
 * anyone reads the snapshot; a reader that does not know it sees no picture (0.9.0 Mac 验收: avatars over a slow link). */
const avatarRef = z.string().optional();
/** A group directory an older version left in the wrong place (s36c2d): a bot's own directory, the projects root
 * itself, in the data directory outside `projects/`, or a folder above the data directory. */
export const directoryProblemSchema = z.enum(["botRoot", "projectsRoot", "dataDir", "dataDirParent"]);
export type DirectoryProblem = z.infer<typeof directoryProblemSchema>;
export const membershipSchema = z.object({
  avatarDataUrl: z.string().optional(), avatarRef, id: membershipIdSchema, agentId: agentIdSchema,
  groupId: groupIdSchema, name: z.string(), directory: z.string(), backend: z.string(),
  bindingIncarnation: z.string().uuid().optional(),
  /** The library project this binding belongs to; absent until the daemon has linked the row (daemon start), and from older daemons. */
  projectId: projectIdSchema.optional(),
  /** Absent when the directory is fine, and from daemons before s36c2d. */
  directoryProblem: directoryProblemSchema.optional(),
  conversation: conversationSchema, response: replyModeSchema,
  /** The mode the group really runs in (the daemon's `groupPermission(row).effect.mode`), which the stored `permission` tier can be wider than: a custom permission or s31d's native settings make it narrower (D8). Absent from older daemons; no client guesses it from `permission`. */
  effectMode: permissionSchema.optional(),
  /** Actual project activation; older daemons omit this field. */
  enabled: z.boolean().optional(),
  permission: z.object({
    administrator: permissionSchema,
    /** @deprecated since s15c always equal to the group's one tier; kept so clients from before s15c still parse */
    member: permissionSchema,
    network: z.boolean(),
  }),
  stale: z.boolean(),
});
export type Membership = z.infer<typeof membershipSchema>;
export const agentSchema = z.object({
  id: agentIdSchema, name: z.string(), avatarDataUrl: z.string().optional(), avatarRef,
  enabled: z.boolean(), running: z.boolean(), connection: z.string(),
  activation: z.enum(["active", "restartRequired"]), readError: z.string().optional(),
  badgeNumber: badgeNumberSchema.optional(),
  /** The bot's recent not-replied messages and scope denials; absent when it has none. */
  diagnostics: botDiagnosticsSchema.optional(),
  /** This bot alone stopped restarting after 3 crashes in 10 minutes (s18a); absent from older daemons. */
  paused: crashPauseSchema.optional(),
  lockHeld: lockHeldSchema.optional(),
  /** Local registration date and the display name of the confirmed Feishu application owner. */
  registeredAt: z.number().finite().nonnegative().optional(),
  registrationId: z.string().max(128).optional(),
  ownerName: z.string().optional(),
  /** Which client opens this Bot; absent from older daemons, read as Feishu. */
  tenant: z.enum(["feishu", "lark"]).optional(),
  /** This Bot's private chat, with the synthetic group id `oc_dm_<appId>`. Beside `memberships`, so no group list, group
   * directory or search picks it up; absent when preparation failed, and from older daemons. */
  dm: membershipSchema.optional(),
  /** Private-chat preparation/read failure; independent of group configuration and absent from older daemons. */
  dmError: z.string().optional(),
});
export type Agent = z.infer<typeof agentSchema>;
/** A library project and the bindings that share it, as the snapshot shows them. */
export const snapshotProjectSchema = z.object({
  id: projectIdSchema, name: z.string(), revision: z.number().int().min(1),
  /** The main folder of the project's workspace. */
  directory: z.string(),
  bindings: z.array(z.object({ agentId: agentIdSchema, groupId: groupIdSchema })),
});
export type SnapshotProject = z.infer<typeof snapshotProjectSchema>;
export const groupSchema = z.object({ id: groupIdSchema, name: z.string(), avatarDataUrl: z.string().optional(), avatarRef });
export type Group = z.infer<typeof groupSchema>;
/** Codex only: how its version compares with the minimum and the tested version. */
export const codexCompatibilitySchema = z.object({ status: z.enum(["ok", "tooOld", "newer", "unknown"]), minimum: z.string(), verified: z.string() });
/** `bwrap` found on the daemon's PATH, `socat` too, and whether a trial `bwrap --unshare-all` ran; `detail` names the
 * setting that is 0 (`disabled`) or the first stderr line (`failed`). */
export const claudeSandboxSchema = z.object({
  bwrap: z.string().nullable(), socat: z.boolean(),
  userns: z.enum(["ok", "apparmor", "disabled", "failed", "unchecked"]), detail: z.string().optional(),
});
export type ClaudeSandbox = z.infer<typeof claudeSandboxSchema>;
/** The daemon's trial `bwrap` arguments, also printed when the trial fails: user and network namespaces, the two
 * refusals hit on JP-VPS. */
export const BWRAP_TRIAL = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-all", "--die-with-parent", "true"];
export const toolStateSchema = z.object({
  tool: toolSchema, installation: z.enum(["missing", "installed", "unknown"]),
  authentication: z.enum(["signedOut", "signedIn", "notRequired", "unknown"]),
  version: z.string().nullable(), message: z.string().optional(),
  compatibility: codexCompatibilitySchema.optional(),
  /** Claude on Linux: what its bubblewrap sandbox for the qa and write modes needs (s20a). */
  sandbox: claudeSandboxSchema.optional(),
  /** What to type in a terminal to start the Codex in use, or the Claude Code CLI, when it is a managed copy, which is on
   * no PATH (0.9.0 Linux acceptance). Absent: the name is enough. */
  command: z.string().max(4096).optional(),
});
export type ToolState = z.infer<typeof toolStateSchema>;
export const serviceStateSchema = z.enum(["not-installed", "running", "stopped", "disabled", "detached", "conflict", "unknown"]);
export type ServiceState = z.infer<typeof serviceStateSchema>;
/** How this daemon was installed (devices 7.1). `standalone` is the script-installed server package. */
export const distributionKinds = ["global-npm", "bundled", "standalone", "development", "unknown"] as const;
export type DistributionKind = (typeof distributionKinds)[number];
/** The kind parses as an open string, so a client does not fail on a kind that a newer daemon adds. */
export const distributionSchema = z.object({ kind: z.string().min(1), cliPath: z.string() });
/** Linux: whether systemd keeps this account's user services running without a login session (s20a). */
export const lingerStateSchema = z.enum(["on", "off", "unknown"]);
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
  /** Linux: linger, and a sentence on why the user manager cannot be asked. */
  linger: lingerStateSchema.optional(), hint: z.string().optional(),
});
export type ApplicationService = z.infer<typeof applicationServiceSchema>;
const jobBase = { id: jobIdSchema, type: z.enum(["registerAgent"]) };
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
export const desktopSnapshotSchema = z.object({
  attentionModel: z.literal("group").optional(),
  revision: z.number(), observedAt: z.number(), stale: z.boolean(), host: hostStateSchema,
  agents: z.array(agentSchema), groups: z.array(groupSchema), memberships: z.array(membershipSchema),
  /** The project library (memory design §2.5); absent from daemons before it. */
  projects: z.array(snapshotProjectSchema).optional(),
  tools: z.array(toolStateSchema), jobs: z.array(jobSchema),
  recentConversations: z.object({items:z.array(z.object({agentId:agentIdSchema,groupId:groupIdSchema,threadId:z.string(),summary:z.string(),updatedAt:z.number()})),unavailableBots:z.number().int().nonnegative()}).optional(),
  application: z.object({ platform: z.enum(["macos", "linux", "windows", "unsupported"]), version: z.string(), loginItem: z.boolean(), dataPath: z.string(), service: applicationServiceSchema.optional(),
    /** The whole daemon's pause and the last day's crash records (s18a); absent from older daemons. */
    crashes: applicationCrashesSchema.optional() }),
});
export type DesktopSnapshot = z.infer<typeof desktopSnapshotSchema>;
export const folderChoiceSchema = z.object({ token: folderTokenSchema, displayPath: z.string() });
export type FolderChoice = z.infer<typeof folderChoiceSchema>;
export const pendingGroupSchema = z.object({chatId: groupIdSchema, name: z.string().min(1).max(1000), addedAt: z.number().finite().nonnegative(), topic: z.boolean().optional(), hasOtherBots: z.boolean().optional()});
export const pendingGroupsSchema = z.object({groups: z.array(pendingGroupSchema).max(1000)});
export type PendingGroup = z.infer<typeof pendingGroupSchema>;
export const groupIdentitySchema = z.object({kind: z.literal("groupIdentity"), agentId: agentIdSchema, groupId: groupIdSchema, name: z.string().trim().min(1).max(1000)}).strict();
export type GroupIdentity = z.infer<typeof groupIdentitySchema>;
export const commandResultSchema = z.discriminatedUnion("kind", [
  groupIdentitySchema,
  z.object({ kind: z.literal("pendingGroups"), groups: z.array(pendingGroupSchema) }),
  z.object({ kind: z.literal("applied"), revision: z.number() }),
  z.object({ kind: z.literal("started"), jobId: jobIdSchema }),
  z.object({ kind: z.literal("folderChosen"), folder: folderChoiceSchema }),
  z.object({ kind: z.literal("members"), members: z.array(z.object({ openId: z.string().min(1), name: z.string() })), nextCursor: z.string().optional() }),
  z.object({ kind: z.literal("groups"), groups: z.array(z.object({ id: groupIdSchema, name: z.string(), bound: z.boolean(), hasOtherBots: z.boolean().optional() })), nextCursor: z.string().optional() }),
  z.object({ kind: z.literal("feishuRead"), result: z.unknown() }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("activationPending"), message: z.string() }),
  z.object({ kind: z.literal("refused"), code: z.string(), message: z.string() }),
  z.object({ kind: z.literal("outcomeUnknown"), message: z.string() }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;
export const commandReplySchema = z.object({ command: z.custom<Command["type"]>(value => typeof value === "string" && commandSchema.optionsMap.has(value)), result: commandResultSchema });
export type CommandReply = z.infer<typeof commandReplySchema>;
