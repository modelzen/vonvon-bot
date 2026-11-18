import { z } from "zod";

/** devices 4.5: 2 since the device slices; the hello is the same, the server info has a v1 and a v2 shape. */
export const PROTOCOL_VERSION = 2;
export const machineIdSchema = z.guid().brand<"MachineId">();
export type MachineId = z.infer<typeof machineIdSchema>;
const protocolVersionSchema = z.number().int().positive();
export const helloSchema = z.object({
  type: z.literal("hello"), protocolVersion: protocolVersionSchema,
  clientKind: z.enum(["desktop", "web", "cli"]),
  credential: z.string().optional(),
}).strict();
export type Hello = z.infer<typeof helloSchema>;
/** Who the daemon took the connection for (devices 5.1); clients read it as an open string. */
export const principalWireSchema = z.enum(["owner:local", "owner:paired", "bot-session:dm", "bot-session:group", "bot-session:comment", "maintenance"]);
export type PrincipalWire = z.infer<typeof principalWireSchema>;
/** What a daemon answers a hello of protocol 1 with, `protocolVersion: 1` included, so a 0.8 client accepts it. */
export const serverInfoV1Schema = z.object({
  type: z.literal("serverInfo"), machineId: machineIdSchema,
  version: z.string().min(1), protocolVersion: protocolVersionSchema,
}).strict();
export const serverInfoV2Schema = serverInfoV1Schema.extend({
  deviceName: z.string(), platform: z.enum(["macos", "linux", "windows", "unsupported"]),
  capabilities: z.array(z.string()), principal: principalWireSchema,
}).strict();
export type ServerInfoV2 = z.infer<typeof serverInfoV2Schema>;
/**
 * What a Bot session's hello gets (Codex review 256-2): what its command line reads, the protocol for the version check
 * and who it is, and the version the client schema wants; nothing of the device (name, machine id, platform, what it can do).
 */
export const serverInfoSessionSchema = z.object({
  type: z.literal("serverInfo"), version: z.string().min(1), protocolVersion: protocolVersionSchema,
  principal: z.enum(["bot-session:dm", "bot-session:group", "bot-session:comment"]),
}).strict();
/** What clients parse: each of the three shapes, unknown fields kept, and no version compared here; the caller decides on a different one. */
export const serverInfoSchema = z.object({
  type: z.literal("serverInfo"), machineId: z.string().optional(), version: z.string(), protocolVersion: z.number().int(),
  deviceName: z.string().optional(), platform: z.string().optional(), capabilities: z.array(z.string()).optional(), principal: z.string().optional(),
}).passthrough();
export type ServerInfo = z.infer<typeof serverInfoSchema>;
/** devices 4.5: all a connection of another protocol may ask. `stopHost` too: a 0.8 desktop or CLI must still stop a newer daemon. */
export const MAINTENANCE_KINDS = ["admin.daemonStatus", "machine.checkCoreUpdate", "machine.applyCoreUpdate", "machine.coreUpdateStatus", "command.restartHost", "machine.stopHost"] as const;
/** devices 4.7: all a draining daemon still answers; the rest gets the error `draining`, the connection kept. The
 * snapshot is its last one, marked stale, and a negotiate only records on the connection: a client that reconnects during
 * an update gets its page and follows the progress (Codex review 248). */
export const DRAIN_KINDS = ["admin.daemonStatus", "machine.stopHost", "machine.coreUpdateStatus", "snapshot.get", "admin.negotiate"] as const;
