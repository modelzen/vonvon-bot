import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const machineIdSchema = z.string().uuid().brand<"MachineId">();
export type MachineId = z.infer<typeof machineIdSchema>;
const protocolVersionSchema = z.number().int().positive();
export const helloSchema = z.object({
  type: z.literal("hello"), protocolVersion: protocolVersionSchema,
  clientKind: z.enum(["desktop", "web", "cli"]),
}).strict();
export type Hello = z.infer<typeof helloSchema>;
export const serverInfoSchema = z.object({
  type: z.literal("serverInfo"), machineId: machineIdSchema,
  version: z.string().min(1), protocolVersion: protocolVersionSchema,
}).strict();
export type ServerInfo = z.infer<typeof serverInfoSchema>;
