import { cleanFileName, downloadName, prepareInboundDir, saveInboundDownload } from '../bot/media';
import { escapeInboundMarkers } from '../bot/hidden-blocks';
import { FeishuReadRefused, readOnlyReply } from './denial';
import { ask, cleanText, denialContext, jsonBytes, RESULT_BUDGET, sliceText, textOffset, type ReadDeps } from './shared';

export interface DocRequest { doc: string; cursor?: string }
export interface SheetRequest { sheet: string; range?: string; cursor?: string }
export interface DriveFileRequest { file: string; name?: string; saveIn?: string }
/** `block` is the block to insert after or to replace; `pattern` the inline text to replace. */
export interface DocEditRequest { doc: string; action: 'append' | 'insert' | 'replace'; content: string; block?: string; pattern?: string }
export interface DocEditResult { result: 'success' | 'partial_success'; updatedBlocks?: number; newBlocks?: string[]; warnings?: string[]; tips?: string; note?: string }

/** What a link says it is; a bare token says nothing. */
type RefKind = 'docx' | 'wiki' | 'sheet' | 'bitable' | 'file' | 'folder' | 'space' | 'other';
export interface DocRef { kind?: RefKind; token: string; sheetId?: string; tableId?: string; viewId?: string }
const KINDS: Record<string, RefKind> = { docx: 'docx', docs: 'other', wiki: 'wiki', sheets: 'sheet', file: 'file', base: 'bitable', bitable: 'bitable', slides: 'other', mindnotes: 'other', folder: 'folder' };

/** A Feishu link or a bare token. Only the token leaves here: nothing is fetched from what the link's host says. */
export function parseRef(ref: string): DocRef {
  const text = ref.trim();
  if (/^[\w-]+$/.test(text)) return { token: text };
  let url: URL | undefined;
  try { url = new URL(text.includes('://') ? text : `https://${text}`); } catch { /* the refusal below */ }
  const space = url && /\/wiki\/(?:space|settings)\/([\w-]+)/.exec(url.pathname);
  if (space) return { kind: 'space', token: space[1]! };
  const match = url && /\/(docx|docs|wiki|sheets|file|base|bitable|slides|mindnotes|folder)\/([\w-]+)/.exec(url.pathname);
  if (!url || !match) throw new FeishuReadRefused('认不出这个链接：给飞书文档、表格、多维表格或文件的链接，或者它的 token。');
  const sheetId = url.searchParams.get('sheet'), tableId = url.searchParams.get('table'), viewId = url.searchParams.get('view');
  return { kind: KINDS[match[1]!]!, token: match[2]!, ...(sheetId ? { sheetId } : {}), ...(tableId ? { tableId } : {}), ...(viewId ? { viewId } : {}) };
}

/** Which tool reads a node of this type, for the sentence that sends the model there. */
export function wrongKind(kind: string): FeishuReadRefused {
  const toolOf: Record<string, string> = { docx: 'feishu_doc', sheet: 'feishu_sheet', bitable: 'feishu_base', file: 'feishu_drive_file', folder: 'feishu_folder', space: 'feishu_wiki', wiki: 'feishu_wiki' };
  const tool = toolOf[kind];
  return new FeishuReadRefused(tool ? `这不是这个工具读的类型，用 ${tool}。` : `这种云文档（${kind === 'other' ? '其他类型' : kind}）现在读不了，只能读新版文档、表格、多维表格和云空间文件。`);
}

/** A knowledge-base page's real object, and where the page itself is (a shortcut's being where it points). */
export async function wikiNode(deps: ReadDeps, token: string): Promise<{ kind: string; token: string; space?: string; node?: string }> {
  const answer = await ask(deps, 'doc', () => deps.channel.rawClient.wiki.v2.space.getNode({ params: { token } }));
  const node = (answer.data as { node?: { obj_token?: string; obj_type?: string; space_id?: string; node_token?: string; origin_space_id?: string; origin_node_token?: string } } | undefined)?.node;
  if (!node?.obj_token || !node.obj_type) throw new FeishuReadRefused('找不到这个知识库页面。', 'not-found');
  const space = node.origin_space_id || node.space_id, page = node.origin_node_token || node.node_token;
  return { kind: node.obj_type, token: node.obj_token, ...(space ? { space } : {}), ...(page ? { node: page } : {}) };
}

