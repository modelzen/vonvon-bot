import { z } from "zod";
import { keyFailureOf } from "./secrets.js";

/** Why a message to this bot got no answer (product.md 3.1 item 8). Gates first, then failed turns, then queued
 * messages a restart dropped (s18c), then the smart mode's judgements (s25), then another bot's @ (s27a-0). */
export const notRepliedReasonSchema = z.enum([
  "group-disabled", "group-updating", "chat-not-allowed", "user-not-allowed", "unbound", "lookup-failed",
  "signed-out", "codex-too-old", "tool-missing", "tier-unavailable", "missing-scope", "quota", "network", "idle-timeout", "agent-exited", "failed",
  "restarted", "judge-skip", "judge-failed", "judge-budget", "judge-superseded", "judge-empty",
  "bot-wake-cap", "bot-wake-failed", "bot-wake-not-allowed", "bot-wake-dropped",
]);
export type NotRepliedReason = z.infer<typeof notRepliedReasonSchema>;
/** Where a running bot was refused a scope: the back-fill, real names, a group's info, or a reply. */
export const scopeDenialPlaceSchema = z.enum(["history", "names", "chat-info", "send"]);
export type ScopeDenialPlace = z.infer<typeof scopeDenialPlaceSchema>;

/** One not-replied record. No message text, topic title, quote or file name (3.5): the group id, the
 * sender's name only if already cached, the error's first line, and the message id's last 6 characters.
 * A judgement's `detail` is the judge model's one-line reason (3.4 keeps it on this page only), which may
 * repeat words of the message; the page lives in the supervisor's memory and is never logged or saved. */
export const notRepliedSchema = z.object({
  at: z.number().finite().nonnegative(), count: z.number().int().positive(),
  groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/), place: z.enum(["main", "topic"]),
  sender: z.string().min(1).max(64).optional(), reason: notRepliedReasonSchema,
  backend: z.enum(["codex", "claude"]).optional(), detail: z.string().min(1).max(120).optional(), ref: z.string().max(6).optional(),
}).strict();
export type NotReplied = z.infer<typeof notRepliedSchema>;
export const deniedScopeSchema = z.object({ scope: z.string().min(1).max(100), where: scopeDenialPlaceSchema, at: z.number().finite().nonnegative() }).strict();
export type DeniedScope = z.infer<typeof deniedScopeSchema>;
/** Actual Attention values, aggregated without retaining topic identifiers. */
const attentionPlaceSchema = z.object({ mode: z.enum(["focus", "watch"]), intervalMs: z.number().finite().nonnegative() }).strict();
export const groupAttentionSchema = z.object({
  groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/),
  group: z.object({
    score: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(75), z.literal(100)]),
    intervalMs: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(),
  }).strict().optional(),
  main: attentionPlaceSchema.optional(), focusedTopics: z.number().int().nonnegative(), watchedTopics: z.number().int().nonnegative(),
  budget: z.object({ kind: z.enum(["no-glance", "named-only"]), until: z.number().finite().nonnegative() }).strict().optional(),
}).strict();
export type GroupAttention = z.infer<typeof groupAttentionSchema>;
/** Safe live activity only: never reasoning, message text, command lines, paths or tool arguments. */
export const botActivitySchema = z.object({
  id: z.guid(), groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/),
  phase: z.enum(["processing", "thinking", "tool", "responding", "compacting", "waiting", "retrying"]),
  startedAt: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(),
  /** Host receipt of the last heartbeat; updatedAt remains the last phase change. */
  observedAt: z.number().finite().nonnegative().optional(),
  toolKind: z.enum(["command", "file", "search", "tool"]).optional(),
  activeToolCount: z.number().int().positive().max(1024).optional(),
}).strict();
export type BotActivity = z.infer<typeof botActivitySchema>;
/** A successful model judgement's intent, not a receipt that a reply/topic was delivered. */
export const botDecisionSchema = z.object({
  id: z.guid(), groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/), place: z.enum(["main", "topic"]),
  decision: z.enum(["skip", "main", "reply", "topic"]),
  trigger: z.enum(["mention", "quote", "name", "focus", "glance", "bot-mention"]),
  decidedAt: z.number().finite().nonnegative(), messageAt: z.number().finite().nonnegative(),
  messageCount: z.number().int().positive().max(10_000).optional(),
}).strict();
export type BotDecision = z.infer<typeof botDecisionSchema>;
export const BOT_ACTIVITY_STALE_MS = 60_000;
export const botLatestActionSchema = z.object({
  id: z.guid(), groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/),
  kind: z.enum(["replied", "memory-saved"]), at: z.number().finite().nonnegative(),
}).strict();
export type BotLatestAction = z.infer<typeof botLatestActionSchema>;
export const BOT_LATEST_ACTION_SHOWN_MS = 5 * 60_000;
export const CUSTOM_PROMPT_NOTICE = "新版默认智能提示词新增：先看这话是对谁说的；Bot 来回几次且真人一直没说话时，除非还有明确没做完的事，不再接。你的自定义提示词保持原样，可到智能提示词里自行修改。";
/** What a bot child reports (the `fcb.diagnostics` IPC message); s18 adds its kinds here. `times` counts one record as
 * several messages (s18c: a group's dropped queue); child and host are always the same version. */
