import { z } from 'zod';
import { feishuMembers, type FeishuMembers } from '../../admin/structured-commands';
import { inboundChatDir } from '../../bot/media';
import type { PermissionMode } from '../types';
import { FeishuReadRefused } from '../../feishu-read/denial';
import type { FeishuReader } from '../../feishu-read/reader';
import { ToolRefusal, type AgentTool, type ToolContext } from './tools';

/**
 * 飞书读取工具（dm-agent 7.1、7.2）：Claude 的 MCP 和 Codex 的 dynamicTools 共用这一份定义。工具不走沙箱，范围在这里
 * 守：群会话只读本群的消息、文件、公告、成员，文档、表格、多维表格、云空间不按群隔离；私聊看这一轮是不是管理员的；评论会话只有文档
 * 这一列（第 7.4 节）。跨 Bot 是 F2。结果就是内容本身，不加标注。改文档的 `feishu_doc_edit`（F3）也在这里，只读档不给。
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
const baseCondition = z.object({ field: z.string().min(1).max(200).describe('字段名'),
  operator: z.enum(['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty', 'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual']),
  value: z.array(z.string().max(2000)).max(50).describe('比较的值，一律写成字符串；日期写 ["ExactDate","<毫秒时间戳>"]；isEmpty、isNotEmpty 不写').optional() }).strict();
const baseInput = z.object({ base: reference.describe('多维表格的链接，或者它的 token；链接里的 table、view 会用上'),
  what: z.enum(['tables', 'fields', 'views', 'records']).describe('读什么：tables 数据表，fields 字段，views 视图，records 记录。不写时，有 table 读记录，没有就列数据表').optional(),
  table: z.string().min(1).max(200).describe('数据表的 id（tbl 开头）').optional(), view: z.string().min(1).max(200).describe('视图的 id（vew 开头），写了 filter 时不起作用').optional(),
  fields: z.array(z.string().min(1).max(200)).min(1).max(200).describe('只读这些字段，写字段名').optional(),
  filter: z.object({ conjunction: z.enum(['and', 'or']).describe('默认 and').optional(), conditions: z.array(baseCondition).min(1).max(50) }).strict().describe('筛选记录，范围是整张数据表').optional(),
  limit: limit(100).describe('最多几条，默认一页读得下的都给').optional(), cursor: cursor.optional() }).strict();
const driveInput = z.object({ file: reference.describe('云空间文件的链接，或者它的 token'), name: z.string().min(1).max(200).describe('存成什么文件名，不写就用原来的').optional() }).strict();
const docEditInput = z.object({ doc: reference.describe('文档或知识库页面的链接，或者它的 token'),
  action: z.enum(['append', 'insert', 'replace']).describe('append 追加到文末；insert 插到 block 后面；replace 换掉 pattern 或 block'),
  content: z.string().min(1).max(100_000).describe('新内容，Markdown'),
  block: z.string().min(1).max(200).describe('块的 id，在 feishu_doc 的结果里，改过文档后要重新读一次。insert 时插在它后面，replace 时换掉整个块').optional(),
  pattern: z.string().min(1).max(2000).describe('replace 时要换掉的一段行内文字，不跨段；文档里每一处都会被换').optional() }).strict();
const searchInput = z.object({ query: z.string().min(1).max(500), chat: chat.describe('只搜这个群的 chat_id；群会话里只搜本群').optional(), limit: limit(20).describe('一页几条，默认 20').optional(), cursor: cursor.optional() }).strict();

const definitions = [
  { name: 'feishu_messages', input: messagesInput, description: '读群或话题的消息，可以按时间和游标翻页。结果带消息 id、发送人、时间和附件的 key。' },
  { name: 'feishu_message', input: messageInput, description: '读一条消息的全文；合并转发会展开。' },
  { name: 'feishu_file', input: fileInput, description: '下载消息里的图片或文件，返回本机路径。' },
  { name: 'feishu_chat', input: chatInput, description: '读群名、群描述和群公告。' },
  { name: 'feishu_members', input: membersInput, description: '查询群成员，失败不会伪装成空列表。' },
  { name: 'feishu_doc', input: docInput, description: '读飞书文档或知识库页面，返回文字内容；Bot 要有这篇文档的阅读权限。' },
  { name: 'feishu_sheet', input: sheetInput, description: '读飞书表格：列出工作表，或读一个区域；Bot 要有这张表的阅读权限。' },
  { name: 'feishu_base', input: baseInput, description: '读飞书多维表格：列出数据表、字段和视图，或读记录，可以按视图和条件筛选、翻页；Bot 要有这个多维表格的阅读权限。' },
  { name: 'feishu_drive_file', input: driveInput, description: '下载飞书云空间里的文件，返回本机路径；Bot 要有这个文件的阅读权限。' },
  { name: 'feishu_search', input: searchInput, description: '按关键词搜飞书消息。' },
] as const satisfies readonly { name: string; input: z.ZodObject; description: string }[];

export const feishuToolNames: ReadonlySet<string> = new Set(definitions.map(tool => tool.name));
/** The document column of 7.2: all a comment's session reads, there being no chat for it to read. */
export const feishuDocToolNames: ReadonlySet<string> = new Set(['feishu_doc', 'feishu_sheet', 'feishu_base', 'feishu_drive_file']);
/** Not among {@link feishuToolNames}: a session gets it by `tools.feishuEdit`, its tier's call. */
export const FEISHU_DOC_EDIT = 'feishu_doc_edit';
const docEditDescription = '改飞书新版文档：追加、插入、替换选中的内容，身份是 Bot 自己。表格和多维表格改不了。Bot 要有这篇文档的编辑权限。';
/** The Claude backend lists these only in sessions whose profile has `tools.feishu`; `feishu_members` is older and always listed. */
export const feishuReadToolNames: ReadonlySet<string> = new Set([...feishuToolNames].filter(name => name !== 'feishu_members'));

