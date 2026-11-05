import { groupIdSchema } from '@vonvon/protocol';
import { z } from 'zod';
import { feishuMembers, type FeishuMembers } from '../../admin/structured-commands';
import { AdminWriteError } from '../../admin/write-error';
import { inboundChatDir } from '../../bot/media';
import type { PermissionMode } from '../types';
import { FeishuReadRefused } from '../../feishu-read/denial';
import type { FeishuReader, FeishuReadReply, FeishuReadRequest } from '../../feishu-read/reader';
import type { ApiRequest } from '../../feishu-read/api';
import { botNotRunning, type RoutedApi, type RoutedRead } from '../../admin/feishu-route';
import { ToolRefusal, type AgentTool, type ToolContext } from './tools';

/**
 * 飞书读取工具（dm-agent 7.1、7.2）：Claude 的 MCP 和 Codex 的 dynamicTools 共用这一份定义。工具不走沙箱，范围在这里
 * 守：群会话只读本群的消息、文件、公告、成员，文档、表格、多维表格、云空间不按群隔离；私聊看这一轮是不是管理员的；评论会话只有文档
 * 这一列（第 7.4 节）。结果就是内容本身，不加标注。改文档的 `feishu_doc_edit`（F3）也在这里，只读档不给。
 *
 * 跨 Bot（F2，第 7.3 节）：私聊的读取工具多一个 `bot`，经 host 走到那个 Bot 的进程，用它的身份读；群和评论没有这个参数，只在本进程读。
 * `vonvon feishu` 和工具跑同一张表 {@link readsOf}，所以结果一样。
 * 私聊的通用工具 `feishu_api`（F7，第 7.6 节）也在这里，群和评论没有；写了别的 Bot 时同样经 host 走到那个 Bot 的进程。
 */

const chat = z.string().min(1).max(200).describe('群的 id（oc_ 开头，不是群名）；不写就是当前这个群');
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
const slidesInput = z.object({ slides: reference.describe('幻灯片的链接，或者它的 token'), cursor: cursor.optional() }).strict();
const mindnoteInput = z.object({ mindnote: reference.describe('思维笔记的链接，或者它的 token'), cursor: cursor.optional() }).strict();
const boardInput = z.object({ board: reference.describe('画板的链接，或者它的 token；文档里的画板用结果里的 token'), cursor: cursor.optional() }).strict();
const minutesInput = z.object({ minutes: reference.describe('妙记的链接，或者它的 token'), cursor: cursor.optional() }).strict();
const driveInput = z.object({ file: reference.describe('云空间文件的链接，或者它的 token'), name: z.string().min(1).max(200).describe('存成什么文件名，不写就用原来的').optional() }).strict();
const folderInput = z.object({ folder: reference.describe('文件夹的链接，或者它的 token；不写就列 Bot 自己的根目录').optional(), limit: limit(100).describe('最多几条，默认一页读得下的都给').optional(), cursor: cursor.optional() }).strict();
const wikiInput = z.object({ wiki: reference.describe('知识库的链接或 space_id，列它的第一层；页面的链接或节点 token，列它下面的子页面。不写就列 Bot 能看到的知识库').optional(),
  limit: limit(100).describe('最多几条，默认一页读得下的都给').optional(), cursor: cursor.optional() }).strict();
const commentsInput = z.object({ doc: reference.describe('文档、表格、多维表格、幻灯片、云空间文件或知识库页面的链接，或者它的 token'),
  type: z.enum(['doc', 'docx', 'sheet', 'file', 'slides', 'bitable']).describe('裸 token 的类型，默认 docx，不是新版文档时要写；给链接时不用写').optional(),
  comment: z.string().min(1).max(200).describe('评论的 id，给了就只读这条评论的全部回复').optional(),
  solved: z.boolean().describe('true 只读已解决的，false 只读未解决的，不写都读').optional(), limit: limit(100).describe('最多几条，默认一页读得下的都给').optional(), cursor: cursor.optional() }).strict();
const docMediaInput = z.object({ token: z.string().min(1).max(400).describe('feishu_doc 结果里 <img src="…"> 的 src 或 <source token="…"> 的 token，也可以是 feishu_comments 结果里 images 的 token'),
  name: z.string().min(1).max(200).describe('存成什么文件名，不写就用原来的').optional() }).strict();