/**
 * Read `ref` as a `want`: a knowledge-base link through its node. A bare token may be a knowledge-base page's, so when
 * it is not found as it stands it gets the node lookup too, and a token that is neither keeps the first refusal.
 */
export async function reading<T>(deps: ReadDeps, ref: DocRef, want: 'docx' | 'sheet' | 'bitable' | 'file', read: (token: string) => Promise<T>): Promise<T> {
  const fromNode = async (): Promise<T> => {
    const node = await wikiNode(deps, ref.token);
    if (node.kind !== want) throw wrongKind(node.kind);
    return read(node.token);
  };
  if (ref.kind === 'wiki') return fromNode();
  if (ref.kind === 'other') throw wrongKind('其他类型');
  if (ref.kind && ref.kind !== want) throw wrongKind(ref.kind);
  try {
    return await read(ref.token);
  } catch (failure) {
    if (ref.kind || !(failure instanceof FeishuReadRefused) || failure.kind !== 'not-found') throw failure;
    return await fromNode().catch(second => {
      throw second instanceof FeishuReadRefused && second.kind === 'not-found' ? failure : second;
    });
  }
}

/** docs_ai's text keeps the block ids an edit needs; raw_content is the fallback. Which one a cursor's offset is in is part of it. */
type DocSource = 'blocks' | 'plain';
async function docText(deps: ReadDeps, token: string, source: DocSource): Promise<string> {
  const id = encodeURIComponent(token);
  if (source === 'blocks') {
    const answer = await ask(deps, 'doc', () => deps.channel.rawClient.request<{ code?: number; data?: { document?: { content?: string } } }>({
      method: 'POST', url: `/open-apis/docs_ai/v1/documents/${id}/fetch`, data: {},
    }));
    return answer.data?.document?.content ?? '';
  }
  const answer = await ask(deps, 'doc', () => deps.channel.rawClient.request<{ code?: number; data?: { content?: string } }>({
    method: 'GET', url: `/open-apis/docx/v1/documents/${id}/raw_content`,
  }));
  return answer.data?.content ?? '';
}

function docCursor(cursor: string | undefined): { source?: DocSource; offset: number } {
  if (cursor === undefined) return { offset: 0 };
  const [source, offset] = cursor.split(':');
  if (source !== 'blocks' && source !== 'plain') throw new FeishuReadRefused('cursor 不对：用上一次结果里的 cursor，原样传回来。');
  return { source, offset: textOffset(offset) };
}

/** Any failure of docs_ai falls back: the other API may have its scope, and says more about a document it cannot read. */
async function anyDocText(deps: ReadDeps, token: string): Promise<{ source: DocSource; text: string }> {
  try {
    return { source: 'blocks', text: await docText(deps, token, 'blocks') };
  } catch (first) {
    if (!(first instanceof FeishuReadRefused)) throw first;
    try {
      return { source: 'plain', text: await docText(deps, token, 'plain') };
    } catch (second) {
      // A missing scope says more than the other API not finding what it was not allowed to look at.
      throw first.kind === 'scope' && second instanceof FeishuReadRefused && second.kind === 'not-found' ? first : second;
    }
  }
}

export async function readDoc(deps: ReadDeps, request: DocRequest): Promise<{ text: string; cursor?: string }> {
  const at = docCursor(request.cursor);
  return reading(deps, parseRef(request.doc), 'docx', async token => {
    const { source, text } = at.source ? { source: at.source, text: await docText(deps, token, at.source) } : await anyDocText(deps, token);
    const part = sliceText(cleanText(text), at.offset);
    return { text: part.text, ...(part.next !== undefined ? { cursor: `${source}:${part.next}` } : {}) };
  });
}

interface DocEditAnswer {
  code?: number;
  msg?: string;
  data?: { result?: string; warnings?: unknown; tips?: string; updated_blocks_count?: number; document?: { new_blocks?: { block_id?: string }[] } };
}

