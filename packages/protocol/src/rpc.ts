import { z } from "zod";
import { commandSchema, commandResultSchema } from "./domain.js";
import { settingsRequestSchema, settingsReplySchema } from "./settings.js";
import { collaborationRequestSchema, collaborationReplySchema } from "./collaboration.js";
import { environmentRequestSchema, environmentReplySchema } from "./environment.js";
import { machineRequestSchema, machineReplySchema } from "./machine.js";
import { desktopSnapshotSchema } from "./domain.js";
import { adminRequestSchema, adminReplySchema } from "./admin.js";
import { directoryRequestSchema, directoryReplySchema } from "./directory.js";
import { libraryRequestSchema, libraryReplySchema } from "./library.js";
import { memoryRequestSchema, memoryReplySchema } from "./memory.js";
import { contextPreviewRequestSchema, contextPreviewReplySchema } from "./context-preview.js";

const id = z.string().min(1);
export const requestSchema = z.discriminatedUnion("method", [
  z.object({type:z.literal("request"),id,method:z.literal("snapshot"),payload:z.object({type:z.literal("get")}).strict()}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("command"),payload:commandSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("settings"),payload:settingsRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("collaboration"),payload:collaborationRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("environment"),payload:environmentRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("machine"),payload:machineRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("admin"),payload:adminRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("directory"),payload:directoryRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("library"),payload:libraryRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("memory"),payload:memoryRequestSchema}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("contextPreview"),payload:contextPreviewRequestSchema}).strict(),
]);
export type Request = z.infer<typeof requestSchema>;
export const responseSchema = z.discriminatedUnion("method", [
  z.object({type:z.literal("response"),id,method:z.literal("snapshot"),payload:desktopSnapshotSchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("command"),payload:commandResultSchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("settings"),payload:settingsReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("collaboration"),payload:collaborationReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("environment"),payload:environmentReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("machine"),payload:machineReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("admin"),payload:adminReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("directory"),payload:directoryReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("library"),payload:libraryReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("memory"),payload:memoryReplySchema}).strict(),
  z.object({type:z.literal("response"),id,method:z.literal("contextPreview"),payload:contextPreviewReplySchema}).strict(),
]);
export type Response = z.infer<typeof responseSchema>;
export const errorEnvelopeSchema = z.object({
  type:z.literal("error"),id,code:z.string().min(1),message:z.string(),
}).strict();
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export const replyEnvelopeSchema = z.union([responseSchema,errorEnvelopeSchema]);
export type ReplyEnvelope = z.infer<typeof replyEnvelopeSchema>;
