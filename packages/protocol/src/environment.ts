import { z } from "zod";
import { codexCompatibilitySchema } from "./domain.js";

export const environmentToolSchema = z.enum(["codex", "claude", "lark-cli"]);
export type EnvironmentTool = z.infer<typeof environmentToolSchema>;
const name = z.string().trim().min(1).max(128).regex(/^[^\x00-\x1f]+$/);
const operationId = z.guid();
/**
 * Optional on the requests that start a tool or component install (cli-7-environment): the caller's own id for this one
 * request, kept on the operation it starts and shown in that operation's state, so a caller can tell its own operation
 * from another caller's. A daemon from before it refuses the field (strict schema); one that has it echoes it.
 */
const requestId = z.guid().optional();
// These messages travel in the existing install output and survive status replay.
export const backendInstallProgress = {
  installing: '\n正在下载并安装组件…\n',
  verifying: '\n正在校验安装结果…\n',
} as const;
export const backendInstallItemSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("log"),chunk:z.string()}),
  z.object({type:z.literal("done")}),
  z.object({type:z.literal("error"),code:z.enum(["install_failed","aborted","unknown"]),message:z.string()}),
]);
export type BackendInstallItem = z.infer<typeof backendInstallItemSchema>;

export const environmentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scan") }).strict(),
  z.object({ type: z.literal("backendCatalog") }).strict(),
  z.object({ type: z.literal("backendVersion"), id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ type: z.literal("backendInstall"), id: z.string().regex(/^[a-z0-9-]{1,80}$/), update: z.boolean(), requestId }).strict(),
  z.object({ type: z.literal("backendInstallStatus"), id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ type: z.literal("cancelBackendInstall"), operationId }).strict(),
  z.object({ type: z.literal("backendUninstall"), id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ type: z.literal("backendLogin"), id: z.string().regex(/^[a-z0-9-]{1,80}$/), refresh: z.boolean() }).strict(),
  z.object({ type: z.literal("install"), tool: environmentToolSchema, requestId }).strict(),
  z.object({ type: z.literal("update"), tool: environmentToolSchema, requestId }).strict(),
  z.object({ type: z.literal("toolInstallStatus") }).strict(),
  z.object({ type: z.literal("cancelInstall"), operationId }).strict(),
  z.object({ type: z.literal("uninstall"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("authStatus"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("startLogin"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("loginStatus") }).strict(),
  z.object({ type: z.literal("cancelLogin"), operationId }).strict(),
  z.object({ type: z.literal("profileList") }).strict(),
  z.object({ type: z.literal("profileUse"), name }).strict(),
  z.object({ type: z.literal("profileAdd"), name, appId: z.string().trim().min(1).max(256), appSecret: z.string().min(1).max(512).regex(/^[^\r\n\x00]+$/), brand: z.enum(["feishu", "lark"]), use: z.boolean() }).strict(),
  z.object({ type: z.literal("profileInit"), name }).strict(),
  z.object({ type: z.literal("profileInitStatus") }).strict(),
  z.object({ type: z.literal("profileInitCancel"), operationId }).strict(),
]);
export type EnvironmentRequest = z.infer<typeof environmentRequestSchema>;

export const environmentProfileSchema = z.object({
  name,
  appId: z.string().min(1).max(256),
  brand: z.enum(["feishu", "lark"]),
  active: z.boolean(),
  effective: z.boolean().optional(),
  effectiveSource: z.string().max(128).optional(),
  user: z.string().max(256).optional(),
  tokenStatus: z.string().max(128).optional(),
});
export type EnvironmentProfile = z.infer<typeof environmentProfileSchema>;

export const backendEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  displayName: z.string().max(160),
  depKind: z.string().max(40),
  depState: z.string().max(40),
  installable: z.boolean(),
  version: z.string().nullable(),
  installedVersion: z.string().nullable(),
  canUninstall: z.boolean(),
  hint: z.string().max(2000).optional(),
}).passthrough();
export type BackendEntry = z.infer<typeof backendEntrySchema>;
export const environmentToolStateSchema = z.object({
  tool: environmentToolSchema, installation: z.enum(["missing", "managed", "external"]),
  executable: z.string().nullable(), version: z.string().nullable(), managedVersion: z.string().nullable(),
  latestVersion: z.string().nullable(), updateAvailable: z.boolean().nullable(), canUninstall: z.boolean(),
  runtimeStatus: z.enum(["ready", "failed", "unknown"]).optional(),
  source: z.enum(["app", "npm", "homebrew", "standalone", "explicit", "managed", "unknown"]).optional(),
  updateInstructions: z.string().max(2000).optional(),
  compatibility: codexCompatibilitySchema.optional(),
  /** A managed copy only: what to type in a terminal to start it, which is on no PATH (0.9.0 Linux acceptance); the texts
   * that send someone to a terminal name it in place of the tool's name. Absent from a daemon from before it. */
  command: z.string().max(4096).optional(),
});
export type EnvironmentToolState = z.infer<typeof environmentToolStateSchema>;
const operationPurposeSchema = z.union([
  z.object({kind:z.literal("login"), tool:environmentToolSchema}),
  z.object({kind:z.literal("profileInit")}),
]);
export const environmentOperationSchema = z.union([
  z.object({kind:z.literal("running"), id:z.string(), purpose:operationPurposeSchema, url:z.string().optional(), startedAt:z.number()}),
  z.object({kind:z.enum(["succeeded", "failed", "cancelled", "timedOut"]), id:z.string(), message:z.string()}),
]);
export type EnvironmentOperation = z.infer<typeof environmentOperationSchema>;
/** `requestId`: the one its starting request carried; absent when that request had none, or from a daemon from before it. */
const echoedRequestId = z.string().max(64).optional();
export const toolInstallOperationSchema = z.union([
  z.object({kind:z.literal("running"), id:z.string(), tool:environmentToolSchema, update:z.boolean(), startedAt:z.number(), requestId:echoedRequestId}),
  z.object({kind:z.enum(["succeeded", "failed", "cancelled"]), id:z.string(), message:z.string(), requestId:echoedRequestId}),
]);
export type ToolInstallOperation = z.infer<typeof toolInstallOperationSchema>;
export const backendInstallStatusSchema = z.object({
  operationId, id: z.string(), update: z.boolean(), requestId: echoedRequestId,
  state: z.enum(["running", "succeeded", "failed", "cancelled"]),
  replay: z.array(backendInstallItemSchema),
  omittedBytes: z.number().int().nonnegative(),
});
export type BackendInstallStatus = z.infer<typeof backendInstallStatusSchema>;
/** Safe account metadata only: no credential, email or account identifier. */
export const backendAccountSchema = z.object({
  kind: z.enum(["subscription", "free", "api", "unknown"]),
  planType: z.string().max(80).optional(),
  apiProvider: z.string().max(80).optional(),
});
export type BackendAccount = z.infer<typeof backendAccountSchema>;

