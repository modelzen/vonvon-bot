import { z } from "zod";

/** devices 4.2: what kind of network a remote address is on; only literal IPs, never host names. `overlay` (A1): a
 * virtual network another tool than Tailscale makes (ZeroTier, 蒲公英, EasyTier, NetBird, WireGuard…), told by its
 * interface: the people in that network reach it, not the LAN around the computer. */
export const addressKindSchema = z.enum(["loopback", "tailscale", "overlay", "lan", "cgnat", "public"]);
export type AddressKind = z.infer<typeof addressKindSchema>;
/** `--scope bot=<appId>[,group=<chatId>]` (devices 5.3), sent in admin.negotiate. */
export const scopeSchema = z.object({ bot: z.string().min(1), group: z.string().min(1).optional() }).strict();
export type Scope = z.infer<typeof scopeSchema>;

/** devices 4.3: the connection link `vonvon pair` prints. */
export const pairingLinkSchema = z.object({
  v: z.literal(1),
  /** pk: the device's X25519 public key, base64url, 43 characters */
  device: z.object({ id: z.string(), name: z.string(), pk: z.string() }).strict(),
  addresses: z.array(z.object({ host: z.string(), port: z.number().int().min(1).max(65535), kind: addressKindSchema.exclude(["loopback"]) }).strict()).min(1),
  /** secret: 32 random bytes, base64url */
  invite: z.object({ id: z.string().regex(/^inv_[0-9a-f]{16}$/), secret: z.string(), expiresAt: z.number().int() }).strict(),
  relay: z.null(), account: z.null(),
}).strict();
export type PairingLink = z.infer<typeof pairingLinkSchema>;
export const PAIRING_LINK_PREFIX = "vonvon://pair#";
function toBase64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("invalid_pairing_link");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
export function encodePairingLink(link: PairingLink): string {
  return PAIRING_LINK_PREFIX + toBase64url(JSON.stringify(pairingLinkSchema.parse(link)));
}
/** Takes the whole link or only the part after `#`. */
export function decodePairingLink(text: string): PairingLink {
  const trimmed = text.trim();
  const body = trimmed.startsWith(PAIRING_LINK_PREFIX) ? trimmed.slice(PAIRING_LINK_PREFIX.length) : trimmed;
  try { return pairingLinkSchema.parse(JSON.parse(fromBase64url(body))); }
  catch { throw new Error("invalid_pairing_link"); }
}
/** One entry of `<dataRoot>/clients.json` (devices 4.3); a revoked client stays, with `revokedAt`. */
export const clientRecordSchema = z.object({
  id: z.string().regex(/^cl_[0-9a-f]{16}$/), name: z.string().min(1).max(40), publicKey: z.string(),
  clientKind: z.enum(["desktop", "cli", "web"]), createdAt: z.number().int(), lastSeenAt: z.number().int(),
  /** invitedBy: 'local', or the id of the paired client whose RPC made the invite */
  lastAddress: z.string(), pairedVia: z.literal("invite"), invitedBy: z.string(),
  revokedAt: z.number().int().optional(),
}).strict();
export type ClientRecord = z.infer<typeof clientRecordSchema>;
/** The one frame an unpaired connection may send, inside the secure channel (devices 4.3, D2). */
export const pairRequestSchema = z.object({
  type: z.literal("pairRequest"), inviteId: z.string(), inviteSecret: z.string(),
  clientName: z.string().min(1).max(40), clientKind: clientRecordSchema.shape.clientKind,
}).strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;
export const pairResultSchema = z.object({ type: z.literal("pairResult"), clientId: z.string(), deviceName: z.string() }).strict();
export type PairResult = z.infer<typeof pairResultSchema>;

/** D3: an opened address is listened on, waits for its address or port, waits for the owner after its LAN changed, is not
 * listened on because the daemon is not running (the CLI's files path), or failed to bind for another reason (`detail`). */
export const remoteAddressStateSchema = z.enum(["listening", "waiting", "needs-confirmation", "disabled", "failed"]);
const deviceIdentitySchema = z.object({ id: z.string(), name: z.string(), publicKey: z.string() }).strict();
/** devices-ui-3 4.1: an address this device could open now, as `vonvon remote candidates` lists it (A1's filter and
 * order; the hidden ones are left out). `tool`: the network tool its interface names (Tailscale, ZeroTier, …). */