/** The same tools without any provider's types, for Codex dynamicTools. */
export function feishuToolSpecs(tools: { feishuEdit?: boolean; documentsOnly?: boolean } = {}): { name: string; description: string; inputSchema: object }[] {
  const reads = definitions.filter(({ name }) => !tools.documentsOnly || feishuDocToolNames.has(name));
  return [...reads.map(({ name, description, input }) => ({ name, description, inputSchema: z.toJSONSchema(input) })),
    ...tools.feishuEdit ? [{ name: FEISHU_DOC_EDIT, description: docEditDescription, inputSchema: z.toJSONSchema(docEditInput) }] : []];
}

const NOT_THIS_CHAT = '群里只能读本群的内容，读不了别的群。';
const denied = () => new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
const refusal = (message: string) => new ToolRefusal({ ok: false, code: 'refused', message });
const READ_ONLY_TIER = '这个群是只读档，改不了文档。要改，请管理员在 Vonvon Bot 客户端里调高这个群的权限。';

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

/** Documents are not kept to a group (7.2): whoever is in a place these tools are listed in reads them. A comment's turn is the registry's (authorizeFeishu). */
function mayRead(ctx: ToolContext): void {
  if (ctx.place.kind !== 'group' && ctx.place.kind !== 'doc' && !(ctx.place.kind === 'p2p' && ctx.admin)) throw denied();
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
  return { name, ...feishuDocToolNames.has(name) ? { class: 'document' as const } : { class: 'read' as const, places: ['group', 'p2p'] as const }, description: definition.description, input: definition.input,
    run: (args, ctx) => read(ctx, () => run(definition.input.parse(args) as z.infer<Input>, ctx)) };
}

/**
 * The tool skips the sandbox, so the tier is looked at here too (7.2), now, whatever the session was started with: a resumed
 * Codex thread keeps the tools of its rollout. A comment has no tier; a private chat is full access.
 */
async function mayEdit(ctx: ToolContext, tier: ((chatId: string) => Promise<PermissionMode | undefined>) | undefined): Promise<void> {
  mayRead(ctx);
  if (ctx.place.kind !== 'group') return;
  const current = ctx.place.chatId ? await tier?.(ctx.place.chatId) : undefined;
  if (!current || current === 'qa') throw refusal(READ_ONLY_TIER);
}

function docEditTool(reader: FeishuReader, tier: ((chatId: string) => Promise<PermissionMode | undefined>) | undefined): AgentTool {
  return { name: FEISHU_DOC_EDIT, class: 'document', writes: true, description: docEditDescription, input: docEditInput,
    async run(args, ctx) {
      const request = docEditInput.parse(args);
      await mayEdit(ctx, tier);
      const commit = ctx.commit;
      if (!commit) throw denied();
      try {
        return await commit(async guard => {
          // A bare token that turns out to be a knowledge-base page's is tried twice; the guard takes one call.
          let guarded = false;
          return reader.docEdit(request, () => { if (!guarded) { guarded = true; guard(); } });
        });
      } catch (failure) {
        if (failure instanceof FeishuReadRefused) throw refusal(failure.message);
        throw failure;
      }
    } };
}

export function createFeishuTools(deps: { members(chatId: string, cursor?: string): Promise<FeishuMembers>; feishu?: FeishuReader;
  /** A group's permission tier now, for the edit tool. */
  groupTier?(chatId: string): Promise<PermissionMode | undefined> }): AgentTool[] {
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
    tool<typeof fileInput>('feishu_file', (args, ctx) => reader.file({ ...args, ...only(ctx), ...savedIn(ctx) })),
    tool<typeof chatInput>('feishu_chat', ({ chat: requested, ...rest }, ctx) => reader.chat({ ...rest, ...chatOf(requested, ctx) })),
    members,
    tool<typeof docInput>('feishu_doc', args => reader.doc(args)),
    tool<typeof sheetInput>('feishu_sheet', args => reader.sheet(args)),
    tool<typeof baseInput>('feishu_base', args => reader.base(args)),
    tool<typeof driveInput>('feishu_drive_file', (args, ctx) => reader.driveFile({ ...args, ...savedIn(ctx) })),
    tool<typeof searchInput>('feishu_search', (args, ctx) => reader.search({ ...args, ...chatOf(args.chat, ctx) })),
    docEditTool(reader, deps.groupTier),
  ];
}

/** A group's downloads go to its own folder, the one its restricted sessions can read. */
function savedIn(ctx: ToolContext): { saveIn?: string } {
  return ctx.place.kind === 'group' && ctx.place.chatId ? { saveIn: inboundChatDir(ctx.place.chatId) } : {};
}

/** A message named by id: its chat is only known once it is read, so the reader checks it against this. */
function only(ctx: ToolContext): { only?: string } {
  return ctx.place.kind === 'group' && ctx.place.chatId ? { only: ctx.place.chatId } : {};
}
