import { z } from "zod";
import { desktopSnapshotSchema } from "./domain.js";
import { backendInstallItemSchema } from "./environment.js";

export const logEventPayloadSchema = z.object({lines:z.string()});
export type LogEventPayload = z.infer<typeof logEventPayloadSchema>;
export const backendInstallEventPayloadSchema = z.object({
  operationId:z.string().uuid(), id:z.string(), update:z.boolean(), item:backendInstallItemSchema,
});
export type BackendInstallEventPayload = z.infer<typeof backendInstallEventPayloadSchema>;
export const eventSchema = z.discriminatedUnion("event", [
  z.object({type:z.literal("event"),event:z.literal("snapshot"),payload:desktopSnapshotSchema}).strict(),
  z.object({type:z.literal("event"),event:z.literal("log"),payload:logEventPayloadSchema}).strict(),
  z.object({type:z.literal("event"),event:z.literal("backendInstall"),payload:backendInstallEventPayloadSchema}).strict(),
]);
export type Event = z.infer<typeof eventSchema>;
