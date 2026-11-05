import { z } from "zod";

/** One memory entry holds at most this many code points (zod counts UTF-16 units, so the limit is a refine). */
export const MEMORY_TEXT_MAX = 500;
/** A branch name is at most this many code points after normalisation. */
export const MEMORY_BRANCH_NAME_MAX = 12;
/** One memory (a project's, a bot's) has at most this many branches, the fixed ones included. */
export const MEMORY_BRANCH_COUNT_MAX = 12;

const codePoints = (value: string): number => Array.from(value).length;
const memoryText = z.string().refine(value => value.trim().length > 0 && codePoints(value) <= MEMORY_TEXT_MAX, "记忆要 1 到 500 字");
const id = z.string().min(1).max(300);

/** Which memory a request means: the bot id is part of the reference because a bot's items do not say whose they are. */
export const memoryScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("project"),projectId:id}).strict(),
  z.object({kind:z.literal("bot"),botId:id}).strict(),
  z.object({kind:z.literal("dm"),botId:id,openId:id}).strict(),
]);
export type MemoryScopeRef = z.infer<typeof memoryScopeRefSchema>;

export const memoryItemScopeSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("project"),projectId:id}),
  z.object({kind:z.literal("bot")}),
  z.object({kind:z.literal("dm"),openId:id}),
]);
export type MemoryItemScope = z.infer<typeof memoryItemScopeSchema>;

export const memoryActorRoleSchema = z.enum(["owner","admin","member","bot","desktop","cli","import"]);
export type MemoryActorRole = z.infer<typeof memoryActorRoleSchema>;
export const memoryTurnKindSchema = z.enum(["human","wake","initiative","retry","bot"]);
export const memoryDowngradeSchema = z.enum(["member","not-human-turn","steered","not-typed","not-in-message","quota"]);
export type MemoryDowngrade = z.infer<typeof memoryDowngradeSchema>;

