import type { TenantBrand } from '../config/schema';
import { BITABLE_READ_SCOPES, buildScopeGrantUrl, COMMENT_READ_SCOPES, DOC_EDIT_SCOPES, DOC_MEDIA_SCOPES, DOC_READ_SCOPES, DRIVE_LIST_SCOPES, DRIVE_READ_SCOPES, labelScope, MESSAGE_SEARCH_SCOPES, SHEET_READ_SCOPES, WIKI_READ_SCOPES } from '../config/scopes';
import { log } from '../core/logger';
import { withDeadline } from '../bot/names';
import { feishuError, scopeDenial } from '../utils/feishu-error';

/**
 * Why a read did not happen, in the sentences the model passes on (dm-agent 7.5): the app lacks a scope, the document
 * is not shared with the Bot, or Feishu said something else. A bad id is never read as a missing permission.
 */

/** What a read touches: the scopes it needs and what is lost without them. */
export type ReadArea = 'history' | 'resource' | 'chat' | 'announcement' | 'doc' | 'docEdit' | 'sheet' | 'base' | 'drive' | 'folder' | 'wiki' | 'comments' | 'docMedia' | 'search';
const AREAS: Record<ReadArea, { scopes: readonly string[]; effect: string }> = {
  history: { scopes: ['im:message:readonly'], effect: '读不了群里的消息' },
  resource: { scopes: ['im:resource'], effect: '下载不了消息里的图片和文件' },
  chat: { scopes: ['im:chat:readonly'], effect: '读不了群名和群描述' },
  announcement: { scopes: ['im:chat.announcement:read'], effect: '读不了群公告' },
  doc: { scopes: DOC_READ_SCOPES, effect: '读不了文档和知识库' },
  docEdit: { scopes: DOC_EDIT_SCOPES, effect: '改不了文档' },
  sheet: { scopes: SHEET_READ_SCOPES, effect: '读不了表格' },
  base: { scopes: BITABLE_READ_SCOPES, effect: '读不了多维表格' },
  drive: { scopes: DRIVE_READ_SCOPES, effect: '下载不了云空间文件' },
  folder: { scopes: DRIVE_LIST_SCOPES, effect: '看不了云空间文件夹里有什么' },
  wiki: { scopes: WIKI_READ_SCOPES, effect: '看不了知识库和它的目录' },
  comments: { scopes: COMMENT_READ_SCOPES, effect: '读不了文档评论' },
  docMedia: { scopes: DOC_MEDIA_SCOPES, effect: '下载不了文档里的图片和附件' },
  search: { scopes: MESSAGE_SEARCH_SCOPES, effect: '搜不了消息' },
};
/** The sentence that closes a missing-scope reply: an administrator of vonvon may not reach the Feishu console (7.5). */
export const AFTER_GRANT = '开通后要发布新版本才生效；打不开这个链接，就转给这个飞书应用的管理员。';

/** Feishu's "no access to this object". Measured for a document not shared with a bot: 3380004 (docs_ai), 1770032 (raw_content), 91403 (bitable), 1069303 (comments); the rest from its docs. */
const NOT_SHARED_CODES: ReadonlySet<number> = new Set([3380004, 1770032, 1310213, 1061004, 1069303, 1069902, 131006, 91403]);
/** Measured for a made-up id (3380002, 99992402, 1770001, 131005, 91402, 1061002 for a folder, 1069307 for comments), the rest from the same docs. */
const NOT_FOUND_CODES: ReadonlySet<number> = new Set([3380002, 99992402, 1770001, 1770002, 1310214, 1061002, 1061003, 1061007, 1069307, 131005, 91402, 230001, 230110]);
/** The Bot is not in that chat (230002), or the chat has left it (232011). */
const OUT_OF_CHAT_CODES: ReadonlySet<number> = new Set([230002, 232011]);

/** `no-answer`: Feishu's answer never came, so what was asked may still have happened. `not-in-chat`: the Bot is not in that group. */
export const REFUSAL_KINDS = ['scope', 'not-shared', 'not-in-chat', 'not-found', 'no-answer', 'other'] as const;
export type RefusalKind = typeof REFUSAL_KINDS[number];
/** A read refused, with the sentence for the model. It crosses to another Bot's process as its message and kind (F2). */
export class FeishuReadRefused extends Error {
  constructor(message: string, readonly kind: RefusalKind = 'other') { super(message); }
}

export interface DenialContext {
  app: { id: string; tenant: TenantBrand };
  botName(): string;
}