const docEditInput = z.object({ doc: reference.describe('文档或知识库页面的链接，或者它的 token'),
  action: z.enum(['append', 'insert', 'replace']).describe('append 追加到文末；insert 插到 block 后面；replace 换掉 pattern 或 block'),
  content: z.string().min(1).max(100_000).describe('新内容，Markdown'),
  block: z.string().min(1).max(200).describe('块的 id，在 feishu_doc 的结果里，改过文档后要重新读一次。insert 时插在它后面，replace 时换掉整个块').optional(),
  pattern: z.string().min(1).max(2000).describe('replace 时要换掉的一段行内文字，不跨段；文档里每一处都会被换').optional() }).strict();
const apiValue = z.union([z.string().max(4000), z.number(), z.boolean()]);
const apiInput = z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(2000).describe('接口路径，以 /open-apis/ 开头，不写域名和查询参数，路径里的 :id 换成真实的值'),
  params: z.record(z.string(), z.union([apiValue, z.array(apiValue).max(200)])).describe('查询参数，比如 page_size、page_token、user_id_type').optional(),
  body: z.record(z.string(), z.unknown()).describe('请求体，一个 JSON 对象').optional(),
  bot: z.string().min(1).max(200).describe('用这台电脑上哪个 Bot 的身份，写 App ID 或名字；不写就是当前 Bot').optional() }).strict();
const searchInput = z.object({ query: z.string().min(1).max(500), chat: chat.describe('只搜这个群，写 oc_ 开头的 id；群会话里只搜本群').optional(), limit: limit(20).describe('一页几条，默认 20').optional(), cursor: cursor.optional() }).strict();
/** A private chat's only (7.3). */
const bot = z.string().min(1).max(200).describe('用这台电脑上哪个 Bot 的身份读，写名字或 App ID。不写时，读群用绑了这个群的 Bot，优先当前 Bot；其余用当前 Bot').optional();
const withBot = (input: z.ZodObject) => input.extend({ bot });

const definitions = [
  { name: 'feishu_messages', input: messagesInput, description: '读群或话题的消息，可以按时间和游标翻页。结果带消息 id、发送人、时间和附件的 key。' },
  { name: 'feishu_message', input: messageInput, description: '读一条消息的全文；合并转发会展开。' },
  { name: 'feishu_file', input: fileInput, description: '下载消息里的图片或文件，返回本机路径。' },
  { name: 'feishu_chat', input: chatInput, description: '读群名、群描述和群公告。' },
  { name: 'feishu_members', input: membersInput, description: '查询群成员，失败不会伪装成空列表。' },
  { name: 'feishu_doc', input: docInput, description: '读飞书文档（新版和旧版）或知识库页面，返回文字内容；Bot 要有这篇文档的阅读权限。' },
  { name: 'feishu_sheet', input: sheetInput, description: '读飞书表格：列出工作表，或读一个区域；Bot 要有这张表的阅读权限。' },
  { name: 'feishu_base', input: baseInput, description: '读飞书多维表格：列出数据表、字段和视图，或读记录，可以按视图和条件筛选、翻页；Bot 要有这个多维表格的阅读权限。' },
  { name: 'feishu_slides', input: slidesInput, description: '读飞书幻灯片的全文，返回 XML，太长时分段；Bot 要有这份幻灯片的阅读权限。' },
  { name: 'feishu_mindnote', input: mindnoteInput, description: '读飞书思维笔记，返回带层级的文字，太长时分段；Bot 要有这份思维笔记的阅读权限。' },
  { name: 'feishu_board', input: boardInput, description: '读飞书画板上的节点，返回文字和连线，太长时分段；图片只有 token。Bot 要有这个画板的阅读权限。' },
  { name: 'feishu_minutes', input: minutesInput, description: '读飞书妙记的标题、时长等信息和文字记录，文字记录太长时分段；Bot 要有这条妙记的阅读权限。' },
  { name: 'feishu_drive_file', input: driveInput, description: '下载飞书云空间里的文件，返回本机路径；Bot 要有这个文件的阅读权限。' },
  { name: 'feishu_folder', input: folderInput, description: '看飞书云空间文件夹里有什么，可以翻页。不写 folder 列 Bot 自己的根目录，别人分享给 Bot 的文件夹不在那里，要给链接。结果带名字、类型和 token：文件夹接着用这个工具，其他类型用对应的工具读。' },
  { name: 'feishu_wiki', input: wikiInput, description: '看飞书知识库的目录：列出 Bot 能看到的知识库，或一个知识库、一个页面下面的页面，可以翻页。结果的 token 用来往下列，hasChildren 说明下面还有；objToken 和 type 用来读页面内容，比如 docx 用 feishu_doc。' },
  { name: 'feishu_comments', input: commentsInput, description: '读一篇文档的评论和回复，可以翻页。一条评论带它引用的原文、是否解决和回复；moreReplies 为真时，用 comment 读这条评论的全部回复。Bot 要有这篇文档的阅读权限。' },
  { name: 'feishu_doc_media', input: docMediaInput, description: '下载飞书文档里的图片和附件，返回本机路径。先用 feishu_doc 读文档，图片是 <img src="…">，附件是 <source token="…">，把 src 或 token 传进来。Bot 要有这篇文档的阅读权限。' },
  { name: 'feishu_search', input: searchInput, description: '按关键词搜飞书消息。' },
] as const satisfies readonly { name: string; input: z.ZodObject; description: string }[];

