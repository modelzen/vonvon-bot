import { CARD_CONTENT, kindOf, meOf, toContextMessage, sanitizeContext, type Me, type RawMsgItem } from '../bot/context-weave';
import { cleanFileName, downloadName, imageExtension, imageKeysFromContent, prepareInboundDir, saveInboundDownload } from '../bot/media';
import { formatAt, hostTimeZone, parseLocal } from '../bot/schedule/time';
import { FeishuReadRefused } from './denial';
import { ask, cleanText, jsonBytes, RESULT_BUDGET, sliceText, textOffset, type ReadDeps } from './shared';

/** A chat this read is kept to (a group session's own, dm-agent 7.2); a message of any other chat is refused. */
export interface Kept { only?: string }
export interface MessagesRequest extends Kept { chat?: string; thread?: string; start?: string; end?: string; order?: 'newest' | 'oldest'; limit?: number; cursor?: string }
export interface MessageRequest extends Kept { messageId: string; cursor?: string }
export interface FileRequest extends Kept { messageId: string; fileKey: string; type: 'image' | 'file'; name?: string }
export interface ChatRequest { chat?: string; cursor?: string }
export interface SearchRequest { query: string; chat?: string; only?: string; limit?: number; cursor?: string }

export interface MessageRow {
  id: string; time: string; sender: string; from: 'user' | 'bot' | 'self'; text: string;
  senderId?: string; threadId?: string; replyTo?: string; mentionsMe?: true; truncated?: true;
  attachments?: { type: 'image' | 'file'; key: string; name?: string }[];
}

/** Per message in a list; `feishu_message` reads one whole. */
const LIST_TEXT_MAX = 4000;
/** One message read alone; a text message's limit is 150 KB, so this fits with room for what was forwarded in it. */
const FULL_TEXT_MAX = 60_000;
const SEARCH_TEXT_MAX = 2000;
const PAGE_MAX = 50;
/** Announcement pages read at most. */
const ANNOUNCEMENT_PAGES = 5;
const OTHER_CHAT = '这条消息不在本群，群里只能读本群的消息。';
const NEED_CHAT = '要写 chat：想读哪个群。';

type ListData = { items?: RawMsgItem[]; has_more?: boolean; page_token?: string };

function attachmentsOf(item: RawMsgItem): MessageRow['attachments'] {
  const type = item.msg_type;
  if (type === 'image' || type === 'post') {
    const keys = imageKeysFromContent(type, item.body?.content);
    return keys.length ? keys.map(key => ({ type: 'image' as const, key })) : undefined;
  }
  if (type !== 'file' && type !== 'audio' && type !== 'media') return undefined;
  try {
    const { file_key: key, file_name: name } = JSON.parse(item.body?.content ?? '{}') as { file_key?: string; file_name?: string };
    const clean = cleanFileName(name);
    return key ? [{ type: 'file', key, ...(clean ? { name: clean } : {}) }] : undefined;
  } catch {
    return undefined;
  }
}