/** Every field is filled by the daemon; the model only ever supplies `claim` and `why`. */
export const memorySourceSchema = z.object({
  via: z.enum(["ui","cli","tool","hidden_block","promoted","moved","import"]),
  botId: z.string(),
  turn: z.object({kind:memoryTurnKindSchema,steered:z.boolean()}).optional(),
  actorOpenId: z.string().optional(),
  /** Who wrote it, from another Bot's private chat: their open_id means nothing to this Bot, so the name stands instead (dm-agent 6.4). */
  actorName: z.string().optional(),
  actorRole: memoryActorRoleSchema,
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  claim: z.enum(["asked","self"]).optional(),
  why: z.string().optional(),
  downgraded: memoryDowngradeSchema.optional(),
  fromItemId: z.string().optional(),
  importFile: z.string().optional(),
  importHash: z.string().optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryItemSchema = z.object({
  id,
  scope: memoryItemScopeSchema,
  text: z.string(),
  branch: z.string(),
  state: z.enum(["active","archived"]),
  trust: z.enum(["trusted","untrusted"]),
  source: memorySourceSchema,
  lastEditedBy: z.object({actorOpenId:z.string().optional(),actorRole:memoryActorRoleSchema,at:z.number()}).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int().min(1),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const memoryBranchSchema = z.object({name:z.string(),fixed:z.boolean(),createdAt:z.number(),createdBy:z.string()});
export type MemoryBranch = z.infer<typeof memoryBranchSchema>;

export const memoryEventKindSchema = z.enum([
  "add","edit","archive","restore","promote","move","confirm","purge","branch_rename","branch_merge",
  /** extra kind: the undo of a merge, which puts the whole batch back */
  "branch_unmerge",
]);
export type MemoryEventKind = z.infer<typeof memoryEventKindSchema>;
export const memoryEventSchema = z.object({
  eventId: z.string(),
  at: z.number(),
  kind: memoryEventKindSchema,
  itemId: z.string().optional(),
  /** the whole item before and after; both are null on a purge, whose text is gone */
  before: memoryItemSchema.nullable().optional(),
  after: memoryItemSchema.nullable().optional(),
  actor: z.object({openId:z.string().optional(),role:memoryActorRoleSchema}),
  reason: z.enum(["make-room","undo","cap"]).optional(),
  /** this add or edit opened a branch */
  newBranch: z.boolean().optional(),
  undoOf: z.string().optional(),
  /** rename and merge: the names, every item they moved, and those items' revisions after the move */
  branches: z.object({
    from: z.string(),
    to: z.string().optional(),
    into: z.string().optional(),
    itemIds: z.array(z.string()),
    revisions: z.record(z.string(), z.number()).optional(),
    entry: memoryBranchSchema.optional(),
  }).optional(),
});
export type MemoryEvent = z.infer<typeof memoryEventSchema>;

export const memoryRequestSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("list"),scope:memoryScopeRefSchema}).strict(),
  z.object({type:z.literal("add"),scope:memoryScopeRefSchema,text:memoryText,branch:z.string().max(200).optional()}).strict(),
  z.object({type:z.literal("edit"),scope:memoryScopeRefSchema,itemId:id,revision:z.number().int().min(1),text:memoryText.optional(),branch:z.string().max(200).optional()}).strict(),
  z.object({type:z.literal("archive"),scope:memoryScopeRefSchema,itemId:id,revision:z.number().int().min(1)}).strict(),
  z.object({type:z.literal("restore"),scope:memoryScopeRefSchema,itemId:id,revision:z.number().int().min(1)}).strict(),
  /** project → bot memory (owner, desktop) */
  z.object({type:z.literal("promote"),scope:memoryScopeRefSchema,itemId:id,revision:z.number().int().min(1),botId:id,branch:z.string().max(200).optional()}).strict(),
  /** bot → project memory (owner, desktop) */
  z.object({type:z.literal("move"),scope:memoryScopeRefSchema,itemId:id,revision:z.number().int().min(1),to:z.object({projectId:id}).strict(),branch:z.string().max(200).optional()}).strict(),
  z.object({type:z.literal("branchRename"),scope:memoryScopeRefSchema,from:z.string().min(1).max(200),to:z.string().min(1).max(200)}).strict(),
  z.object({type:z.literal("branchMerge"),scope:memoryScopeRefSchema,from:z.string().min(1).max(200),into:z.string().min(1).max(200)}).strict(),
  /** Archives every active entry of a branch in one transaction (the web page's 删除分支); each gets its own archive event, undone one by one. `expected`: the count the caller saw. */
  z.object({type:z.literal("branchDelete"),scope:memoryScopeRefSchema,name:z.string().min(1).max(200),expected:z.number().int().min(0).optional()}).strict(),
  z.object({type:z.literal("confirm"),scope:memoryScopeRefSchema,itemId:id,revision:z.number().int().min(1)}).strict(),
  z.object({type:z.literal("purge"),scope:memoryScopeRefSchema,itemId:id}).strict(),
  z.object({type:z.literal("undo"),scope:memoryScopeRefSchema,eventId:id}).strict(),
  z.object({type:z.literal("export"),scope:memoryScopeRefSchema}).strict(),
  /** 主人看过被外部改过的 memory.json 的差异，认下现在的内容：重写完整性记录，可信条目恢复注入（设计 2.4） */
  z.object({type:z.literal("reseal"),scope:memoryScopeRefSchema}).strict(),
  z.object({type:z.literal("events"),scope:memoryScopeRefSchema,itemId:id}).strict(),
  /** 设计 5.8：记下主人这次打开这一页的时间，下次 `list` 只标这之后的（`library/seen.json`，不碰条目和 revision） */
  z.object({type:z.literal("seen"),page:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("bot"),botId:id}).strict(),
    z.object({kind:z.literal("project"),projectId:id}).strict(),
    z.object({kind:z.literal("dm"),botId:id,openId:id}).strict(),
  ])}).strict(),
  /** 导航、项目列表、Bot 列表上"新"的条数：每个项目、每个 Bot 各一个数 */
  z.object({type:z.literal("newCounts")}).strict(),
  /** 私聊记忆页的人：这个 Bot 的私聊里出现过的每个人（`dm.people`），各自几条。移出管理员不删人也不删记忆 */
  z.object({type:z.literal("dmPeople"),botId:id}).strict(),
]);
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;

