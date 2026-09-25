import { z } from "zod";

export const environmentToolSchema = z.enum(["codex", "claude", "lark-cli"]);
export type EnvironmentTool = z.infer<typeof environmentToolSchema>;
const name = z.string().trim().min(1).max(128).regex(/^[^\x00-\x1f]+$/);
const operationId = z.string().uuid();

export const environmentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scan") }).strict(),
  z.object({ type: z.literal("backendCatalog") }).strict(),
  z.object({ type: z.literal("backendVersion"), id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ type: z.literal("backendInstall"), id: z.string().regex(/^[a-z0-9-]{1,80}$/), update: z.boolean() }).strict(),
  z.object({ type: z.literal("backendUninstall"), id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ type: z.literal("install"), tool: environmentToolSchema }).strict(),
  z.object({ type: z.literal("update"), tool: environmentToolSchema }).strict(),
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
  user: z.string().max(256).optional(),
  tokenStatus: z.string().max(128).optional(),
}).strict();
export type EnvironmentProfile = z.infer<typeof environmentProfileSchema>;

export type EnvironmentToolState = {
  tool: EnvironmentTool;
  installation: "missing" | "managed" | "external";
  executable: string | null;
  version: string | null;
  managedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  canUninstall: boolean;
};
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
export type EnvironmentOperation =
  | { kind: "running"; id: string; purpose: { kind: "login"; tool: EnvironmentTool } | { kind: "profileInit" }; url?: string; startedAt: number }
  | { kind: "succeeded" | "failed" | "cancelled" | "timedOut"; id: string; message: string };
export type EnvironmentReply =
  | { kind: "tools"; tools: EnvironmentToolState[] }
  | { kind: "backends"; entries: BackendEntry[] }
  | { kind: "backendVersion"; id: string; installed: string | null; latest: string | null; hasUpdate: boolean | null }
  | { kind: "profiles"; profiles: EnvironmentProfile[] }
  | { kind: "auth"; tool: EnvironmentTool; state: "signedIn" | "signedOut" | "unknown"; message: string }
  | { kind: "operation"; operation: EnvironmentOperation | null }
  | { kind: "applied"; message: string }
  | { kind: "refused"; code: string; message: string };