export const diagnosticsEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activity"), activity: botActivitySchema }).strict(),
  z.object({ kind: z.literal("activityEnded"), id: z.guid() }).strict(),
  z.object({ kind: z.literal("decision"), decision: botDecisionSchema }).strict(),
  z.object({ kind: z.literal("latestAction"), action: botLatestActionSchema }).strict(),
  z.object({ kind: z.literal("attention"), groups: z.array(groupAttentionSchema).max(200) }).strict(),
  z.object({ kind: z.literal("customPrompt"), groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/) }).strict(),
  z.object({ kind: z.literal("notReplied"), record: notRepliedSchema.omit({ count: true }), times: z.number().int().positive().max(10_000).optional() }).strict(),
  z.object({ kind: z.literal("scopeDenied"), denial: deniedScopeSchema }).strict(),
]);
export type DiagnosticsEvent = z.infer<typeof diagnosticsEventSchema>;
/** Kept in the daemon's memory per bot; s18 adds its crash records as more fields. */
export const botDiagnosticsSchema = z.object({
  notReplied: z.array(notRepliedSchema), deniedScopes: z.array(deniedScopeSchema),
  attention: z.array(groupAttentionSchema).optional(), customPromptGroups: z.array(z.string()).optional(),
  activities: z.array(botActivitySchema).max(50).optional(), decisions: z.array(botDecisionSchema).max(30).optional(),
  latestAction: botLatestActionSchema.optional(),
});
export type BotDiagnostics = z.infer<typeof botDiagnosticsSchema>;

/** `bot` is the bot the record belongs to, and whether the host has more than one (a command then needs --bot).
 * `command`: what starts the record's Codex or Claude in a terminal when it is a managed copy (`ToolState.command`). */
type Text = { reason: (record: NotReplied) => string; next: (record: NotReplied, bot?: { id: string; several: boolean }, command?: string) => string };
const tool = (record: NotReplied) => record.backend === "claude" ? "Claude" : "Codex";
const claudeLoginNext = (command = "claude") => `在终端运行 ${command} 配置好（账号或自定义 API 都行），再点「检查配置」。`;
/** The page's wording, one per reason; the type makes every reason have one. */
export const NOT_REPLIED_TEXT: Record<NotRepliedReason, Text> = {
  "group-disabled": { reason: () => "这个群在 Vonvon 里停用了", next: () => "在群内设置里重新启用。" },
  "group-updating": { reason: () => "当时这个群正在改设置或恢复会话，这条没处理", next: () => "请发消息的人重发。" },
  "chat-not-allowed": { reason: () => "这个群不在「允许的飞书群」里", next: () => "在 Bot 设置的「允许的飞书群」里加上它，或者清空名单。" },
  "user-not-allowed": { reason: () => "发消息的人不在「响应成员」里", next: () => "在群内设置的「响应成员」里加上这个人。" },
  unbound: { reason: () => "这个群还没设置好，@ 它只回了一句提示（同一个群 10 分钟最多回一次）", next: () => "主人在私聊的设置卡上选会话方式、点绑定；或者在 Bot 页点「加入飞书群」设置这个群。" },
  "lookup-failed": {
    reason: r => `没查到${r.detail ?? "这条消息是对谁说的"}，没 @ 它的这条就没回`,
    next: () => "飞书接口偶尔出错，请对方 @ 它再发一次；反复出现时看下面的日志。",
  },
  "signed-out": { reason: r => `${tool(r)} 没配置好或配置过期了`, next: (r, _bot, command) => r.backend === "claude" ? claudeLoginNext(command) : `先把 Codex 配置好（账号或自定义 API 都行，用 Codex App 或 \`${command ?? "codex"}\` 命令行），再回到 Vonvon 检测。` },
  "codex-too-old": { reason: () => "Codex 版本太旧，服务端不让它用这个模型", next: () => "在本机环境里更新 Codex。" },
  "tool-missing": { reason: r => r.backend === "claude" ? "Claude Agent SDK 还没下载" : "Codex 没装好", next: () => "去本机环境安装。" },
  "tier-unavailable": {
    reason: () => "这个群的权限档位在当前 Codex 环境不可用，这一轮没开始",
    next: (r, bot) => `在群设置里换一档，或者升级 Codex。也可以运行 vonvon settings set${bot?.several ? ` --bot ${bot.id}` : ""} --group ${r.groupId} permission.mode=full。`,
  },
  "missing-scope": { reason: r => `飞书拒绝了：缺 ${r.detail ?? "权限"}`, next: () => "在上面「缺的权限」里一键开权限，开完发布一个新版本。" },
  quota: { reason: r => `${tool(r)} 的用量到上限了`, next: () => "用量恢复后再发。" },
  network: { reason: () => "连不上模型服务", next: () => "检查这台电脑的网络；卡片上的「重试」可以再跑一次。" },
  "idle-timeout": { reason: () => "太久没有输出，这一轮停了", next: () => "卡片上的「重试」可以再跑一次。" },
  "agent-exited": { reason: r => `${tool(r)} 进程中途退出了`, next: () => "重发这条消息；反复出现时看下面的日志。" },
  failed: { reason: r => `这一轮出错了${r.detail ? `：${r.detail}` : ""}`, next: () => "看下面的日志。" },
  restarted: {
    reason: () => "重启或停止时这条还在排队，没处理",
    next: r => r.detail ? `在原处回一句请重发没成功（${r.detail}），请告诉发消息的人重发。` : "已在原处回了一句请重发。",
  },
  "judge-skip": {
    reason: r => `判断后没接话${r.detail ? `：${r.detail}` : ""}`,
    next: () => "智能模式下这是正常的。总是漏回就改智能提示词。",
  },
  "judge-failed": {
    reason: r => `判断没出结果${r.detail ? `（${r.detail}）` : ""}，这条没回`,
    // a decision model's key: the key page fixes it, or the keystore's error in the log below (s23g2)
    next: r => keyFailureOf(r.detail) === "key" ? "在密钥页填了就恢复；真人 @ 它的照旧会回。"
      : keyFailureOf(r.detail) === "keystore" ? "密钥库读得了就恢复，原因在下面 daemon 日志的 secrets.unreadable；真人 @ 它的照旧会回。"
      : "真人 @ 它的照旧会回；反复出现时看下面的日志。",
  },
  "judge-budget": { reason: () => "这个群这一小时判断了 60 次，到了上限，这条没判断", next: () => "一小时内会恢复；真人 @ 它的不算在这个数里，照常判断。" },
  "judge-superseded": { reason: () => "判断说要回，但它已随后来的消息进了会话，没单独回", next: () => "不用处理。" },
  "judge-empty": {
    reason: r => `自己接话后没有要说的，${r.detail ?? "删掉了空卡"}`,
    next: () => "智能模式下这是正常的。总是这样就改智能提示词，让它少接话。",
  },
  "bot-wake-cap": {
    reason: () => "自上一条真人消息起，Bot 之间已互相叫醒 6 次，到了上限，这条 Bot 的 @ 没回",
    next: () => "不用处理。真人在这个位置说一句，Bot 之间就能接着来。",
  },
  "bot-wake-failed": {
    reason: r => `处理这条 Bot 的 @ 时出错${r.detail ? `（${r.detail}）` : ""}，没回`,
    next: () => "反复出现时看下面的日志。",
  },
  "bot-wake-not-allowed": {
    reason: () => "这个群设了「响应成员」，这个 Bot 不在名单上，它的 @ 叫不醒",
    next: () => "这是设置的效果。要让它能叫醒，把它加进「响应成员」，或者清空名单。",
  },
  "bot-wake-dropped": {
    reason: r => `这条 Bot 的 @ 没处理${r.detail ? `：${r.detail}` : ""}`,
    next: () => "不用处理。",
  },
};

