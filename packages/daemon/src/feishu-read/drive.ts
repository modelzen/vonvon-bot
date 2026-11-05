import { resolveNames, withDeadline } from '../bot/names';
import { formatAt, hostTimeZone } from '../bot/schedule/time';
import { pageOf, type BasePage, type PageRequest } from './base';
import { FeishuReadRefused, type ReadArea } from './denial';
import { parseRef, saveDownload, wikiNode, wrongKind, type DocRef } from './documents';
import { ask, type ReadDeps } from './shared';

export interface FolderRequest extends PageRequest { folder?: string }
export interface WikiRequest extends PageRequest { wiki?: string }
export type CommentFileType = 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'bitable';
export interface CommentsRequest extends PageRequest { doc: string; type?: CommentFileType; comment?: string; solved?: boolean }
export interface DocMediaRequest { token: string; name?: string; saveIn?: string }

/** Feishu's list answers: `drive/v1/files` says `files` and `next_page_token`, the others `items` and `page_token`. */
interface Listed<T> { code?: number; data?: { items?: T[]; files?: T[]; has_more?: boolean; page_token?: string; next_page_token?: string } }

const DRIVE_PAGE = 100, COMMENT_PAGE = 100;
/** The most `wiki/v2` takes. */
const WIKI_PAGE = 50;
const NAMES_MS = 5000;

/** One Feishu page of a list, each row shaped here so a page's budget counts what the result will carry. */
function listed<T>(deps: ReadDeps, area: ReadArea, request: PageRequest, url: string, params: Record<string, string | boolean>, size: number, shape: (items: T[]) => unknown[] | Promise<unknown[]>, tooBig: string): Promise<BasePage> {
  return pageOf(request, async pageToken => {
    const answer = await ask(deps, area, () => deps.channel.rawClient.request<Listed<T>>({ method: 'GET', url, params: { ...params, page_size: size, ...(pageToken ? { page_token: pageToken } : {}) } }));
    const data = answer.data;
    return { data: { items: await shape(data?.items ?? data?.files ?? []), ...(data?.has_more ? { has_more: true } : {}), ...(data?.page_token || data?.next_page_token ? { page_token: data.page_token || data.next_page_token } : {}) } };
  }, tooBig);
}

/** Feishu's times here are seconds, some as strings. */
function timeOf(seconds: string | number | undefined): string | undefined {
  const value = Number(seconds);
  if (!value) return undefined;
  const zone = hostTimeZone();
  return formatAt(value * 1000, zone, zone);
}

interface FolderFile { name?: string; type?: string; token?: string; url?: string; modified_time?: string; owner_id?: string; shortcut_info?: { target_type?: string; target_token?: string } }
const fileRow = ({ name, type, token, url, modified_time: modified, owner_id: owner, shortcut_info: shortcut }: FolderFile) => ({ name, type, token, url, modified: timeOf(modified), owner,
  ...(shortcut?.target_token ? { shortcutTo: { type: shortcut.target_type, token: shortcut.target_token } } : {}) });

/** A folder's contents; without a folder the Bot's own root, which Feishu answers whole, so a cursor there only skips. */
export async function readFolder(deps: ReadDeps, request: FolderRequest): Promise<BasePage> {
  const ref = request.folder ? parseRef(request.folder) : undefined;
  if (ref?.kind && ref.kind !== 'folder') throw wrongKind(ref.kind);
  return listed<FolderFile>(deps, 'folder', request, '/open-apis/drive/v1/files', ref ? { folder_token: ref.token } : {}, DRIVE_PAGE, items => items.map(fileRow), '这一条太大，一次读不完。');
}

