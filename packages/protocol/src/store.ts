import { z } from "zod";

// The pinned bridge reader requires only name and cwd in each project row.
export const bridgeProjectStoreRowSchema = z.object({
  name: z.string(), cwd: z.string(),
}).passthrough();
export const bridgeProjectsStoreSchema = z.object({
  projects: z.array(bridgeProjectStoreRowSchema),
}).passthrough();
export type BridgeProjectStoreRow = z.infer<typeof bridgeProjectStoreRowSchema>;
export type BridgeProjectsStore = z.infer<typeof bridgeProjectsStoreSchema>;
