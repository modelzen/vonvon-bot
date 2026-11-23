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
import { scheduleRequestSchema, scheduleReplySchema } from "./schedule.js";
import { agentIdSchema } from "./domain.js";
import { deviceRequestSchema, deviceReplySchema } from "./device.js";
import { recipeInstallRequestSchema, recipeInstallReplySchema } from './recipe-install.js';

import { recipeAuthoringRequestSchema, recipeAuthoringReplySchema } from './recipe-authoring.js';

const id = z.string().min(1);
export const requestSchema = z.discriminatedUnion("method", [
  z.object({type:z.literal("request"),id,method:z.literal("snapshot"),payload:z.object({type:z.literal("get"),groupAttention:z.literal(true).optional()}).strict()}).strict(),
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
  z.object({type:z.literal("request"),id,method:z.literal("schedule"),payload:z.object({botId:agentIdSchema,request:scheduleRequestSchema}).strict()}).strict(),
  z.object({type:z.literal("request"),id,method:z.literal("device"),payload:deviceRequestSchema}).strict(),
  z.object({type:z.literal('request'),id,method:z.literal('recipeAuthoring'),payload:recipeAuthoringRequestSchema}).strict(),
  z.object({type:z.literal('request'),id,method:z.literal('recipeInstall'),payload:recipeInstallRequestSchema}).strict(),
]);
export type Request = z.infer<typeof requestSchema>;
// One const per method so the declaration emit names each part; the inline union grew past what tsc will serialize (TS7056).
const snapshotResponse = z.object({type:z.literal("response"),id,method:z.literal("snapshot"),payload:desktopSnapshotSchema}).strict();
const commandResponse = z.object({type:z.literal("response"),id,method:z.literal("command"),payload:commandResultSchema}).strict();
const settingsResponse = z.object({type:z.literal("response"),id,method:z.literal("settings"),payload:settingsReplySchema}).strict();
const collaborationResponse = z.object({type:z.literal("response"),id,method:z.literal("collaboration"),payload:collaborationReplySchema}).strict();
const environmentResponse = z.object({type:z.literal("response"),id,method:z.literal("environment"),payload:environmentReplySchema}).strict();
const machineResponse = z.object({type:z.literal("response"),id,method:z.literal("machine"),payload:machineReplySchema}).strict();
const adminResponse = z.object({type:z.literal("response"),id,method:z.literal("admin"),payload:adminReplySchema}).strict();
const directoryResponse = z.object({type:z.literal("response"),id,method:z.literal("directory"),payload:directoryReplySchema}).strict();
const libraryResponse = z.object({type:z.literal("response"),id,method:z.literal("library"),payload:libraryReplySchema}).strict();
const memoryResponse = z.object({type:z.literal("response"),id,method:z.literal("memory"),payload:memoryReplySchema}).strict();
const contextPreviewResponse = z.object({type:z.literal("response"),id,method:z.literal("contextPreview"),payload:contextPreviewReplySchema}).strict();
const scheduleResponse = z.object({type:z.literal("response"),id,method:z.literal("schedule"),payload:scheduleReplySchema}).strict();
const deviceResponse = z.object({type:z.literal("response"),id,method:z.literal("device"),payload:deviceReplySchema}).strict();
const recipeAuthoringResponse = z.object({type:z.literal('response'),id,method:z.literal('recipeAuthoring'),payload:recipeAuthoringReplySchema}).strict();
const recipeInstallResponse = z.object({type:z.literal('response'),id,method:z.literal('recipeInstall'),payload:recipeInstallReplySchema}).strict();
export const responseSchema: z.ZodDiscriminatedUnion<"method", [typeof snapshotResponse, typeof commandResponse, typeof settingsResponse, typeof collaborationResponse, typeof environmentResponse, typeof machineResponse, typeof adminResponse, typeof directoryResponse, typeof libraryResponse, typeof memoryResponse, typeof contextPreviewResponse, typeof scheduleResponse, typeof deviceResponse, typeof recipeInstallResponse, typeof recipeAuthoringResponse]> = z.discriminatedUnion("method", [
  snapshotResponse, commandResponse, settingsResponse, collaborationResponse, environmentResponse, machineResponse, adminResponse, directoryResponse, libraryResponse, memoryResponse, contextPreviewResponse, scheduleResponse, deviceResponse, recipeInstallResponse, recipeAuthoringResponse,
]);
export type Response = z.infer<typeof responseSchema>;
/** `details`: what a refusal adds for a program to read, e.g. both versions of a `protocol_mismatch` (devices 4.5). */
export const errorEnvelopeSchema = z.object({
  type:z.literal("error"),id,code:z.string().min(1),message:z.string(),details:z.record(z.string(),z.unknown()).optional(),
}).strict();
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export const replyEnvelopeSchema: z.ZodUnion<[typeof responseSchema, typeof errorEnvelopeSchema]> = z.union([responseSchema,errorEnvelopeSchema]);
export type ReplyEnvelope = z.infer<typeof replyEnvelopeSchema>;