interface WikiSpace { space_id?: string; name?: string; description?: string; space_type?: string; visibility?: string }
const spaceRow = ({ space_id: id, name, description, space_type: type, visibility }: WikiSpace) => ({ id, name, description, type, visibility });
interface WikiPage { title?: string; node_token?: string; obj_token?: string; obj_type?: string; node_type?: string; has_child?: boolean; obj_edit_time?: string; url?: string; origin_node_token?: string }
const pageRow = ({ title, node_token: token, obj_token: objToken, obj_type: type, node_type: nodeType, has_child: hasChildren, obj_edit_time: edited, url, origin_node_token: shortcutTo }: WikiPage) => ({
  title, token, objToken, type, hasChildren, edited: timeOf(edited), url, ...(nodeType === 'shortcut' && shortcutTo ? { shortcutTo } : {}) });

/** A knowledge base's id is all digits, a page's token never is; a page's link or token says which base it is in. */
async function wikiPlace(deps: ReadDeps, wiki: string): Promise<{ space: string; node?: string }> {
  if (/^\d+$/.test(wiki.trim())) return { space: wiki.trim() };
  const ref = parseRef(wiki);
  if (ref.kind === 'space') return { space: ref.token };
  if (ref.kind && ref.kind !== 'wiki') throw wrongKind(ref.kind);
  const { space, node } = await wikiNode(deps, ref.token);
  if (!space) throw new FeishuReadRefused('找不到这个知识库页面。', 'not-found');
  return { space, node: node ?? ref.token };
}

/** The knowledge bases the Bot can see, or the pages under a base or a page. */
export async function readWiki(deps: ReadDeps, request: WikiRequest): Promise<BasePage> {
  const tooBig = '这一条太大，一次读不完。';
  if (!request.wiki) return listed<WikiSpace>(deps, 'wiki', request, '/open-apis/wiki/v2/spaces', {}, WIKI_PAGE, items => items.map(spaceRow), tooBig);
  const { space, node } = await wikiPlace(deps, request.wiki);
  return listed<WikiPage>(deps, 'wiki', request, `/open-apis/wiki/v2/spaces/${encodeURIComponent(space)}/nodes`, node ? { parent_node_token: node } : {}, WIKI_PAGE, items => items.map(pageRow), tooBig);
}

interface ReplyElement { type?: string; text_run?: { text?: string }; docs_link?: { url?: string }; person?: { user_id?: string } }
interface CommentReply { reply_id?: string; user_id?: string; create_time?: number; content?: { elements?: ReplyElement[] }; extra?: { image_list?: string[] } }
interface DocComment { comment_id?: string; user_id?: string; create_time?: number; quote?: string; is_whole?: boolean; is_solved?: boolean; has_more?: boolean; reply_list?: { replies?: CommentReply[] } }

type Names = ReadonlyMap<string, string>;
const peopleOf = (reply: CommentReply): (string | undefined)[] => [reply.user_id, ...(reply.content?.elements ?? []).map(element => element.person?.user_id)];
/** Without the optional contact scope, or in time, a person stays their open_id. */
const namesOf = async (deps: ReadDeps, ids: (string | undefined)[]): Promise<Names> => await withDeadline(resolveNames(deps.channel, ids), NAMES_MS, 'feishu-read-comment-names') ?? new Map<string, string>();

function replyText(elements: ReplyElement[], names: Names): string {
  return elements.map(element => {
    if (element.type === 'text_run') return element.text_run?.text ?? '';
    if (element.type === 'docs_link') return element.docs_link?.url ?? '';
    const person = element.type === 'person' ? element.person?.user_id : undefined;
    return person ? `@${names.get(person) ?? person}` : '';
  }).join('').trim();
}

const replyRow = (reply: CommentReply, names: Names) => {
  const senderId = reply.user_id, images = reply.extra?.image_list ?? [];
  return { id: reply.reply_id, sender: senderId ? names.get(senderId) ?? senderId : undefined, senderId, time: timeOf(reply.create_time),
    text: replyText(reply.content?.elements ?? [], names), ...(images.length ? { images } : {}) };
};
/** A card: Feishu's first reply is the comment itself. */
const commentRow = (comment: DocComment, names: Names) => ({ id: comment.comment_id, ...(comment.quote ? { quote: comment.quote } : {}), whole: Boolean(comment.is_whole), solved: Boolean(comment.is_solved),
  replies: (comment.reply_list?.replies ?? []).map(reply => replyRow(reply, names)), ...(comment.has_more ? { moreReplies: true } : {}) });

