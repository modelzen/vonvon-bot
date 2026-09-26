import { z } from "zod";
import type { SettingsReply, SettingsRequest } from "./settings";
import type {MachineReply, MachineRequest} from './machine';
import type {CollaborationClient} from './collaboration';
import type {EnvironmentReply, EnvironmentRequest} from './environment';

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
  z.object({type: z.literal("openEventSettings"), url: z.string().regex(/^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/app\/cli_[\w-]{1,200}\/event$/)}).strict(),
  empty("chooseFolder"),
  empty("registerAgent"),
  z.object({type: z.literal("refreshAgentCredentials"), agentId: agentIdSchema}).strict(),
  empty("installCodex"),
  empty("startCodexLogin"),
  empty("restartHost"),
  empty("quit"),
  empty("hideWindow"),
  z.object({ type: z.literal("setLoginItem"), enabled: z.boolean() }).strict(),
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
export type HostState =
  | { kind: "starting" }
  | { kind: "connected"; ownership: "owned" | "attached"; version: string }
  | { kind: "blocked"; message: string }
  | { kind: "disconnected"; message: string };
export type Agent = {
  id: AgentId;
  name: string;
  avatarDataUrl?: string;
  enabled: boolean;
  connection: string;
  activation: "active" | "restartRequired";
  readError?: string;
};
export type Membership = {
  avatarDataUrl?: string;
  id: MembershipId;
  agentId: AgentId;
  groupId: GroupId;
  name: string;
  directory: string;
  backend: string;
  conversation: "threads" | "shared";
  response: "mention" | "all";
  permission: {
    administrator: Permission;
    member: Permission;
    network: boolean;
  };
  stale: boolean;
};
export type Group = { id: GroupId; name: string; avatarDataUrl?: string };
export type ToolState = {
  tool: Tool;
  installation: "missing" | "installed" | "unknown";
  authentication: "signedOut" | "signedIn" | "notRequired" | "unknown";
  version: string | null;
  message?: string;
};
type JobBase = {
  id: JobId;
  type: "registerAgent" | "installCodex" | "loginCodex";
};
export type Job = JobBase &
  (
    | { phase: "running" | "unresolved"; message: string }
    | { phase: "qr"; image: string; url: string; expiresAt: number }
    | { phase: "authorizing"; userCode: string }
    | { phase: "activating"; message: string }
    | { phase: "succeeded" | "failed" | "cancelled"; message: string }
  );
export type Diagnostic = {
  title: string;
  message: string;
  status: "ok" | "warning" | "error";
  eventConfigUrl?: string;
};
export type DesktopSnapshot = {
  revision: number;
  observedAt: number;
  stale: boolean;
  host: HostState;
  agents: Agent[];
  groups: Group[];
  memberships: Membership[];
  tools: ToolState[];
  jobs: Job[];
  diagnostics: Diagnostic[];
  application: {
    platform: "macos" | "windows" | "unsupported";
    version: string;
    loginItem: boolean;
    dataPath: string;
  };
};
export type FolderChoice = { token: FolderToken; displayPath: string };
export type CommandResult =
  | { kind: "applied"; revision: number }
  | { kind: "started"; jobId: JobId }
  | { kind: "folderChosen"; folder: FolderChoice }
  | {
      kind: "groups";
      groups: { id: GroupId; name: string; bound: boolean }[];
      nextCursor?: string;
    }
  | { kind: "cancelled" }
  | { kind: "activationPending"; message: string }
  | { kind: "refused"; code: string; message: string }
  | { kind: "outcomeUnknown"; message: string };
export type CommandReply = { command: Command["type"]; result: CommandResult };
export interface DesktopBridge {
  collaboration: CollaborationClient;
  environment(request: EnvironmentRequest): Promise<EnvironmentReply>;
  machine(request: MachineRequest): Promise<MachineReply>;
  onQuitRequested(listener: () => void): () => void;
  watch(listener: (snapshot: DesktopSnapshot) => void): () => void;
  run(command: Command): Promise<CommandResult>;
  settings(request: SettingsRequest): Promise<SettingsReply>;
}
declare global {
  interface Window {
    bridge: DesktopBridge;
  }
}