/** The optional scopes of 3.11 that change what the bot does in a chat, and what is lost without each. */
export const OPTIONAL_SCOPE_EFFECTS: Record<string, string> = {
  "contact:user.base:readonly": "叫不出群里人的真名",
  "im:chat:readonly": "认不出话题群；数不出群里几个 Bot，多会话主区的命令要 @；把 Bot 拉进群后不提醒绑定",
  "im:message.group_at_msg.include_bot:readonly": "别的 Bot @ 它时收不到",
  "application:application:self_manage": "飞书里的应用管理员不能管这个 Bot",
};

/** What the Bot's Feishu tools can't do without each scope (dm-agent 6.5). */
export const FEISHU_TOOL_SCOPE_EFFECTS: Record<string, string> = {
  "docs:document.content:read": "读不了文档和知识库",
  "docx:document:readonly": "读不了文档和知识库",
  "wiki:wiki:readonly": "读不了文档和知识库",
  "docx:document:write_only": "改不了文档",
  "sheets:spreadsheet:read": "读不了表格",
  "bitable:app:readonly": "读不了多维表格",
  "drive:file:download": "下载不了云空间文件",
  "slides:presentation:read": "读不了幻灯片",
  "mindnote:node:read": "读不了思维笔记",
  "board:whiteboard:node:read": "读不了画板",
  "minutes:minutes:readonly": "读不了妙记",
  "minutes:minutes.transcript:export": "读不了妙记",
  "docs:doc:readonly": "读不了旧版文档",
  "space:document:retrieve": "看不了云空间文件夹里有什么",
  "wiki:space:retrieve": "看不了知识库和它的目录",
  "wiki:node:retrieve": "看不了知识库和它的目录",
  "docs:document.comment:read": "读不了文档评论",
  "docs:document.media:download": "下载不了文档里的图片和附件",
  "search:message": "搜不了消息",
};
export const SCOPE_DENIAL_PLACE_TEXT: Record<ScopeDenialPlace, string> = {
  history: "补拉群消息时", names: "查群里人的真名时", "chat-info": "读群信息时", send: "发消息时",
};
/** Runtime denials older than this are history and leave the page. */
export const DENIED_SCOPE_SHOWN_MS = 24 * 60 * 60_000;