export const feishuToolNames: ReadonlySet<string> = new Set(definitions.map(tool => tool.name));
/** The document column of 7.2: all a comment's session reads, there being no chat for it to read. */
export const feishuDocToolNames: ReadonlySet<string> = new Set(['feishu_doc', 'feishu_sheet', 'feishu_base', 'feishu_slides', 'feishu_mindnote', 'feishu_board', 'feishu_minutes', 'feishu_drive_file', 'feishu_folder', 'feishu_wiki', 'feishu_comments', 'feishu_doc_media']);
/** Not among {@link feishuToolNames}: a session gets it by `tools.feishuEdit`, its tier's call. */
export const FEISHU_DOC_EDIT = 'feishu_doc_edit';
const docEditDescription = '改飞书新版文档：追加、插入、替换选中的内容，身份是 Bot 自己。表格和多维表格改不了。Bot 要有这篇文档的编辑权限。';
/** Not among {@link feishuToolNames} either: a session gets it by `tools.feishuApi`, a private chat's only. */
export const FEISHU_API = 'feishu_api';
const apiDescription = '用 Bot 自己的身份调飞书开放平台的接口，能读能写。先用专门的飞书工具；没有专门工具时，查飞书开放平台文档（https://open.feishu.cn/document/ 下的页面，链接加 .md 能读到文本），再照文档调这个工具。'
  + '请求体只发 JSON，上传文件的接口调不了；换令牌的 /open-apis/auth/ 也调不了。结果是飞书的原文，太长时被截断，要缩小范围或翻页；二进制响应存成本机文件，返回路径和大小。缺权限时返回开通链接。';
/** The Claude backend lists these only in sessions whose profile has `tools.feishu`; `feishu_members` is older and always listed. */
export const feishuReadToolNames: ReadonlySet<string> = new Set([...feishuToolNames].filter(name => name !== 'feishu_members'));

/** The same tools without any provider's types, for Codex dynamicTools. */
export function feishuToolSpecs(tools: { feishuEdit?: boolean; feishuApi?: boolean; documentsOnly?: boolean; acrossBots?: boolean } = {}): { name: string; description: string; inputSchema: object }[] {
  const reads = definitions.filter(({ name }) => !tools.documentsOnly || feishuDocToolNames.has(name));
  return [...reads.map(({ name, description, input }) => ({ name, description, inputSchema: z.toJSONSchema(tools.acrossBots ? withBot(input) : input) })),
    ...tools.feishuEdit ? [{ name: FEISHU_DOC_EDIT, description: docEditDescription, inputSchema: z.toJSONSchema(docEditInput) }] : [],
    ...tools.feishuApi ? [{ name: FEISHU_API, description: apiDescription, inputSchema: z.toJSONSchema(apiInput) }] : []];
}

const NOT_THIS_CHAT = '群里只能读本群的内容，读不了别的群。';
const NOT_A_CHAT_ID = 'chat 要写 oc_ 开头的群 id，不是群名。用 "$VONVON_CLI" group list 查。';
const denied = () => new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
const refusal = (message: string) => new ToolRefusal({ ok: false, code: 'refused', message });
const READ_ONLY_TIER = '这个群是只读档，改不了文档。要改，请管理员在 Vonvon Bot 客户端里调高这个群的权限。';

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

