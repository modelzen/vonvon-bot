import { z } from "zod";
import { agentIdSchema, groupIdSchema } from "./domain.js";

/**
 * 记忆设计 5.5："模型看到什么"。只有 vonvon 自己交给模型的东西（D6）：这里没有任何项目文件或个人指令文件的内容或路径，
 * 也没有"管不了的来源"这类字段。`threadId` 省略时取这个群最近用过的一条会话。
 */
export const contextPreviewRequestSchema = z.object({
  type: z.literal("get"),
  agentId: agentIdSchema,
  place: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
    z.object({ kind: z.literal("comment") }).strict(),
    /** One person's private chat: what they have decides the memory, so the person is part of the place (dm-agent 5). */
    z.object({ kind: z.literal("dm"), openId: z.string().min(1).max(300) }).strict(),
  ]),
  threadId: z.string().min(1).max(1000).optional(),
}).strict();
export type ContextPreviewRequest = z.infer<typeof contextPreviewRequestSchema>;

export const contextSectionKeySchema = z.enum(["identity", "role", "supplement", "botMemory", "projectMemory", "dmMemory"]);
export type ContextSectionKey = z.infer<typeof contextSectionKeySchema>;

const count = z.number().int().nonnegative();
/** One section as a new session would get it. */
export const contextNextSectionSchema = z.object({
  key: contextSectionKeySchema, version: z.string(), chars: count, items: count.optional(), branches: count.optional(),
}).strict();
/** One section as the live session was last handed it; `stale` = the next turn will bring a newer one. */
export const contextSessionSectionSchema = z.object({
  key: contextSectionKeySchema, version: z.string(), stale: z.boolean(), items: count.optional(), branches: count.optional(),
}).strict();

export const contextPreviewReplySchema = z.object({
  kind: z.literal("preview"),
  /** The bot process is up; a stopped bot has no live session column. */
  running: z.boolean(),
  next: z.object({
    sections: z.array(contextNextSectionSchema),
    /** Items handed over, by kind: the bot's, the project's trusted, the project's unconfirmed. A private chat has no
     * project memory, so there the last two count the person's private-chat memory. */
    items: z.object({ bot: count, trusted: count, untrusted: count }).strict(),
    /** vonvon's own tools; no file, skill or MCP names of the workspace. */
    tools: z.array(z.string()),
  }).strict(),
  session: z.object({
    threadId: z.string(), updatedAt: z.number(), backend: z.string(),
    /** Opened before the settings mark existed: it holds the old convention and gets everything again next turn. */
    legacy: z.boolean(),
    /** A compaction ended since: the next turn hands over everything again. */
    redeliverDue: z.boolean(),
    sections: z.array(contextSessionSectionSchema),
    lastTurn: z.object({
      at: z.number(), injected: count,
      items: z.object({ bot: count, trusted: count, untrusted: count }).strict(),
      /** What the model said it used (its own word, `<vonvon-mem>`); `text` is left out for an entry gone since. */
      used: z.array(z.object({ id: z.string(), text: z.string().optional() }).strict()),
      /** Hidden-block entries the daemon did not take (3.4), one reason each; no text is kept. */
      missed: z.array(z.string()).optional(),
    }).strict().optional(),
  }).strict().optional(),
  judge: z.object({
    via: z.enum(["local", "third-party"]), label: z.string().optional(),
    roleChars: count, memoryItems: count, memoryChars: count,
  }).strict(),
}).strict();
export type ContextPreviewReply = z.infer<typeof contextPreviewReplySchema>;
export type ContextPreviewClient = (request: ContextPreviewRequest) => Promise<ContextPreviewReply>;
