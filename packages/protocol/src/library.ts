import { z } from "zod";
import { agentIdSchema, groupIdSchema, projectIdSchema } from "./domain.js";

/** A project's workspace as the library holds it (memory design §2.1): folders are paths, canonical once saved. */
export const libraryWorkspaceSchema = z.object({
  primary: z.string().min(1).max(4096),
  additional: z.array(z.string().min(1).max(4096)).max(1000),
  /** Left out = each bot's own default repositories. */
  repositories: z.array(z.string().min(1).max(4096)).max(1000).optional(),
}).strict();
export type LibraryWorkspace = z.infer<typeof libraryWorkspaceSchema>;

export const libraryRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  /** The one way a project's workspace changes: the library first, then every binding's mirror, every group's sessions archived. */
  z.object({ type: z.literal("workspace"), projectId: projectIdSchema, revision: z.number().int().min(1), workspace: libraryWorkspaceSchema }).strict(),
  /** A project's name is its own: it does not follow a group's name (§5.3). */
  z.object({ type: z.literal("rename"), projectId: projectIdSchema, revision: z.number().int().min(1), name: z.string().trim().min(1).max(100).regex(/^[^/\\\x00-\x1f]+$/) }).strict(),
  /** The project this bot's group was bound to before it was unbound, which binding it again picks up (§5.6). */
  z.object({ type: z.literal("previous"), agentId: agentIdSchema, groupId: groupIdSchema }).strict(),
  /** Only a project no binding uses; its memory and events go with it. */
  z.object({ type: z.literal("delete"), projectId: projectIdSchema, revision: z.number().int().min(1) }).strict(),
]);
export type LibraryRequest = z.infer<typeof libraryRequestSchema>;

export const libraryBindingSchema = z.object({ agentId: agentIdSchema, groupId: groupIdSchema, name: z.string(), enabled: z.boolean() });
export const libraryProjectSchema = z.object({
  id: projectIdSchema, name: z.string(), revision: z.number().int().min(1), workspace: libraryWorkspaceSchema,
  bindings: z.array(libraryBindingSchema),
});
export type LibraryProject = z.infer<typeof libraryProjectSchema>;

export const libraryReplySchema = z.discriminatedUnion("kind", [
  /** `unlinked`: binding rows no project names yet (bound since the last daemon start). */
  z.object({ kind: z.literal("list"), projects: z.array(libraryProjectSchema), unlinked: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("workspace"),
    project: libraryProjectSchema.omit({ bindings: true }),
    /** false when the project already had this workspace. */
    changed: z.boolean(),
    /** Per binding that followed: `archived` = its folders and sessions are done; `failed` = left as it was, repaired at the next daemon start. */
    rebound: z.array(z.object({ agentId: agentIdSchema, groupId: groupIdSchema.optional(), state: z.enum(["archived", "failed"]), message: z.string().optional() })),
  }),
  z.object({ kind: z.literal("renamed"), project: libraryProjectSchema.omit({ bindings: true }) }),
  z.object({ kind: z.literal("previous"), project: z.object({ id: projectIdSchema, name: z.string() }).optional() }),
  z.object({ kind: z.literal("deleted"), projectId: projectIdSchema }),
]);
export type LibraryReply = z.infer<typeof libraryReplySchema>;
export type LibraryClient = (request: LibraryRequest) => Promise<LibraryReply>;