export const candidateSchema = z.object({
  host: z.string(), kind: addressKindSchema.exclude(["loopback"]), iface: z.string().optional(), tool: z.string().optional(),
}).strict();
export type AddressCandidate = z.infer<typeof candidateSchema>;
export const deviceStatusSchema = z.object({
  device: deviceIdentitySchema,
  /** addresses: the one address other devices reach this one on, or none (A1: one at a time; a list, so the shape stays).
   * candidates (devices-ui-3): the addresses it could open now, the opened one among them while it is on an interface. */
  remote: z.object({ port: z.number().int(), addresses: z.array(z.object({
    host: z.string(), kind: addressKindSchema, enabledAt: z.number().int(), state: remoteAddressStateSchema, detail: z.string().optional(),
  }).strict()), candidates: z.array(candidateSchema).optional() }).strict(),
  clients: z.object({ total: z.number().int(), active: z.number().int() }).strict(),
  /** devices-ui-3: the remote address the caller came in on; none on the loopback. */
  via: z.string().optional(),
}).strict();
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
export const deviceRequestSchema = z.discriminatedUnion("type", [
  /** refresh (devices-ui-3): read the interfaces again now, not the list kept for 30 seconds (the panel's 刷新). */
  z.object({ type: z.literal("status"), refresh: z.boolean().optional() }).strict(),
  /** A1: the one address other devices reach this one on; another one replaces it, and the old one stops listening. */
  z.object({ type: z.literal("enable"), host: z.string(), allowPublic: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("disable"), host: z.string() }).strict(),
  z.object({ type: z.literal("setPort"), port: z.number().int().min(1024).max(65535) }).strict(),
  z.object({ type: z.literal("pair"), ttlMs: z.number().int().min(60_000).max(600_000).optional() }).strict(),
  z.object({ type: z.literal("clients") }).strict(),
  z.object({ type: z.literal("renameClient"), clientId: z.string(), name: z.string().min(1).max(40) }).strict(),
  z.object({ type: z.literal("revokeClient"), clientId: z.string(), cascade: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("rename"), name: z.string().min(1).max(40) }).strict(),
]);
export type DeviceRequest = z.infer<typeof deviceRequestSchema>;
export const deviceReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deviceStatus"), status: deviceStatusSchema }).strict(),
  z.object({ kind: z.literal("pairingLink"), link: z.string(), inviteId: z.string(), expiresAt: z.number().int() }).strict(),
  /** self (devices-ui-3): the caller's own client id, when it is a paired client; none on the loopback. */
  z.object({ kind: z.literal("clients"), generation: z.number().int(), clients: z.array(clientRecordSchema), self: z.string().optional() }).strict(),
  z.object({ kind: z.literal("revoked"), revoked: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("device"), device: deviceIdentitySchema }).strict(),
  z.object({ kind: z.literal("refused"), code: z.string(), message: z.string() }).strict(),
]);
export type DeviceReply = z.infer<typeof deviceReplySchema>;

/** devices 4.7: the code a server closes with; the close reason is the key. */
export const CLOSE_CODES = {
  protocol_mismatch: 4001, unknown_client: 4002, client_revoked: 4003, rate_limited: 4004,
  handshake_failed: 4005, remote_disabled: 4006, pairing_failed: 4007,
  server_shutdown: 1001, policy_violation: 1008, unauthorized: 4401,
} as const;
export type CloseReason = keyof typeof CLOSE_CODES;
export const closeReasonSchema = z.enum(Object.keys(CLOSE_CODES) as [CloseReason, ...CloseReason[]]);
/** Pushed when a client is paired or revoked (devices 4.3); D4a sends it to the owner's connections only. */
export const deviceEventPayloadSchema = z.object({
  change: z.enum(["client-paired", "client-revoked"]),
  clientId: z.string(), name: z.string(), clientKind: z.string(), address: z.string().optional(), invitedBy: z.string().optional(),
}).strict();
export type DeviceEventPayload = z.infer<typeof deviceEventPayloadSchema>;
export const deviceEventSchema = z.object({ type: z.literal("event"), event: z.literal("device"), payload: deviceEventPayloadSchema }).strict();