const shared = (bot: string, grant: string): string => `在文档右上角的分享里搜「${bot}」，给${grant}权限。`;
/** `grant`: what the Bot needs for what it was asked, 编辑 for a change, so nobody has to share twice. */
export const notSharedReply = (bot: string, grant = '阅读'): string => `这篇文档还没分享给 Bot。${shared(bot, grant)}`;
/** Where it is shared from is not a document's right-hand corner for these. */
const NOT_SHARED_PLACES: Partial<Record<ReadArea, (bot: string) => string>> = {
  folder: bot => `这个文件夹还没分享给 Bot。在文件夹右上角的分享里搜「${bot}」，给阅读权限。`,
  wiki: bot => `这个知识库还没对 Bot 开放。把「${bot}」所在的群加为知识库成员，或者把要读的页面分享给它。`,
};
/** The Bot can read but was asked to change it. */
export const readOnlyReply = (bot: string): string => `Bot 对这篇文档只有阅读权限。${shared(bot, '编辑')}`;

/**
 * The scopes the link preselects: this area's whole group when Feishu names one of them or nothing (one click covers
 * the fallback API too), else the first Feishu says would do.
 */
function scopesToGrant(area: ReadArea, accepted: readonly string[]): readonly string[] {
  const { scopes } = AREAS[area];
  return !accepted.length || accepted.some(scope => scopes.includes(scope)) ? scopes : accepted.slice(0, 1);
}

export function scopeReply(context: DenialContext, area: ReadArea, accepted: readonly string[]): string {
  const scopes = scopesToGrant(area, accepted);
  const url = buildScopeGrantUrl(context.app.id, context.app.tenant, scopes);
  // By its name: read through another Bot (7.3), "this Bot" would be the one the session is on.
  return `Bot「${context.botName()}」的飞书应用缺权限：${scopes.map(labelScope).join('、')}，所以${AREAS[area].effect}。开通链接：${url} ${AFTER_GRANT}`;
}

/** A failed call as a refusal: `failure` is what the SDK threw, or a body with a non-zero code. */
export function refusalOf(context: DenialContext, area: ReadArea, failure: unknown): FeishuReadRefused {
  const denial = scopeDenial(failure);
  if (denial) return new FeishuReadRefused(scopeReply(context, area, denial.accepted), 'scope');
  const error = feishuError(failure);
  const editing = area === 'docEdit';
  if (error && NOT_SHARED_CODES.has(error.code)) return new FeishuReadRefused(NOT_SHARED_PLACES[area]?.(context.botName()) ?? notSharedReply(context.botName(), editing ? '编辑' : '阅读'), 'not-shared');
  if (error && OUT_OF_CHAT_CODES.has(error.code)) return new FeishuReadRefused(`「${context.botName()}」不在这个群里，读不到。`, 'not-in-chat');
  // A download's 404 has no Feishu body to read.
  const gone = !error && (failure as { response?: { status?: number } } | null)?.response?.status === 404;
  if (gone || error && NOT_FOUND_CODES.has(error.code)) {
    const what = area === 'folder' ? '这个文件夹，看看链接和 token 对不对' : area === 'wiki' ? '这个知识库或页面，看看链接和 id 对不对'
      : area === 'doc' || editing || area === 'sheet' || area === 'base' || area === 'drive' || area === 'comments' || area === 'docMedia' ? '这个文档或文件，看看链接和 token 对不对' : '这条内容，看看 id 对不对';
    return new FeishuReadRefused(`找不到${what}${error ? `（飞书错误码 ${error.code}）` : ''}。`, 'not-found');
  }
  if (error) return new FeishuReadRefused(`飞书拒绝了这次${editing ? '修改' : '读取'}（错误码 ${error.code}${error.msg ? `：${error.msg}` : ''}）。`);
  log.warn('feishu-read', 'read-failed', { area, err: String(failure) });
  return new FeishuReadRefused('没连上飞书，稍后再试。', 'no-answer');
}

/** Most of an error body a download's stream is read for. */
const BODY_MAX = 64 * 1024;
async function streamText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk as Uint8Array);
    chunks.push(part);
    size += part.length;
    if (size > BODY_MAX) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A download asks for a stream, so a refused one carries its `{code, msg}` body as a stream too, and
 * {@link feishuError} would see no code. The body read back; `failure` itself when there is none or it is not JSON.
 */
export async function readableFailure(failure: unknown): Promise<unknown> {
  const data = (failure as { response?: { data?: unknown } } | null)?.response?.data as AsyncIterable<unknown> | undefined;
  if (typeof data?.[Symbol.asyncIterator] !== 'function') return failure;
  try {
    const text = await withDeadline(streamText(data), 3000, 'feishu-read-error-body');
    return text ? JSON.parse(text) as unknown : failure;
  } catch {
    return failure;
  }
}