/** A change is one call of docs_ai's update (dm-agent 7.1); appending is inserting after the end, `-1`. */
function docEditBody({ action, content, block, pattern }: DocEditRequest): Record<string, unknown> {
  const common = { content, format: 'markdown', revision_id: -1 };
  if (action === 'append') {
    if (block || pattern) throw new FeishuReadRefused('append 只写 content，追加在文档末尾；要放在别处用 insert。');
    return { ...common, command: 'block_insert_after', block_id: '-1' };
  }
  if (action === 'insert') {
    if (!block || pattern) throw new FeishuReadRefused('insert 要写 block：插在哪个块后面，块的 id 在 feishu_doc 的结果里。');
    return { ...common, command: 'block_insert_after', block_id: block };
  }
  if (Boolean(block) === Boolean(pattern)) throw new FeishuReadRefused('replace 要写 pattern 或 block，只写一个：pattern 换一段行内文字，block 换整个块。');
  return block ? { ...common, command: 'block_replace', block_id: block } : { ...common, command: 'str_replace', pattern };
}

const warningsOf = (data: DocEditAnswer['data']): unknown[] => {
  const warnings = data?.warnings;
  return Array.isArray(warnings) ? warnings : warnings === undefined || warnings === null ? [] : [warnings];
};
const asText = (item: unknown): string => typeof item === 'string' ? item : JSON.stringify(item);
const WORDS_MAX = 1000;
/** Feishu's own words about a change, for the model to pass on. */
const feishuSaid = (parts: unknown[]): string => cleanText(parts.filter(Boolean).map(asText).join('；')).slice(0, WORDS_MAX);

/** Measured 2026-11-05: a Bot that can only read gets code 0, `result: 'failed'` and this among the warnings. */
const READ_ONLY_DEGRADE = /degrade_code\W{0,3}4030004/;

/** Code 0 is not a change: only `data.result` says what happened, and anything but these two did not (or is not known to have). */
function docEditResult(deps: ReadDeps, answer: DocEditAnswer): DocEditResult {
  const data = answer.data, result = data?.result, warnings = warningsOf(data);
  if (result !== 'success' && result !== 'partial_success') {
    if (warnings.some(item => READ_ONLY_DEGRADE.test(asText(item)))) throw new FeishuReadRefused(readOnlyReply(denialContext(deps).botName()));
    const words = feishuSaid([...warnings, data?.tips, answer.msg === 'success' ? undefined : answer.msg]);
    throw new FeishuReadRefused(result === 'failed' ? `飞书没有改成这篇文档：${words || '它没说原因'}。` : `飞书没有说改成了（result：${String(result)}）。${words ? `${words}。` : ''}先用 feishu_doc 读一下，再决定要不要重试。`);
  }
  const blocks = (data?.document?.new_blocks ?? []).flatMap(block => block.block_id ? [block.block_id] : []);
  return {
    result,
    ...(data?.updated_blocks_count !== undefined ? { updatedBlocks: data.updated_blocks_count } : {}),
    ...(blocks.length ? { newBlocks: blocks } : {}),
    ...(warnings.length ? { warnings: warnings.map(item => feishuSaid([item])) } : {}),
    ...(data?.tips ? { tips: feishuSaid([data.tips]) } : {}),
    ...(result === 'partial_success' ? { note: '飞书只改成了一部分。先用 feishu_doc 读一下，再决定要不要接着改。' } : {}),
  };
}

/** Longer than a read's: Feishu rewrites blocks here. */
const EDIT_CALL_MS = 30_000;

/**
 * Change a document as the Bot, through the same reference rules as a read. `beforeWrite` runs right before each PUT. No
 * answer does not mean nothing happened, and a blind retry would append twice, so that refusal says to look first.
 */