export const environmentReplySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("tools"), tools:z.array(environmentToolStateSchema)}),
  z.object({kind:z.literal("backends"), entries:z.array(backendEntrySchema)}),
  z.object({kind:z.literal("backendVersion"), id:z.string(), installed:z.string().nullable(), latest:z.string().nullable(), hasUpdate:z.boolean().nullable()}),
  z.object({kind:z.literal("profiles"), profiles:z.array(environmentProfileSchema)}),
  z.object({kind:z.literal("auth"), tool:environmentToolSchema, state:z.enum(["signedIn", "signedOut", "unknown"]), message:z.string()}),
  z.object({kind:z.literal("backendLogin"), id:z.string(), state:z.enum(["signedIn", "signedOut", "notRequired", "unknown"]), message:z.string(), account:backendAccountSchema.optional()}),
  z.object({kind:z.literal("operation"), operation:environmentOperationSchema.nullable()}),
  z.object({kind:z.literal("toolInstall"), operation:toolInstallOperationSchema.nullable()}),
  z.object({kind:z.literal("applied"), message:z.string()}),
  z.object({kind:z.literal("backendInstall"), operationId, id:z.string(), update:z.boolean(), attached:z.boolean(), replay:z.array(backendInstallItemSchema), omittedBytes:z.number().int().nonnegative().optional()}),
  z.object({kind:z.literal("backendInstallStatus"), operation:backendInstallStatusSchema.nullable()}),
  z.object({kind:z.literal("refused"), code:z.string(), message:z.string()}),
]);
export type EnvironmentReply = z.infer<typeof environmentReplySchema>;
