import { z } from "zod";

/** Why a message to this bot got no answer (product.md 3.1 item 8). Gates first, then failed turns, then queued
 * messages a restart dropped (s18c). s25 adds the smart mode's reasons here and to {@link NOT_REPLIED_TEXT}. */
export const notRepliedReasonSchema = z.enum([
  "group-disabled", "group-updating", "chat-not-allowed", "user-not-allowed", "unbound", "lookup-failed",
  "signed-out", "codex-too-old", "tool-missing", "tier-unavailable", "missing-scope", "quota", "network", "idle-timeout", "agent-exited", "failed",
  "restarted",
]);
export type NotRepliedReason = z.infer<typeof notRepliedReasonSchema>;
/** Where a running bot was refused a scope: the back-fill, real names, a group's info, or a reply. */
export const scopeDenialPlaceSchema = z.enum(["history", "names", "chat-info", "send"]);
export type ScopeDenialPlace = z.infer<typeof scopeDenialPlaceSchema>;

/** One not-replied record. No message text, topic title, quote or file name (3.5): the group id, the
 * sender's name only if already cached, the error's first line, and the message id's last 6 characters. */
export const notRepliedSchema = z.object({
  at: z.number().finite().nonnegative(), count: z.number().int().positive(),
  groupId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/), place: z.enum(["main", "topic"]),
  sender: z.string().min(1).max(64).optional(), reason: notRepliedReasonSchema,
  backend: z.enum(["codex", "claude"]).optional(), detail: z.string().min(1).max(120).optional(), ref: z.string().max(6).optional(),
}).strict();
export type NotReplied = z.infer<typeof notRepliedSchema>;
export const deniedScopeSchema = z.object({ scope: z.string().min(1).max(100), where: scopeDenialPlaceSchema, at: z.number().finite().nonnegative() }).strict();
export type DeniedScope = z.infer<typeof deniedScopeSchema>;
/** What a bot child reports (the `fcb.diagnostics` IPC message); s18 adds its kinds here. `times` counts one record as
 * several messages (s18c: a group's dropped queue); child and host are always the same version. */
export const diagnosticsEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notReplied"), record: notRepliedSchema.omit({ count: true }), times: z.number().int().positive().max(10_000).optional() }).strict(),
  z.object({ kind: z.literal("scopeDenied"), denial: deniedScopeSchema }).strict(),
]);
export type DiagnosticsEvent = z.infer<typeof diagnosticsEventSchema>;
/** Kept in the daemon's memory per bot; s18 adds its crash records as more fields. */
export const botDiagnosticsSchema = z.object({ notReplied: z.array(notRepliedSchema), deniedScopes: z.array(deniedScopeSchema) });
export type BotDiagnostics = z.infer<typeof botDiagnosticsSchema>;

/** `bot` is the bot the record belongs to, and whether the host has more than one (a command then needs --bot). */
type Text = { reason: (record: NotReplied) => string; next: (record: NotReplied, bot?: { id: string; several: boolean }) => string };
const tool = (record: NotReplied) => record.backend === "claude" ? "Claude" : "Codex";
const CLAUDE_LOGIN_NEXT = "在终端运行 claude，用 /login 登录，再点「检查登录」。";
/** The page's wording, one per reason; the type makes every reason have one. */
export const NOT_REPLIED_TEXT: Record<NotRepliedReason, Text> = {
  "group-disabled": { reason: () => "这个群在 Vonvon 里停用了", next: () => "在群内设置里重新启用。" },
  "group-updating": { reason: () => "当时这个群正在改设置或恢复会话，这条没处理", next: () => "请发消息的人重发。" },
  "chat-not-allowed": { reason: () => "这个群不在「允许的飞书群」里", next: () => "在 Bot 设置的「允许的飞书群」里加上它，或者清空名单。" },
  "user-not-allowed": { reason: () => "发消息的人不在「响应成员」里", next: () => "在群内设置的「响应成员」里加上这个人。" },
  unbound: { reason: () => "这个群还没绑定，只回了一句提示", next: () => "在 Bot 页点「加入飞书群」绑定这个群。" },
  "lookup-failed": {
    reason: r => `没查到${r.detail ?? "这条消息是对谁说的"}，没 @ 它的这条就没回`,
    next: () => "飞书接口偶尔出错，请对方 @ 它再发一次；反复出现时看下面的日志。",
  },
  "signed-out": { reason: r => `${tool(r)} 没登录或登录过期了`, next: r => r.backend === "claude" ? CLAUDE_LOGIN_NEXT : "在本机环境里登录 Codex，或在终端运行 codex login。" },
  "codex-too-old": { reason: () => "Codex 版本太旧，服务端不让它用这个模型", next: () => "在本机环境里更新 Codex。" },
  "tool-missing": { reason: r => r.backend === "claude" ? "Claude Agent SDK 还没下载" : "Codex 没装好", next: () => "去本机环境安装。" },
  "tier-unavailable": {
    reason: () => "Linux 上的 Codex 只能用完全访问，这个群是只读或读写档，这一轮没开始",
    next: (r, bot) => `在群内设置里把「权限档」改成「完全访问」，或者运行 vonvon settings set${bot?.several ? ` --bot ${bot.id}` : ""} --group ${r.groupId} permission.mode=full。`,
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
};

/** The optional scopes of 3.11 that change what the bot does in a chat, and what is lost without each. */
export const OPTIONAL_SCOPE_EFFECTS: Record<string, string> = {
  "contact:user.base:readonly": "叫不出群里人的真名",
  "im:chat:readonly": "认不出话题群；数不出群里几个 bot，多会话主区的命令要 @；把 bot 拉进群后不提醒绑定",
  "im:message.group_at_msg.include_bot:readonly": "别的 bot @ 它时收不到",
  "application:application:self_manage": "飞书里的应用管理员不能管这个 bot",
};
export const SCOPE_DENIAL_PLACE_TEXT: Record<ScopeDenialPlace, string> = {
  history: "补拉群消息时", names: "查群里人的真名时", "chat-info": "读群信息时", send: "发消息时",
};
/** Runtime denials older than this are history and leave the page. */
export const DENIED_SCOPE_SHOWN_MS = 24 * 60 * 60_000;
