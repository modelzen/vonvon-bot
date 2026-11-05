import { cleanFileName, downloadName, prepareInboundDir, saveInboundDownload } from '../bot/media';
import { escapeInboundMarkers } from '../bot/hidden-blocks';
import { FeishuReadRefused } from './denial';
import { ask, cleanText, jsonBytes, RESULT_BUDGET, sliceText, textOffset, type ReadDeps } from './shared';

export interface DocRequest { doc: string; cursor?: string }
export interface SheetRequest { sheet: string; range?: string; cursor?: string }
export interface DriveFileRequest { file: string; name?: string }

/** What a link says it is; a bare token says nothing. */
type RefKind = 'docx' | 'wiki' | 'sheet' | 'file' | 'other';
export interface DocRef { kind?: RefKind; token: string; sheetId?: string }
const KINDS: Record<string, RefKind> = { docx: 'docx', docs: 'other', wiki: 'wiki', sheets: 'sheet', file: 'file', base: 'other', bitable: 'other', slides: 'other', mindnotes: 'other' };

/** A Feishu link or a bare token. Only the token leaves here: nothing is fetched from what the link's host says. */
export function parseRef(ref: string): DocRef {
  const text = ref.trim();
  if (/^[\w-]+$/.test(text)) return { token: text };
  let url: URL | undefined;
  try { url = new URL(text.includes('://') ? text : `https://${text}`); } catch { /* the refusal below */ }
  const match = url && /\/(docx|docs|wiki|sheets|file|base|bitable|slides|mindnotes)\/([\w-]+)/.exec(url.pathname);
  if (!url || !match) throw new FeishuReadRefused('认不出这个链接：给飞书文档、表格或文件的链接，或者它的 token。');
  const sheetId = url.searchParams.get('sheet');
  return { kind: KINDS[match[1]!]!, token: match[2]!, ...(sheetId ? { sheetId } : {}) };
}

/** Which tool reads a node of this type, for the sentence that sends the model there. */
function wrongKind(kind: string): FeishuReadRefused {
  const toolOf: Record<string, string> = { docx: 'feishu_doc', sheet: 'feishu_sheet', file: 'feishu_drive_file' };
  const tool = toolOf[kind];
  return new FeishuReadRefused(tool ? `这不是这个工具读的类型，用 ${tool}。` : `这种云文档（${kind}）现在读不了，只能读新版文档、表格和云空间文件。`);
}

/** A knowledge-base page's real object. */
async function wikiNode(deps: ReadDeps, token: string): Promise<{ kind: string; token: string }> {
  const answer = await ask(deps, 'doc', () => deps.channel.rawClient.wiki.v2.space.getNode({ params: { token } }));
  const node = (answer.data as { node?: { obj_token?: string; obj_type?: string } } | undefined)?.node;
  if (!node?.obj_token || !node.obj_type) throw new FeishuReadRefused('找不到这个知识库页面。', 'not-found');
  return { kind: node.obj_type, token: node.obj_token };
}

/**
 * Read `ref` as a `want`: a knowledge-base link through its node. A bare token may be a knowledge-base page's, so when
 * it is not found as it stands it gets the node lookup too, and a token that is neither keeps the first refusal.
 */
async function reading<T>(deps: ReadDeps, ref: DocRef, want: 'docx' | 'sheet' | 'file', read: (token: string) => Promise<T>): Promise<T> {
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

/** Cells as they came, with Feishu's text through the same boundary as everything else read. */
function cleanCell(cell: unknown): unknown {
  if (typeof cell === 'string') return escapeInboundMarkers(cell);
  if (Array.isArray(cell)) return cell.map(cleanCell);
  if (cell && typeof cell === 'object') return Object.fromEntries(Object.entries(cell).map(([key, value]) => [key, cleanCell(value)]));
  return cell;
}

type SheetList = { title?: string; sheets: { id?: string; title?: string; rows?: number; columns?: number }[] };
type SheetRange = { range: string; rows: unknown[]; cursor?: string };

async function sheetList(deps: ReadDeps, token: string): Promise<SheetList> {
  const id = encodeURIComponent(token);
  const [meta, list] = await Promise.all([
    ask(deps, 'sheet', () => deps.channel.rawClient.request<{ code?: number; data?: { spreadsheet?: { title?: string } } }>({ method: 'GET', url: `/open-apis/sheets/v3/spreadsheets/${id}` })),
    ask(deps, 'sheet', () => deps.channel.rawClient.request<{ code?: number; data?: { sheets?: { sheet_id?: string; title?: string; grid_properties?: { row_count?: number; column_count?: number } }[] } }>({ method: 'GET', url: `/open-apis/sheets/v3/spreadsheets/${id}/sheets/query` })),
  ]);
  const title = meta.data?.spreadsheet?.title;
  return {
    ...(title ? { title: cleanText(title) } : {}),
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
    const name = cleanFileName(request.name ?? downloadName(res.headers)) || 'file';
    await prepareInboundDir();
    const saved = await saveInboundDownload(res, token, name);
    if ('reason' in saved) throw new FeishuReadRefused(`没下载成：${saved.reason}。`);
    return { path: saved.path, name: saved.name };
  });
}
