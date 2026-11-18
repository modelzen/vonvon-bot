import { z } from "zod";
import { desktopSnapshotSchema } from "./domain.js";
import { backendInstallItemSchema } from "./environment.js";
import { deviceEventSchema } from "./device.js";

export const logEventPayloadSchema = z.object({lines:z.string()});
export type LogEventPayload = z.infer<typeof logEventPayloadSchema>;
export const backendInstallEventPayloadSchema = z.object({
  operationId:z.guid(), id:z.string(), update:z.boolean(), item:backendInstallItemSchema,
});
export type BackendInstallEventPayload = z.infer<typeof backendInstallEventPayloadSchema>;
/** U4: the daemon asks the desktop shell on its own computer to check for, or run, the app's update; sent to that shell's
 * connection only (`DESKTOP_SELF_UPDATE_CAPABILITY`). `by` names who asked, as the shell's notice shows it. */
export const desktopUpdateRequestPayloadSchema = z.object({requestId:z.string().regex(/^dur_[0-9a-f]{16}$/), action:z.enum(["check","apply"]), by:z.string().max(80)}).strict();
export type DesktopUpdateRequestPayload = z.infer<typeof desktopUpdateRequestPayloadSchema>;
export const desktopUpdateRequestEventSchema = z.object({type:z.literal("event"),event:z.literal("desktopUpdateRequest"),payload:desktopUpdateRequestPayloadSchema}).strict();
export const eventSchema = z.discriminatedUnion("event", [
  z.object({type:z.literal("event"),event:z.literal("snapshot"),payload:desktopSnapshotSchema}).strict(),
  z.object({type:z.literal("event"),event:z.literal("log"),payload:logEventPayloadSchema}).strict(),
  z.object({type:z.literal("event"),event:z.literal("backendInstall"),payload:backendInstallEventPayloadSchema}).strict(),
  deviceEventSchema,
  desktopUpdateRequestEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;
