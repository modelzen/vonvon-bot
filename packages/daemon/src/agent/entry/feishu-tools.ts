import { z } from 'zod';
import { feishuMembers, type FeishuMembers } from '../../admin/structured-commands';
import { FeishuReadRefused } from '../../feishu-read/denial';
import type { FeishuReader } from '../../feishu-read/reader';
import { ToolRefusal, type AgentTool, type ToolContext } from './tools';

/**
 * 飞书读取工具（dm-agent 7.1、7.2）：Claude 的 MCP 和 Codex 的 dynamicTools 共用这一份定义。工具不走沙箱，范围在这里
 * 守：群会话只读本群的消息、文件、公告、成员，文档、表格、云空间不按群隔离；私聊看这一轮是不是管理员的。跨 Bot 是 F2，
 * 评论会话是 F3。结果就是内容本身，不加标注。
 */

const chat = z.string().min(1).max(200).describe('群的 chat_id；不写就是当前这个群');
const cursor = z.string().min(1).max(4000).describe('上一次结果里的 cursor，读下一段时原样传回来');
const limit = (max: number) => z.number().int().min(1).max(max);
const reference = z.string().min(1).max(2000);

const messagesInput = z.object({ chat: chat.optional(), thread: z.string().min(1).max(200).describe('话题 id（omt_ 开头），给了就读这个话题').optional(),
  start: z.string().max(40).describe('最早的时间，YYYY-MM-DD HH:mm，daemon 所在电脑的时区').optional(), end: z.string().max(40).describe('最晚的时间，格式同 start').optional(),
  order: z.enum(['newest', 'oldest']).describe('newest（默认）从最新往前；oldest 从最早往后').optional(), limit: limit(50).describe('一页几条，默认 20').optional(), cursor: cursor.optional() }).strict();
const messageInput = z.object({ messageId: z.string().min(1).max(200).describe('消息 id（om_ 开头）'), cursor: cursor.optional() }).strict();
const fileInput = z.object({ messageId: z.string().min(1).max(200).describe('文件所在消息的 id'), fileKey: z.string().min(1).max(400).describe('结果 attachments 里的 key'),
  type: z.enum(['image', 'file']).describe('attachments 里的 type'), name: z.string().min(1).max(200).describe('存成什么文件名，不写就用原来的').optional() }).strict();
const chatInput = z.object({ chat: chat.optional(), cursor: cursor.optional() }).strict();
const membersInput = z.object({ chat: chat.optional(), cursor: cursor.optional() }).strict();
const docInput = z.object({ doc: reference.describe('文档或知识库页面的链接，或者它的 token'), cursor: cursor.optional() }).strict();
const sheetInput = z.object({ sheet: reference.describe('表格的链接，或者它的 token'),
  range: z.string().min(1).max(200).describe('要读的区域，比如 <sheetId>!A1:D20；不写就列出有哪些工作表和它们的 id').optional(), cursor: cursor.optional() }).strict();
const driveInput = z.object({ file: reference.describe('云空间文件的链接，或者它的 token'), name: z.string().min(1).max(200).describe('存成什么文件名，不写就用原来的').optional() }).strict();
const searchInput = z.object({ query: z.string().min(1).max(500), chat: chat.describe('只搜这个群的 chat_id；群会话里只搜本群').optional(), limit: limit(20).describe('一页几条，默认 20').optional(), cursor: cursor.optional() }).strict();

const definitions = [
  { name: 'feishu_messages', input: messagesInput, description: '读群或话题的消息，可以按时间和游标翻页。结果带消息 id、发送人、时间和附件的 key。' },
  { name: 'feishu_message', input: messageInput, description: '读一条消息的全文；合并转发会展开。' },
  { name: 'feishu_file', input: fileInput, description: '下载消息里的图片或文件，返回本机路径。' },
  { name: 'feishu_chat', input: chatInput, description: '读群名、群描述和群公告。' },
  { name: 'feishu_members', input: membersInput, description: '查询群成员，失败不会伪装成空列表。' },
  { name: 'feishu_doc', input: docInput, description: '读飞书文档或知识库页面，返回文字内容；Bot 要有这篇文档的阅读权限。' },
  { name: 'feishu_sheet', input: sheetInput, description: '读飞书表格：列出工作表，或读一个区域；Bot 要有这张表的阅读权限。' },
  { name: 'feishu_drive_file', input: driveInput, description: '下载飞书云空间里的文件，返回本机路径；Bot 要有这个文件的阅读权限。' },
  { name: 'feishu_search', input: searchInput, description: '按关键词搜飞书消息。' },
] as const satisfies readonly { name: string; input: z.ZodObject; description: string }[];

