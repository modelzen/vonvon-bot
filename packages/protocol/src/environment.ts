import { z } from "zod";

export const environmentToolSchema = z.enum(["codex", "claude", "lark-cli"]);
export type EnvironmentTool = z.infer<typeof environmentToolSchema>;
const name = z.string().trim().min(1).max(128).regex(/^[^\x00-\x1f]+$/);
const operationId = z.string().uuid();
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
  z.object({ type: z.literal("backendInstall"), id: z.string().regex(/^[a-z0-9-]{1,80}$/), update: z.boolean() }).strict(),
  z.object({ type: z.literal("backendUninstall"), id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ type: z.literal("install"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("update"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("toolInstallStatus") }).strict(),
  z.object({ type: z.literal("cancelInstall"), operationId }).strict(),
  z.object({ type: z.literal("uninstall"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("authStatus"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("startLogin"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("loginStatus") }).strict(),
  z.object({ type: z.literal("openVerification"), operationId }).strict(),
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
export const toolInstallOperationSchema = z.union([
  z.object({kind:z.literal("running"), id:z.string(), tool:environmentToolSchema, update:z.boolean(), startedAt:z.number()}),
  z.object({kind:z.enum(["succeeded", "failed", "cancelled"]), id:z.string(), message:z.string()}),
]);
export type ToolInstallOperation = z.infer<typeof toolInstallOperationSchema>;
export const environmentReplySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("tools"), tools:z.array(environmentToolStateSchema)}),
  z.object({kind:z.literal("backends"), entries:z.array(backendEntrySchema)}),
  z.object({kind:z.literal("backendVersion"), id:z.string(), installed:z.string().nullable(), latest:z.string().nullable(), hasUpdate:z.boolean().nullable()}),
  z.object({kind:z.literal("profiles"), profiles:z.array(environmentProfileSchema)}),
  z.object({kind:z.literal("auth"), tool:environmentToolSchema, state:z.enum(["signedIn", "signedOut", "unknown"]), message:z.string()}),
  z.object({kind:z.literal("operation"), operation:environmentOperationSchema.nullable()}),
  z.object({kind:z.literal("toolInstall"), operation:toolInstallOperationSchema.nullable()}),
  z.object({kind:z.literal("applied"), message:z.string()}),
  z.object({kind:z.literal("backendInstall"), operationId, id:z.string(), update:z.boolean(), attached:z.boolean(), replay:z.array(backendInstallItemSchema), omittedBytes:z.number().int().nonnegative().optional()}),
  z.object({kind:z.literal("refused"), code:z.string(), message:z.string()}),
]);
export type EnvironmentReply = z.infer<typeof environmentReplySchema>;
