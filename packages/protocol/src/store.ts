import { z } from "zod";

// Bridge registry reads historical rows with only name and cwd; retain extensions on parse.
export const bridgeProjectStoreRowSchema = z.object({
  name: z.string(), cwd: z.string(), chatId: z.string().optional(),
  blank: z.boolean().optional(), createdAt: z.number().optional(),
  enabled: z.boolean().optional(), kind: z.enum(["single", "multi"]).optional(),
  backend: z.string().optional(), noMention: z.boolean().optional(),
  origin: z.enum(["created", "joined"]).optional(), addedBy: z.string().optional(),
  allowedUsers: z.array(z.string()).optional(), mode: z.enum(["qa", "write", "full"]).optional(),
  guestMode: z.enum(["qa", "write", "full"]).optional(), network: z.boolean().optional(),
  autoCompact: z.boolean().optional(), defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(), branch: z.string().optional(),
  creationRequestId: z.string().optional(), creationRequestSignature: z.string().optional(),
}).passthrough();
export const bridgeProjectsStoreSchema = z.object({
  version: z.number().optional(), projects: z.array(bridgeProjectStoreRowSchema),
}).passthrough();
export type BridgeProjectStoreRow = z.infer<typeof bridgeProjectStoreRowSchema>;
export type BridgeProjectsStore = z.infer<typeof bridgeProjectsStoreSchema>;
