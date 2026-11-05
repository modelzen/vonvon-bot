import { cleanCell, parseRef, reading } from './documents';
import { ask, cleanText, sliceText, textOffset, type ReadDeps } from './shared';

export interface SlidesRequest { slides: string; cursor?: string }
export interface MindnoteRequest { mindnote: string; cursor?: string }
export interface BoardRequest { board: string; cursor?: string }
export interface MinutesRequest { minutes: string; cursor?: string }
export interface TextPage { text: string; cursor?: string }

/** The part of a text from a cursor, through the same boundary as everything else read. */
function pageOf(text: string, from: number): TextPage {
  const part = sliceText(cleanText(text), from);
  return { text: part.text, ...(part.next !== undefined ? { cursor: String(part.next) } : {}) };
}

/**
 * Nodes in reading order with their depth. A node whose parent is not there starts at the top, and so does one in a
 * loop, so nothing Feishu sends is lost. A stack, not recursion: how deep a tree goes is up to whoever drew it.
 */
function inTreeOrder<Node>(nodes: readonly Node[], idOf: (node: Node) => string | undefined, parentOf: (node: Node) => string | undefined): { node: Node; depth: number }[] {
  const ids = new Set(nodes.map(idOf));
  const under = new Map<string, Node[]>();
  for (const node of nodes) {
    const parent = parentOf(node);
    if (!parent || !ids.has(parent)) continue;
    const siblings = under.get(parent);
    if (siblings) siblings.push(node);
    else under.set(parent, [node]);
  }
  const seen = new Set<Node>();
  const ordered: { node: Node; depth: number }[] = [];
  const walk = (first: Node) => {
    const stack = [{ node: first, depth: 0 }];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next.node)) continue;
      seen.add(next.node);
      ordered.push(next);
      const id = idOf(next.node);
      stack.push(...(id ? under.get(id) ?? [] : []).map(node => ({ node, depth: next.depth + 1 })).reverse());
    }
  };
  for (const node of nodes) {
    const parent = parentOf(node);
    if (!parent || !ids.has(parent)) walk(node);
  }
  for (const node of nodes) walk(node);
  return ordered;
}

/** Deeper than anyone reads, and a tree a thousand deep must not make the text a thousand times longer. */
const INDENT_MAX = 32;
const indent = (depth: number): string => '  '.repeat(Math.min(depth, INDENT_MAX));
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();

/** A deck as Feishu's XML, ids and all: that is its whole text, and a private chat's generic tool edits by those ids. */
export async function readSlides(deps: ReadDeps, request: SlidesRequest): Promise<TextPage> {
  const from = textOffset(request.cursor);
  return reading(deps, parseRef(request.slides), 'slides', async token => {
    const answer = await ask(deps, 'slides', () => deps.channel.rawClient.request<{ code?: number; data?: { xml_presentation?: { content?: string } } }>({
      method: 'GET', url: `/open-apis/slides_ai/v1/xml_presentations/${encodeURIComponent(token)}`,
    }));
    return pageOf(answer.data?.xml_presentation?.content ?? '', from);
  });
}

interface MindnoteElement {
  text?: { content?: string };
  link?: { text?: string; url?: string };
  mention_user?: { name?: string; user_id?: string };
  mention_doc?: { title?: string; url?: string };
}
interface MindnoteNode { node_id?: string; parent_id?: string; texts?: MindnoteElement[]; notes?: MindnoteElement[]; images?: { token?: string }[]; finish?: boolean }

/** lark-cli's schema gives only an element's `text.content`; the rest has no shape on paper, so what it holds is tried in turn. */
const elementText = ({ text, link, mention_user: user, mention_doc: doc }: MindnoteElement): string =>
  text?.content ?? link?.text ?? link?.url ?? user?.name ?? user?.user_id ?? doc?.title ?? doc?.url ?? '';
const elementsText = (elements: MindnoteElement[] | undefined): string => oneLine((elements ?? []).map(elementText).join(''));

function mindnoteText(nodes: readonly MindnoteNode[]): string {
  return inTreeOrder(nodes, node => node.node_id, node => node.parent_id).flatMap(({ node, depth }) => [
    `${indent(depth)}- ${node.finish ? '[已完成] ' : ''}${elementsText(node.texts)}`,
    ...elementsText(node.notes) ? [`${indent(depth + 1)}备注：${elementsText(node.notes)}`] : [],
    ...(node.images ?? []).flatMap(image => image.token ? [`${indent(depth + 1)}[图片 ${image.token}]`] : []),
  ]).join('\n');
}

/** Feishu has no paging here: one answer holds every node, so the cursor is an offset into the text made of them. */
export async function readMindnote(deps: ReadDeps, request: MindnoteRequest): Promise<TextPage> {
  const from = textOffset(request.cursor);
  return reading(deps, parseRef(request.mindnote), 'mindnote', async token => {
    const answer = await ask(deps, 'mindnote', () => deps.channel.rawClient.request<{ code?: number; data?: { nodes?: MindnoteNode[] } }>({
      method: 'GET', url: `/open-apis/mindnote/v1/mindnotes/${encodeURIComponent(token)}/nodes`,
    }));
    return pageOf(mindnoteText(answer.data?.nodes ?? []), from);
  });
}