const COMMENT_TOO_BIG = '这一条评论太大，一次读不完。用 comment 只读这条的回复。';
const COMMENT_TYPES: ReadonlySet<string> = new Set<CommentFileType>(['doc', 'docx', 'sheet', 'file', 'slides', 'bitable']);
/** Links `parseRef` leaves as `other` that do have comments; a mind note has none. */
const typeOfLink = (ref: DocRef, link: string): string | undefined => {
  if (ref.kind !== 'other') return ref.kind && COMMENT_TYPES.has(ref.kind) ? ref.kind : undefined;
  return /\/docs\//.test(link) ? 'doc' : /\/slides\//.test(link) ? 'slides' : undefined;
};

/** A document's comments, or one comment's replies. `type` is what a bare token is; a link and a knowledge-base page say. */
export async function readComments(deps: ReadDeps, request: CommentsRequest): Promise<BasePage> {
  if (request.comment && request.solved !== undefined) throw new FeishuReadRefused('solved 只用于列评论，读一条评论的回复时不写。');
  const ref = parseRef(request.doc);
  const list = (type: string, token: string): Promise<BasePage> => {
    const url = `/open-apis/drive/v1/files/${encodeURIComponent(token)}/comments`;
    const params = { file_type: type, user_id_type: 'open_id' };
    if (request.comment) return listed<CommentReply>(deps, 'comments', request, `${url}/${encodeURIComponent(request.comment)}/replies`, params, COMMENT_PAGE, async items => {
      const names = await namesOf(deps, items.flatMap(peopleOf));
      return items.map(reply => replyRow(reply, names));
    }, '这一条回复太大，一次读不完。');
    return listed<DocComment>(deps, 'comments', request, url, { ...params, ...(request.solved !== undefined ? { is_solved: request.solved } : {}) }, COMMENT_PAGE, async items => {
      const names = await namesOf(deps, items.flatMap(comment => (comment.reply_list?.replies ?? []).flatMap(peopleOf)));
      return items.map(comment => commentRow(comment, names));
    }, COMMENT_TOO_BIG);
  };
  const fromNode = async (): Promise<BasePage> => {
    const node = await wikiNode(deps, ref.token);
    if (!COMMENT_TYPES.has(node.kind)) throw new FeishuReadRefused(`这种云文档（${node.kind}）没有评论可读。`);
    return list(node.kind, node.token);
  };
  if (ref.kind === 'wiki') return fromNode();
  if (ref.kind) {
    const type = typeOfLink(ref, request.doc);
    if (!type) throw new FeishuReadRefused('这个链接没有评论可读：给文档、表格、多维表格、幻灯片、云空间文件或知识库页面。');
    return list(type, ref.token);
  }
  if (request.type) return list(request.type, ref.token);
  try {
    return await list('docx', ref.token);
  } catch (failure) {
    if (!(failure instanceof FeishuReadRefused) || failure.kind !== 'not-found') throw failure;
    return await fromNode().catch(second => {
      throw second instanceof FeishuReadRefused && second.kind === 'not-found' ? failure : second;
    });
  }
}

/** A picture or attachment of a document, by the token `feishu_doc` shows; the document's own link gets it nowhere. */
export async function readDocMedia(deps: ReadDeps, request: DocMediaRequest): Promise<{ path: string; name: string }> {
  const { kind, token } = parseRef(request.token);
  if (kind) throw new FeishuReadRefused('这里要图片或附件的 token，不是链接：用 feishu_doc 读文档，token 在结果的 <img src="…"> 和 <source token="…"> 里。');
  const res = await ask(deps, 'docMedia', () => deps.channel.rawClient.drive.v1.media.download({ path: { file_token: token } }), 60_000);
  return saveDownload(res, token, request);
}