/**
 * The registry has looked at the turn (authorizeFeishuApi, dmTurn); it goes through `commit` because any method may change
 * something. Another Bot's call (7.3, 7.6) is past that same guard before it leaves this process: the guard cannot cross,
 * and the host and that Bot, which see no turn, let it through on the session alone.
 */
function apiTool(reader: FeishuReader, route: ReadRoute['routeApi']): AgentTool {
  return { name: FEISHU_API, class: 'feishu-api', places: ['p2p'], description: apiDescription, input: apiInput,
    async run(args, ctx) {
      const { bot, ...request } = apiInput.parse(args);
      const commit = ctx.commit;
      if (ctx.place.kind !== 'p2p' || !commit) throw denied();
      try {
        if (bot === undefined || reader.isThisBot(bot)) return await commit(guard => reader.api(request, guard));
        const { sessionId } = ctx;
        if (!route || !sessionId) throw refusal(botNotRunning(bot));
        return await commit(async guard => {
          guard();
          const reply = await route(bot, { sessionId, request });
          if (!reply.ok) throw refusal(reply.message);
          return reply.result;
        });
      } catch (failure) {
        if (failure instanceof FeishuReadRefused) throw refusal(failure.message);
        throw failure;
      }
    } };
}

type Definition = typeof definitions[number];
export type FeishuReadName = Definition['name'];
type Reads = { [Name in FeishuReadName]: (args: z.infer<Extract<Definition, { name: Name }>['input']>, only: string | undefined) => Promise<unknown> };
interface ReadDeps { members(chatId: string, cursor?: string): Promise<FeishuMembers>; feishu?: FeishuReader }
/** How this process reaches the host for a private chat (7.3). No host, no other Bot. */
interface ReadRoute {
  /** A read: the host picks the Bot. */
  route?(bot: string | undefined, request: RoutedRead): Promise<FeishuReadReply>;
  /** `feishu_api` on the Bot named. */
  routeApi?(bot: string, request: RoutedApi): Promise<FeishuReadReply>;
}

/** The chat a read is on: a read kept to a chat (a group's session, 7.2) takes no other, and says so before Feishu is asked. */
function chatIn(requested: string | undefined, only: string | undefined): { chat?: string; only?: string } {
  if (!only) {
    if (requested && !groupIdSchema.safeParse(requested).success) throw new FeishuReadRefused(NOT_A_CHAT_ID);
    return requested ? { chat: requested } : {};
  }
  if (requested && requested !== only) throw new FeishuReadRefused(NOT_THIS_CHAT);
  return { chat: only, only };
}
/** A message named by id: its chat is only known once it is read, so the reader checks it against this. */
const keptTo = (only: string | undefined): { only?: string } => only ? { only } : {};
/** A group's downloads go to its own folder, the one its restricted sessions can read. */
const savedIn = (only: string | undefined): { saveIn?: string } => only ? { saveIn: inboundChatDir(only) } : {};

/** Each read as plain data: the tools', and what a host asks of this process for a private chat or the command line. */
function readsOf({ members, feishu: reader }: ReadDeps): Partial<Reads> {
  const list: Reads['feishu_members'] = ({ chat: requested, cursor }, only) => {
    const { chat: target } = chatIn(requested, only);
    if (!target) throw new FeishuReadRefused('要写 chat：想查哪个群。');
    return feishuMembers({ members }, target, cursor);
  };
  if (!reader) return { feishu_members: list };
  return {
    feishu_messages: (args, only) => reader.messages({ ...args, ...chatIn(args.chat, only) }),
    feishu_message: (args, only) => reader.message({ ...args, ...keptTo(only) }),
    feishu_file: (args, only) => reader.file({ ...args, ...keptTo(only), ...savedIn(only) }),
    feishu_chat: ({ chat: requested, ...rest }, only) => reader.chat({ ...rest, ...chatIn(requested, only) }),
    feishu_members: list,
    feishu_doc: args => reader.doc(args),
    feishu_sheet: args => reader.sheet(args),
    feishu_base: args => reader.base(args),
    feishu_slides: args => reader.slides(args),
    feishu_mindnote: args => reader.mindnote(args),
    feishu_board: args => reader.board(args),
    feishu_minutes: args => reader.minutes(args),
    feishu_drive_file: (args, only) => reader.driveFile({ ...args, ...savedIn(only) }),
    feishu_folder: args => reader.folder(args),
    feishu_wiki: args => reader.wiki(args),
    feishu_comments: args => reader.comments(args),
    feishu_doc_media: (args, only) => reader.docMedia({ ...args, ...savedIn(only) }),
    feishu_search: (args, only) => reader.search({ ...args, ...chatIn(args.chat, only) }),
  };
}