export const memoryRefusalSchema = z.enum([
  "memory-full","looks-like-secret","duplicate","bad-args","not-found","archived","not-allowed","fixed-branch","no-such-branch","branch-conflict","not-undoable",
]);
export type MemoryRefusal = z.infer<typeof memoryRefusalSchema>;

export const memoryReplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("list"),
    items: z.array(memoryItemSchema),
    branches: z.array(memoryBranchSchema),
    limit: z.number(),
    /** active entries, what the limit counts */
    used: z.number(),
    lastEventId: z.string().optional(),
    /** false: memory.json was changed outside the daemon; trusted entries are not to be injected */
    verified: z.boolean(),
    problems: z.array(z.string()),
    /** 5.8：主人上次打开这一页以后，群里新记、改过、归档的条目（主人自己在桌面端、命令行做的、迁移导入的不算）；旧 daemon 没有 */
    newIds: z.array(z.string()).optional(),
    /** 同上，bot 新开的分支 */
    newBranches: z.array(z.string()).optional(),
    /** 因为满了、为给新条目腾位而归档的条目（3.7）；"已归档"里标"为腾位归档" */
    madeRoom: z.array(z.string()).optional(),
  }),
  z.object({kind:z.literal("seen"),at:z.number()}),
  z.object({kind:z.literal("newCounts"),projects:z.record(z.string(),z.number().int().nonnegative()),bots:z.record(z.string(),z.number().int().nonnegative()),
    /** 每个 Bot 的私聊记忆里新的条数，所有人加起来；旧 daemon 没有 */
    dm:z.record(z.string(),z.number().int().nonnegative()).optional()}),
  z.object({kind:z.literal("dmPeople"),people:z.array(z.object({openId:z.string(),name:z.string().optional(),at:z.number(),used:z.number().int().nonnegative(),
    /** 这个人最近的一个真实私聊；发给他的定时任务就发到这里 */
    chatId:z.string().optional(),
    /** 现在还是不是管理员；读不到配置时省略，不当作"不是" */
    admin:z.boolean().optional(),
    /** 主人上次看这个人之后新写的条数 */
    fresh:z.number().int().nonnegative().optional()}))}),
  z.object({kind:z.literal("item"),item:memoryItemSchema,branchApplied:z.string().optional(),newBranch:z.boolean().optional()}),
  z.object({kind:z.literal("conflict"),current:memoryItemSchema.optional(),message:z.string()}),
  z.object({kind:z.literal("refused"),reason:memoryRefusalSchema,message:z.string()}),
  z.object({kind:z.literal("branches"),branches:z.array(memoryBranchSchema),moved:z.number()}),
  z.object({kind:z.literal("exported"),files:z.array(z.object({branch:z.string(),markdown:z.string()}))}),
  z.object({kind:z.literal("events"),events:z.array(memoryEventSchema)}),
  z.object({kind:z.literal("purged")}),
  z.object({kind:z.literal("sealed")}),
]);
export type MemoryReply = z.infer<typeof memoryReplySchema>;

/** memory.json: the snapshot the event log is replayed on top of (daemon/src/bot/memory-store.ts) */
export const memorySnapshotSchema = z.object({
  version: z.literal(1),
  lastEventId: z.string().optional(),
  branches: z.array(memoryBranchSchema),
  items: z.array(memoryItemSchema),
  /** every import hash ever taken in, so a purged entry is not imported again */
  importedHashes: z.array(z.string()).optional(),
}).passthrough();
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
