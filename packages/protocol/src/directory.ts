import { z } from "zod";
import { folderChoiceSchema } from "./domain.js";

export const directoryRequestSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("list"),path:z.string().optional()}).strict(),
  z.object({type:z.literal("choose"),path:z.string()}).strict(),
]);
export type DirectoryRequest = z.infer<typeof directoryRequestSchema>;

export const directoryEntrySchema = z.object({name:z.string(),path:z.string(),hidden:z.boolean()});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;
export const directoryReplySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("entries"),path:z.string(),parent:z.string().nullable(),entries:z.array(directoryEntrySchema),truncated:z.boolean()}),
  z.object({kind:z.literal("folderChosen"),folder:folderChoiceSchema}),
]);
export type DirectoryReply = z.infer<typeof directoryReplySchema>;