/** The Claude backend lists these only in sessions whose profile has `tools.feishu`. */
export const feishuToolNames: ReadonlySet<string> = new Set(definitions.map(tool => tool.name));

/** The same tools without any provider's types, for Codex dynamicTools. */
export function feishuToolSpecs(): { name: string; description: string; inputSchema: object }[] {
  return definitions.map(({ name, description, input }) => ({ name, description, inputSchema: z.toJSONSchema(input) }));
}

const NOT_THIS_CHAT = '群里只能读本群的内容，读不了别的群。';
const denied = () => new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
const refusal = (message: string) => new ToolRefusal({ ok: false, code: 'refused', message });

/** A group's session is kept to its group; a private chat reads any group this Bot is in, on an administrator's turn. */
function chatOf(requested: string | undefined, ctx: ToolContext): { chat?: string; only?: string } {
  if (ctx.place.kind === 'group') {
    if (requested && requested !== ctx.place.chatId) throw refusal(NOT_THIS_CHAT);
    return { chat: ctx.place.chatId, only: ctx.place.chatId };
  }
  if (ctx.place.kind !== 'p2p' || !ctx.admin) throw denied();
  const target = requested ?? ctx.place.chatId;
  return target ? { chat: target } : {};
}

/** Documents are not kept to a group (7.2): whoever is in a place these tools are listed in reads them. */
function mayRead(ctx: ToolContext): void {
  if (ctx.place.kind !== 'group' && !(ctx.place.kind === 'p2p' && ctx.admin)) throw denied();
}

/** Runs a read, with the place looked at again after the wait (a private chat's turn can end during it). */
async function read<T>(ctx: ToolContext, run: () => Promise<T>): Promise<T> {
  mayRead(ctx);
  try {
    const result = await run();
    mayRead(ctx);
    return result;
  } catch (failure) {
    if (failure instanceof FeishuReadRefused) throw refusal(failure.message);
    throw failure;
  }
}

function tool<Input extends z.ZodObject>(name: typeof definitions[number]['name'], run: (args: z.infer<Input>, ctx: ToolContext) => Promise<unknown>): AgentTool {
  const definition = definitions.find(item => item.name === name)!;
  return { name, class: 'read', places: ['group', 'p2p'], description: definition.description, input: definition.input,
    run: (args, ctx) => read(ctx, () => run(definition.input.parse(args) as z.infer<Input>, ctx)) };
}

export function createFeishuTools(deps: { members(chatId: string, cursor?: string): Promise<FeishuMembers>; feishu?: FeishuReader }): AgentTool[] {
  const members = tool<typeof membersInput>('feishu_members', ({ chat: requested, cursor }, ctx) => {
    const { chat: target } = chatOf(requested, ctx);
    if (!target) throw refusal('要写 chat：想查哪个群。');
    return feishuMembers(deps, target, cursor);
  });
  const reader = deps.feishu;
  if (!reader) return [members];
  return [
    tool<typeof messagesInput>('feishu_messages', (args, ctx) => reader.messages({ ...args, ...chatOf(args.chat, ctx) })),
    tool<typeof messageInput>('feishu_message', (args, ctx) => reader.message({ ...args, ...only(ctx) })),
    tool<typeof fileInput>('feishu_file', (args, ctx) => reader.file({ ...args, ...only(ctx) })),
    tool<typeof chatInput>('feishu_chat', ({ chat: requested, ...rest }, ctx) => reader.chat({ ...rest, ...chatOf(requested, ctx) })),
    members,
    tool<typeof docInput>('feishu_doc', args => reader.doc(args)),
    tool<typeof sheetInput>('feishu_sheet', args => reader.sheet(args)),
    tool<typeof driveInput>('feishu_drive_file', args => reader.driveFile(args)),
    tool<typeof searchInput>('feishu_search', (args, ctx) => reader.search({ ...args, ...chatOf(args.chat, ctx) })),
  ];
}

/** A message named by id: its chat is only known once it is read, so the reader checks it against this. */
function only(ctx: ToolContext): { only?: string } {
  return ctx.place.kind === 'group' && ctx.place.chatId ? { only: ctx.place.chatId } : {};
}
