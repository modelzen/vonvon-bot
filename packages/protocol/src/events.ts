import { z } from "zod";
import { desktopSnapshotSchema } from "./domain.js";

export const eventSchema = z.object({
  type:z.literal("event"),event:z.literal("snapshot"),payload:desktopSnapshotSchema,
}).strict();
export type Event = z.infer<typeof eventSchema>;