export async function editDoc(deps: ReadDeps, request: DocEditRequest, beforeWrite: () => void = () => undefined): Promise<DocEditResult> {
  const body = docEditBody(request);
  return reading(deps, parseRef(request.doc), 'docx', async token => {
    beforeWrite();
    try {
      const answer = await ask(deps, 'docEdit', () => deps.channel.rawClient.request<DocEditAnswer>({
        method: 'PUT', url: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(token)}`, data: body,
      }), EDIT_CALL_MS);
      return docEditResult(deps, answer);
    } catch (failure) {
      if (failure instanceof FeishuReadRefused && failure.kind === 'no-answer') throw new FeishuReadRefused('飞书没有回话，不知道改没改成。先用 feishu_doc 读一下，再决定要不要重试。');
      throw failure;
    }
  });
}

/** Cells as they came, with Feishu's text through the same boundary as everything else read; a base's field names are text too. */
export function cleanCell(cell: unknown): unknown {
  if (typeof cell === 'string') return escapeInboundMarkers(cell);
  if (Array.isArray(cell)) return cell.map(cleanCell);
  if (cell && typeof cell === 'object') return Object.fromEntries(Object.entries(cell).map(([key, value]) => [escapeInboundMarkers(key), cleanCell(value)]));
  return cell;
}

type SheetList = { sheets: { id?: string; title?: string; rows?: number; columns?: number }[] };
type SheetRange = { range: string; rows: unknown[]; cursor?: string };

async function sheetList(deps: ReadDeps, token: string): Promise<SheetList> {
  const id = encodeURIComponent(token);
  const list = await ask(deps, 'sheet', () => deps.channel.rawClient.request<{ code?: number; data?: { sheets?: { sheet_id?: string; title?: string; grid_properties?: { row_count?: number; column_count?: number } }[] } }>({ method: 'GET', url: `/open-apis/sheets/v3/spreadsheets/${id}/sheets/query` }));
  return {
    sheets: (list.data?.sheets ?? []).map(sheet => ({
      ...(sheet.sheet_id ? { id: sheet.sheet_id } : {}), ...(sheet.title ? { title: cleanText(sheet.title) } : {}),
      ...(sheet.grid_properties?.row_count !== undefined ? { rows: sheet.grid_properties.row_count } : {}),
      ...(sheet.grid_properties?.column_count !== undefined ? { columns: sheet.grid_properties.column_count } : {}),
    })),
  };
}

async function sheetRange(deps: ReadDeps, token: string, range: string, cursor: string | undefined): Promise<SheetRange> {
  const answer = await ask(deps, 'sheet', () => deps.channel.rawClient.request<{ code?: number; data?: { valueRange?: { range?: string; values?: unknown[] } } }>({
    method: 'GET', url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeURIComponent(range)}`,
    params: { valueRenderOption: 'ToString', dateTimeRenderOption: 'FormattedString' },
  }));
  const values = answer.data?.valueRange?.values ?? [];
  const from = textOffset(cursor);
  const rows: unknown[] = [];
  let used = 0;
  for (const [index, row] of values.entries()) {
    if (index < from) continue;
    const clean = cleanCell(row);
    used += jsonBytes(clean);
    if (used > RESULT_BUDGET) {
      if (!rows.length) throw new FeishuReadRefused('这一行太大，一次读不完。把 range 的列缩小一些。');
      return { range: answer.data?.valueRange?.range ?? range, rows, cursor: String(index) };
    }
    rows.push(clean);
  }
  return { range: answer.data?.valueRange?.range ?? range, rows };
}

/** Without a range (and none in the link): the spreadsheet's sheets, to pick one. */
export async function readSheet(deps: ReadDeps, request: SheetRequest): Promise<SheetList | SheetRange> {
  const ref = parseRef(request.sheet);
  const range = request.range ?? ref.sheetId;
  return reading<SheetList | SheetRange>(deps, ref, 'sheet', token => range ? sheetRange(deps, token, range, request.cursor) : sheetList(deps, token));
}

export async function readDriveFile(deps: ReadDeps, request: DriveFileRequest): Promise<{ path: string; name: string }> {
  return reading(deps, parseRef(request.file), 'file', async token => {
    const res = await ask(deps, 'drive', () => deps.channel.rawClient.drive.v1.file.download({ path: { file_token: token } }), 60_000);
    return saveDownload(res, token, request);
  });
}

/** A download into the folder received attachments go to, under their size limit; a comment's session has none of its own. */
export async function saveDownload(res: Parameters<typeof saveInboundDownload>[0], token: string, request: { name?: string; saveIn?: string }): Promise<{ path: string; name: string }> {
  const name = cleanFileName(request.name ?? downloadName(res.headers)) || 'file';
  await prepareInboundDir(request.saveIn);
  const saved = await saveInboundDownload(res, token, name, request.saveIn);
  if ('reason' in saved) throw new FeishuReadRefused(`没下载成：${saved.reason}。`);
  return { path: saved.path, name: saved.name };
}