interface BoardEnd { attached_object?: { id?: string } }
interface BoardNode {
  id?: string;
  type?: string;
  parent_id?: string;
  x?: number;
  y?: number;
  text?: { text?: string };
  image?: { token?: string };
  section?: { title?: string };
  sticky_note?: object;
  syntax?: { code?: string };
  table?: { title?: string; cells?: { row_index?: number; col_index?: number; text?: { text?: string } }[] };
  mind_map_node?: { parent_id?: string };
  connector?: { start?: BoardEnd; end?: BoardEnd; start_object?: { id?: string }; end_object?: { id?: string }; captions?: { data?: { text?: string }[] } };
}

function tableLines({ title, cells = [] }: NonNullable<BoardNode['table']>): string[] {
  const rows = new Map<number, string[]>();
  for (const { row_index: row = 0, col_index: column = 0, text } of cells) {
    const cellsOfRow = rows.get(row) ?? [];
    cellsOfRow[column] = oneLine(text?.text ?? '');
    rows.set(row, cellsOfRow);
  }
  const body = [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => Array.from(row, cell => cell ?? '').join(' | '));
  return [`[表格]${title ? ` ${oneLine(title)}` : ''}`, ...body];
}

/** What a node says, line by line; nothing for one that only draws (a bare shape, a group, a stroke). */
function boardLines(node: BoardNode): string[] {
  const words = oneLine(node.text?.text ?? '');
  if (node.table) return tableLines(node.table);
  if (node.section) return [`[分区] ${oneLine(node.section.title ?? words)}`];
  if (node.image?.token) return [`[图片 ${node.image.token}]${words ? ` ${words}` : ''}`];
  if (node.syntax?.code) return [node.syntax.code];
  if (!words) return [];
  return [node.sticky_note || node.type === 'sticky_note' ? `[便签] ${words}` : words];
}

function connectorLine(node: BoardNode, named: ReadonlyMap<string, string>): string | undefined {
  const line = node.connector;
  if (!line) return undefined;
  const nameOf = (id: string | undefined) => (id && named.get(id)) || '（没有文字的节点）';
  const start = line.start?.attached_object?.id ?? line.start_object?.id, end = line.end?.attached_object?.id ?? line.end_object?.id;
  const caption = oneLine((line.captions?.data ?? []).map(item => item.text ?? '').join(' '));
  if (!start && !end && !caption) return undefined;
  return `${nameOf(start)} → ${nameOf(end)}${caption ? `：${caption}` : ''}`;
}

function boardText(nodes: readonly BoardNode[]): string {
  const shapes = nodes.filter(node => !node.connector);
  const named = new Map(shapes.flatMap(node => node.id ? [[node.id, oneLine(boardLines(node).join(' '))] as const] : []));
  // Feishu's list has no reading order, so a board reads top to bottom, then left to right.
  const placed = [...shapes].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  const lines = inTreeOrder(placed, node => node.id, node => node.parent_id || node.mind_map_node?.parent_id)
    .flatMap(({ node, depth }) => boardLines(node).map(line => `${indent(depth)}${line}`));
  const connections = nodes.flatMap(node => connectorLine(node, named) ?? []);
  return [...lines, ...connections.length ? ['', '连线：', ...connections] : []].join('\n');
}

export async function readBoard(deps: ReadDeps, request: BoardRequest): Promise<TextPage> {
  const from = textOffset(request.cursor);
  return reading(deps, parseRef(request.board), 'board', async token => {
    const answer = await ask(deps, 'board', () => deps.channel.rawClient.request<{ code?: number; data?: { nodes?: BoardNode[] } }>({
      method: 'GET', url: `/open-apis/board/v1/whiteboards/${encodeURIComponent(token)}/nodes`,
    }));
    return pageOf(boardText(answer.data?.nodes ?? []), from);
  });
}

/** Most of a transcript kept: several days of talk. A body without end must not fill the Bot's memory. */
const TRANSCRIPT_MAX = 16 * 1024 * 1024;
/** A transcript is a download: the stream is read inside the same call, so this covers both. */
const TRANSCRIPT_MS = 60_000;
const CUT_SHORT = '\n…（文字记录太长，后面的没有读）';

async function streamed(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk as Uint8Array);
    chunks.push(part);
    size += part.length;
    if (size > TRANSCRIPT_MAX) return `${Buffer.concat(chunks).subarray(0, TRANSCRIPT_MAX).toString('utf8')}${CUT_SHORT}`;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The details come with the first part only: a cursor is for the rest of the transcript. Each part fetches the whole transcript again, since Feishu has no paging for it. */
export async function readMinutes(deps: ReadDeps, request: MinutesRequest): Promise<TextPage & { minute?: unknown }> {
  const from = textOffset(request.cursor);
  return reading(deps, parseRef(request.minutes), 'minutes', async token => {
    const details = request.cursor === undefined ? await ask(deps, 'minutes', () => deps.channel.rawClient.request<{ code?: number; data?: { minute?: unknown } }>({
      method: 'GET', url: `/open-apis/minutes/v1/minutes/${encodeURIComponent(token)}`,
    })) : undefined;
    const { text } = await ask(deps, 'minutes', async () => {
      const answer = await deps.channel.rawClient.minutes.v1.minuteTranscript.get({ path: { minute_token: token }, params: { need_speaker: true, need_timestamp: true, file_format: 'txt' } });
      return { text: await streamed(answer.getReadableStream()) };
    }, TRANSCRIPT_MS);
    return { ...(details?.data?.minute !== undefined ? { minute: cleanCell(details.data.minute) } : {}), ...pageOf(text, from) };
  });
}
