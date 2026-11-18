import { z } from "zod";
import { addressKindSchema } from "./device.js";
import { serverInfoSchema } from "./handshake.js";

/** devices-ui-1a 4.1: what the desktop's main process and its page share about the devices it knows. Only for the desktop
 * (like `desktopUpdateSchema`), so the page parses it without importing the desktop package. */
export const LOCAL_VIEW = "local" as const;
/** 'local', or a remote device's id (its machineId). */
export const viewIdSchema = z.union([z.literal(LOCAL_VIEW), z.guid()]);
export type ViewId = z.infer<typeof viewIdSchema>;
/** The name this computer gives a device: 1 to 40 characters, no control characters. */
export const deviceAliasSchema = z.string().trim().min(1).max(40).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const deviceRouteSchema = z.object({
  host: z.string().min(1).max(64), port: z.number().int().min(1).max(65535),
  kind: addressKindSchema.exclude(["loopback"]),
}).strict();
export type DeviceRoute = z.infer<typeof deviceRouteSchema>;
/** What stops a device from being connected until it is paired again; `key_unreadable` is never written to disk. */
export const deviceProblemSchema = z.enum(["revoked", "identity_changed", "unknown_client", "key_unreadable"]);
export type DeviceProblem = z.infer<typeof deviceProblemSchema>;
/** `code` is a RemoteConnectCode of the desktop, read as an open string. `localNetwork`: macOS 15+ may have blocked this
 * local network address for the app (an immediate EHOSTUNREACH on a LAN or overlay route; Tailscale's VPN interface is not
 * a local network). */
export const routeFailureSchema = z.object({ route: deviceRouteSchema, code: z.string(), localNetwork: z.literal(true).optional() }).strict();
export type RouteFailure = z.infer<typeof routeFailureSchema>;
export const deviceRowStatusSchema = z.enum(["online", "connecting", "reconnecting", "offline", "maintenance", "revoked", "needs-pairing", "unknown"]);
export type DeviceRowStatus = z.infer<typeof deviceRowStatusSchema>;
export const deviceRowSchema = z.object({
  id: viewIdSchema, name: z.string(), current: z.boolean(),
  status: deviceRowStatusSchema,
  platform: z.string().optional(), version: z.string().optional(), protocolVersion: z.number().int().optional(),
  lastConnectedAt: z.number().int().optional(), problem: deviceProblemSchema.optional(),
  /** Empty for this computer. */
  routes: z.array(deviceRouteSchema),
}).strict();
export type DeviceRow = z.infer<typeof deviceRowSchema>;
export const activeDeviceSchema = z.object({
  id: viewIdSchema,
  /** Always 'ready' for this computer: a lost local connection is the shell's, as before. */
  phase: z.enum(["connecting", "ready", "reconnecting", "failed"]),
  /** Set when ready; kept from the last connection while reconnecting, so the page stays or the maintenance view stays. */
  mode: z.enum(["full", "maintenance"]).optional(),
  /** This computer's own; for a remote device, the one from its last connection. */
  serverInfo: serverInfoSchema.optional(),
  attempt: z.number().int().min(0), retryAt: z.number().int().optional(),
  failure: z.object({ code: z.string(), attempts: z.array(routeFailureSchema).max(8), at: z.number().int() }).strict().optional(),
  expected: z.enum(["restart", "stop"]).optional(),
  /** When the device closed its remote connection with 4006; cleared on the next connection or a switch, and later
   * refusals do not replace it. */
  disabledAt: z.number().int().optional(),
  notice: z.object({
    kind: z.enum(["restarted", "updated"]), from: z.string().optional(), to: z.string().optional(), at: z.number().int(),
  }).strict().optional(),
}).strict();
export type ActiveDeviceState = z.infer<typeof activeDeviceSchema>;
export const addingStageSchema = z.enum(["connecting", "pairing", "checking"]);
export const devicesStateSchema = z.object({
  v: z.literal(1), revision: z.number().int(),
  client: z.object({ version: z.string(), protocolVersion: z.number().int() }).strict(),
  registry: z.enum(["ok", "newer", "recovered", "unreadable"]), secureStorage: z.boolean(),
  /** The first is always this computer. */
  devices: z.array(deviceRowSchema).min(1),
  active: activeDeviceSchema,
  adding: z.object({ stage: addingStageSchema, route: deviceRouteSchema.optional() }).strict().optional(),
}).strict();
export type DevicesState = z.infer<typeof devicesStateSchema>;
export const linkPreviewCodeSchema = z.enum(["invalid_link", "link_expired", "own_link", "already_added", "no_secure_storage",
  "registry_newer", "registry_unreadable", "too_many"]);
export type LinkPreviewCode = z.infer<typeof linkPreviewCodeSchema>;
export const linkPreviewSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), deviceId: z.guid(), name: z.string(), routes: z.array(deviceRouteSchema).min(1),
    expiresAt: z.number().int(), repair: z.boolean(),
  }).strict(),
  z.object({
    ok: z.literal(false), code: linkPreviewCodeSchema, deviceId: z.string().optional(), name: z.string().optional(),
    routesChanged: z.boolean().optional(),
  }).strict(),
]);
export type LinkPreview = z.infer<typeof linkPreviewSchema>;
export const addDeviceRequestSchema = z.object({ link: z.string().min(1).max(4096), name: deviceAliasSchema.optional() }).strict();
export type AddDeviceRequest = z.infer<typeof addDeviceRequestSchema>;
export const addDeviceResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), deviceId: z.string(), name: z.string(), repaired: z.boolean() }).strict(),
  /** Added before: only its addresses changed. */
  z.object({ kind: z.literal("updated"), deviceId: z.string(), name: z.string() }).strict(),
  z.object({ kind: z.literal("failed"), code: z.string(), attempts: z.array(routeFailureSchema).max(8) }).strict(),
]);
export type AddDeviceResult = z.infer<typeof addDeviceResultSchema>;
export const removeDeviceResultSchema = z.object({ revokedRemotely: z.boolean() }).strict();
export type RemoveDeviceResult = z.infer<typeof removeDeviceResultSchema>;