/** What is wrong with a read's arguments: the command line's to hear before any Bot is asked. */
export function feishuReadProblem({ tool, args }: Pick<FeishuReadRequest, 'tool' | 'args'>): string | undefined {
  const parsed = definitions.find(item => item.name === tool)?.input.safeParse(args);
  return !parsed || parsed.success ? undefined : `参数不对：${parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}：${issue.code}`).join('；')}。`;
}

function perform(reads: Partial<Reads>, { tool, args, only }: FeishuReadRequest): Promise<unknown> {
  const definition = definitions.find(item => item.name === tool);
  const run = definition && reads[definition.name] as ((args: unknown, only: string | undefined) => Promise<unknown>) | undefined;
  if (!definition || !run) throw new FeishuReadRefused(`没有 ${tool} 这个读取工具。`);
  const problem = feishuReadProblem({ tool, args });
  if (problem) throw new FeishuReadRefused(problem);
  return run(definition.input.parse(args), only);
}

/**
 * This process's reads for the host (dm-agent 7.3): another Bot's private chat or the command line asking, already let
 * through there. A refusal is an answer, in this Bot's name, for the host to pass on.
 */
export function createFeishuReads(deps: ReadDeps): (request: FeishuReadRequest) => Promise<FeishuReadReply> {
  const reads = readsOf(deps);
  return request => answered(() => perform(reads, request));
}

/** `feishu_api` for the host: another Bot's private chat, its turn looked at there (7.6). Never reached by `command.feishuRead`, whose table has no such tool. */
export const createFeishuCalls = (reader: FeishuReader) => (request: ApiRequest): Promise<FeishuReadReply> => answered(() => reader.api(request));

async function answered(run: () => Promise<unknown>): Promise<FeishuReadReply> {
  try {
    return { ok: true, result: await run() };
  } catch (failure) {
    if (failure instanceof FeishuReadRefused) return { ok: false, kind: failure.kind, message: failure.message };
    // feishu_members reads through the group commands, which refuse in their own error.
    if (failure instanceof AdminWriteError) return { ok: false, kind: 'other', message: failure.message };
    throw failure;
  }
}

export function createFeishuTools(deps: ReadDeps & ReadRoute & {
  /** A group's permission tier now, for the edit tool. */
  groupTier?(chatId: string): Promise<PermissionMode | undefined> }): AgentTool[] {
  const reads = readsOf(deps);
  /** The place's own Bot and chat. In a private chat the chat left out is that chat, of this Bot only. */
  async function across(name: FeishuReadName, input: z.ZodObject, given: unknown, ctx: ToolContext): Promise<unknown> {
    const { bot: named, ...args } = withBot(input).parse(given) as { bot?: string; chat?: string };
    const here = 'chat' in input.shape && !args.chat && !named && ctx.place.chatId ? { chat: ctx.place.chatId } : {};
    const request = { tool: name, args: { ...args, ...here } };
    if (!deps.route || !ctx.sessionId) {
      if (named) throw refusal(botNotRunning(named));
      return perform(reads, request);
    }
    const reply = await deps.route(named, { ...request, sessionId: ctx.sessionId });
    if (!reply.ok) throw refusal(reply.message);
    return reply.result;
  }
  function tool(name: FeishuReadName): AgentTool {
    const definition = definitions.find(item => item.name === name)!;
    const { input, description } = definition;
    const documents = feishuDocToolNames.has(name);
    return { name, ...documents ? { class: 'document' as const } : { class: 'read' as const, places: ['group', 'p2p'] as const }, description, input, dmInput: withBot(input),
      run: (args, ctx) => read(ctx, async () => {
        if (ctx.place.kind === 'p2p') return across(name, input, args, ctx);
        if (ctx.place.kind === 'doc' && !documents) throw denied();
        return perform(reads, { tool: name, args: args as Record<string, unknown>, ...(ctx.place.kind === 'group' && ctx.place.chatId ? { only: ctx.place.chatId } : {}) });
      }) };
  }
  const reader = deps.feishu;
  if (!reader) return [tool('feishu_members')];
  return [...definitions.map(({ name }) => tool(name)), docEditTool(reader, deps.groupTier), apiTool(reader, deps.routeApi)];
}