/** One message as a tool result; undefined for a recalled one and a system notice, which the record block leaves out too. */
function messageRow(item: RawMsgItem, me: Me, max: number): MessageRow | undefined {
  const from = kindOf(item.sender, me);
  if (item.deleted || !from) return undefined;
  const message = toContextMessage(item, me);
  const whole = cleanText(message.text);
  const text = sanitizeContext(message.text, max, false, true);
  const zone = hostTimeZone();
  const attachments = attachmentsOf(item);
  return {
    id: message.messageId, time: message.createTime ? formatAt(message.createTime, zone, zone) : '', sender: sanitizeContext(message.senderName, 80, true), from, text,
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.parentId ? { replyTo: message.parentId } : {}),
    ...(message.mentionsMe ? { mentionsMe: true as const } : {}),
    ...(text !== whole ? { truncated: true as const } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

/** A page of a list and how far into it the last result got: Feishu's page tokens cannot stop in the middle of a page. */
interface Position { page?: string; skip: number; size: number }
const encodeCursor = (at: Position): string => Buffer.from(JSON.stringify(at)).toString('base64url');
function decodeCursor(cursor: string | undefined, size: number): Position {
  if (cursor === undefined) return { skip: 0, size };
  try {
    const at = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Position>;
    if (Number.isSafeInteger(at.skip) && at.skip! >= 0 && Number.isSafeInteger(at.size) && at.size! >= 1 && at.size! <= PAGE_MAX
      && (at.page === undefined || typeof at.page === 'string')) return { ...at.page ? { page: at.page } : {}, skip: at.skip!, size: at.size! };
  } catch { /* the refusal below */ }
  throw new FeishuReadRefused('cursor 不对：用上一次结果里的 cursor，原样传回来。');
}

function timeOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const at = parseLocal(hostTimeZone(), text);
  if (at === undefined) throw new FeishuReadRefused('时间要写成 YYYY-MM-DD HH:mm，比如 2026-11-01 14:00。');
  return at;
}

/** A page of a chat or a topic, newest first unless asked, each result within the budget. */
export async function readMessages(deps: ReadDeps, request: MessagesRequest): Promise<{ messages: MessageRow[]; cursor?: string }> {
  const container = request.thread ? { type: 'thread', id: request.thread } : request.chat ? { type: 'chat', id: request.chat } : undefined;
  if (!container) throw new FeishuReadRefused(NEED_CHAT);
  const at = decodeCursor(request.cursor, request.limit ?? 20);
  const start = timeOf(request.start), end = timeOf(request.end);
  const me = meOf(deps.channel);
  const answer = await ask(deps, 'history', () => deps.channel.rawClient.im.v1.message.list({
    params: {
      container_id_type: container.type, container_id: container.id, page_size: at.size, with_sender_name: true,
      sort_type: request.order === 'oldest' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc', card_msg_content_type: CARD_CONTENT,
      // A topic takes no time window: its messages are filtered below.
      ...(container.type === 'chat' && start !== undefined ? { start_time: String(Math.floor(start / 1000)) } : {}),
      ...(container.type === 'chat' && end !== undefined ? { end_time: String(Math.ceil(end / 1000)) } : {}),
      ...(at.page ? { page_token: at.page } : {}),
    },
  }));
  const data = answer.data as ListData | undefined;
  const items = data?.items ?? [];
  const messages: MessageRow[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    // Every item, not only the first: a topic's id or a cursor could name another group's messages.
    if (request.only && item.chat_id !== request.only) throw new FeishuReadRefused(OTHER_CHAT);
    if (index < at.skip) continue;
    const time = Number(item.create_time);
    if ((start !== undefined && time < start) || (end !== undefined && time > end)) continue;
    const row = messageRow(item, me, LIST_TEXT_MAX);
    if (!row) continue;
    used += jsonBytes(row);
    if (used > RESULT_BUDGET && messages.length) return { messages, cursor: encodeCursor({ ...at, skip: index }) };
    messages.push(row);
  }
  return { messages, ...(data?.has_more && data.page_token ? { cursor: encodeCursor({ page: data.page_token, skip: 0, size: at.size }) } : {}) };
}

/** The message and, for a merged forward, what Feishu lists after it. */
async function getMessage(deps: ReadDeps, messageId: string, only: string | undefined): Promise<{ item: RawMsgItem; rest: RawMsgItem[] }> {
  const answer = await ask(deps, 'history', () => deps.channel.rawClient.im.v1.message.get({
    path: { message_id: messageId }, params: { with_sender_name: true, card_msg_content_type: CARD_CONTENT },
  }));
  const items = (answer.data as { items?: RawMsgItem[] } | undefined)?.items ?? [];
  const item = items.find(it => it.message_id === messageId) ?? items[0];
  if (!item) throw new FeishuReadRefused('找不到这条消息。', 'not-found');
  // Only the message itself: what is forwarded in it came from other chats and was posted here.
  if (only && item.chat_id !== only) throw new FeishuReadRefused(OTHER_CHAT);
  return { item, rest: items.filter(it => it !== item) };
}

export async function readMessage(deps: ReadDeps, request: MessageRequest): Promise<{ message: MessageRow; forwarded?: MessageRow[]; cursor?: string }> {
  const { item, rest } = await getMessage(deps, request.messageId, request.only);
  const me = meOf(deps.channel);
  const message = messageRow(item, me, FULL_TEXT_MAX);
  if (!message) throw new FeishuReadRefused('这条消息已经撤回了，或者是系统通知。', 'not-found');
  const skip = textOffset(request.cursor);
  const forwarded: MessageRow[] = [];
  let used = jsonBytes(message);
  for (const [index, sub] of rest.entries()) {
    if (index < skip) continue;
    const row = messageRow(sub, me, LIST_TEXT_MAX);
    if (!row) continue;
    used += jsonBytes(row);
    if (used > RESULT_BUDGET) return { message, forwarded, cursor: String(index) };
    forwarded.push(row);
  }
  return { message, ...(rest.length ? { forwarded } : {}) };
}

/** A message's image or file, saved where a received attachment is (dm-agent 7.1). */
export async function readFile(deps: ReadDeps, request: FileRequest): Promise<{ path: string; name: string }> {
  const { item } = await getMessage(deps, request.messageId, request.only);
  const res = await ask(deps, 'resource', () => deps.channel.rawClient.im.v1.messageResource.get({
    path: { message_id: request.messageId, file_key: request.fileKey }, params: { type: request.type },
  }), 60_000);
  const named = attachmentsOf(item)?.find(attachment => attachment.key === request.fileKey)?.name;
  const fallback = request.type === 'image' ? `image.${imageExtension(res.headers)}` : 'file';
  const name = cleanFileName(request.name ?? named ?? downloadName(res.headers)) || fallback;
  await prepareInboundDir();
  const saved = await saveInboundDownload(res, request.fileKey, name);
  if ('reason' in saved) throw new FeishuReadRefused(`没下载成：${saved.reason}。`);
  return { path: saved.path, name: saved.name };
}

/** A block's words: every kind of text block keeps them in `<kind>.elements`. */
function blockText(block: Record<string, unknown>): string {
  for (const value of Object.values(block)) {
    const elements = (value as { elements?: unknown } | null)?.elements;
    if (!Array.isArray(elements)) continue;
    return (elements as { text_run?: { content?: string }; mention_doc?: { title?: string } }[])
      .map(element => element.text_run?.content ?? element.mention_doc?.title ?? '').join('');
  }
  return '';
}

async function announcementText(deps: ReadDeps, chat: string): Promise<string> {
  const lines: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < ANNOUNCEMENT_PAGES; page++) {
    const pageToken = token;
    const answer = await ask(deps, 'announcement', () => deps.channel.rawClient.docx.v1.chatAnnouncementBlock.list({
      path: { chat_id: chat }, params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    const data = answer.data as { items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string } | undefined;
    lines.push(...(data?.items ?? []).map(blockText));
    if (!data?.has_more || !data.page_token) break;
    token = data.page_token;
  }
  return cleanText(lines.filter(line => line.trim()).join('\n'));
}

/**
 * The group's name, description and announcement. The first needs an optional scope and the second a required one, so
 * each can fail alone: what could not be read is said in `notes`, and only both failing is a refusal.
 */
export async function readChat(deps: ReadDeps, request: ChatRequest): Promise<{ name?: string; description?: string; announcement?: string; cursor?: string; notes?: string[] }> {
  const chat = request.chat;
  if (!chat) throw new FeishuReadRefused(NEED_CHAT);
  const refused = (failure: unknown): FeishuReadRefused => { if (failure instanceof FeishuReadRefused) return failure; throw failure; };
  const [info, announcement] = await Promise.all([
    ask(deps, 'chat', () => deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: chat } })).catch(refused),
    announcementText(deps, chat).catch(refused),
  ]);
  if (info instanceof FeishuReadRefused && announcement instanceof FeishuReadRefused) throw info;
  const notes = [info, announcement].flatMap(part => part instanceof FeishuReadRefused ? [part.message] : []);
  const data = info instanceof FeishuReadRefused ? undefined : info.data as { name?: string; description?: string } | undefined;
  const part = typeof announcement === 'string' ? sliceText(announcement, textOffset(request.cursor)) : undefined;
  return {
    ...(data?.name ? { name: cleanText(data.name) } : {}),
    ...(data?.description ? { description: cleanText(data.description) } : {}),
    ...(part ? { announcement: part.text } : {}),
    ...(part?.next !== undefined ? { cursor: String(part.next) } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** The result's id, in the shapes it may come in: the real answer is not measured yet (no app with `search:message`). */
function searchedId(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  const found = item as { message_id?: unknown; meta_data?: { message_id?: unknown } } | null;
  const id = found?.message_id ?? found?.meta_data?.message_id;
  return typeof id === 'string' ? id : undefined;
}

/** Search answers with ids; each is read back the way `feishu_message` does, which also says whose chat it is in. */
export async function searchMessages(deps: ReadDeps, request: SearchRequest): Promise<{ messages: MessageRow[]; cursor?: string }> {
  const chat = request.only ?? request.chat;
  const answer = await ask(deps, 'search', () => deps.channel.rawClient.request<{ code?: number; data?: { items?: unknown[]; has_more?: boolean; page_token?: string } }>({
    method: 'POST', url: '/open-apis/im/v1/messages/search',
    params: { page_size: request.limit ?? 20, ...(request.cursor ? { page_token: request.cursor } : {}) },
    data: { query: request.query, ...(chat ? { filter: { chat_ids: [chat] } } : {}) },
  }));
  const me = meOf(deps.channel);
  const ids = (answer.data?.items ?? []).flatMap(item => { const id = searchedId(item); return id ? [id] : []; });
  const read = await Promise.all(ids.map(id => getMessage(deps, id, request.only).catch(failure => {
    if (failure instanceof FeishuReadRefused) return undefined; // gone since it was indexed, or another chat's
    throw failure;
  })));
  const messages = read.flatMap(found => { const row = found && messageRow(found.item, me, SEARCH_TEXT_MAX); return row ? [row] : []; });
  return { messages, ...(answer.data?.has_more && answer.data.page_token ? { cursor: answer.data.page_token } : {}) };
}
