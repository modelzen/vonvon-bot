import { isDelimiterRow } from './report-render';

/**
 * Markdown-aware structural parser and boundary splitter for Feishu run cards.
 *
 * Enforces the boundary rules from issue #798:
 *  1. Prefer paragraph boundaries (blank lines / top-level structural blocks).
 *  2. Fall back to line boundaries, then complete sentence boundaries only when
 *     a single paragraph exceeds an empty card's capacity.
 *  3. Keep fenced code blocks, pipe tables, commands, inline code, links, and
 *     image references intact — never cut through them.
 *  4. When a single indivisible item cannot fit even in an empty card, flag it
 *     as oversized so the caller provides the complete raw text as an attachment.
 */

export type MarkdownSegmentKind = 'code_block' | 'table' | 'heading' | 'paragraph';

export interface MarkdownSegment {
  readonly kind: MarkdownSegmentKind;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly atomic: boolean;
  readonly language?: string;
  /** True when `live` mode encountered an unclosed code fence or a trailing
   * pipe line whose delimiter row may still be streaming in. */
  readonly unclosed?: boolean;
}

export interface OversizedItem {
  readonly key: string;
  readonly kind: 'code_block' | 'table' | 'text' | 'tool';
  readonly raw: string;
  readonly language?: string;
  readonly label: string;
  readonly preview: string;
}

export interface TextCardSlice {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly oversized: readonly OversizedItem[];
}

export type LiveSplitDecision =
  | { readonly kind: 'fits' }
  | { readonly kind: 'split'; readonly splitOffset: number; readonly prefix: string }
  | { readonly kind: 'streaming_oversized'; readonly segment: MarkdownSegment }
  | { readonly kind: 'oversized'; readonly segment: MarkdownSegment; readonly item: OversizedItem };

interface LineSpan {
  readonly text: string;
  readonly start: number;
  /** End index excluding the line terminator (`\r\n` or `\n`). */
  readonly end: number;
  /** Start index of the next line (equals `source.length` on the last line). */
  readonly next: number;
}

function splitLines(source: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') {
      const end = i > start && source[i - 1] === '\r' ? i - 1 : i;
      lines.push({ text: source.slice(start, end), start, end, next: i + 1 });
      start = i + 1;
    }
  }
  if (start < source.length) {
    lines.push({ text: source.slice(start), start, end: source.length, next: source.length });
  }
  return lines;
}

function parseFenceOpen(line: string): { char: '`' | '~'; length: number; language: string } | null {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const info = match[2] ?? '';
  const char = fence[0] as '`' | '~';
  // Per CommonMark, a backtick code fence's info string cannot contain backticks
  // (otherwise it's an inline code span on the same line, e.g. ```foo```).
  if (char === '`' && info.includes('`')) return null;
  const language = info.trim().split(/\s+/u)[0] ?? '';
  return { char, length: fence.length, language };
}

function isFenceClose(line: string, char: '`' | '~', length: number): boolean {
  const trimmed = line.replace(/^[ \t]{0,3}/u, '').replace(/[ \t]*$/u, '');
  if (trimmed.length < length) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== char) return false;
  }
  return true;
}

function isHeadingLine(line: string): boolean {
  return /^[ \t]{0,3}#{1,6}[ \t]+\S/u.test(line);
}

function isTableStart(lines: readonly LineSpan[], index: number): boolean {
  const current = lines[index];
  const next = lines[index + 1];
  if (!current || !next) return false;
  return current.text.trim().startsWith('|') && isDelimiterRow(next.text);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && trimmed.includes('|');
}

/** Count GFM pipe table blocks in markdown text (used to enforce Feishu's
 * 5-table-per-card cap before `renderReport` degrades excess tables to pipes). */
export function countMarkdownTables(source: string): number {
  if (!source.includes('|')) return 0;
  return parseMarkdownBlocks(source, { live: false }).filter(seg => seg.kind === 'table').length;
}

/**
 * Parse markdown into ordered structural segments with exact character offsets.
 */
export function parseMarkdownBlocks(source: string, opts: { live?: boolean } = {}): MarkdownSegment[] {
  const lines = splitLines(source);
  const segments: MarkdownSegment[] = [];
  const live = opts.live === true;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.text.trim() === '') {
      i += 1;
      continue;
    }

    const fence = parseFenceOpen(line.text);
    if (fence) {
      const start = line.start;
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (isFenceClose(lines[j]!.text, fence.char, fence.length)) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      const end = lines[j - 1]!.end;
      segments.push({
        kind: 'code_block',
        start,
        end,
        raw: source.slice(start, end),
        atomic: true,
        ...(fence.language ? { language: fence.language } : {}),
        ...(!closed && live ? { unclosed: true } : {}),
      });
      i = j;
      continue;
    }

    if (isTableStart(lines, i)) {
      const start = line.start;
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!.text)) j += 1;
      const end = lines[j - 1]!.end;
      const unclosed = live && j === lines.length;
      segments.push({
        kind: 'table',
        start,
        end,
        raw: source.slice(start, end),
        atomic: true,
        ...(unclosed ? { unclosed: true } : {}),
      });
      i = j;
      continue;
    }

    // In live mode, a lone trailing `| ...` line at the very end could be the
    // header of a table whose delimiter row has not arrived yet.
    if (live && i === lines.length - 1 && line.text.trim().startsWith('|')) {
      segments.push({
        kind: 'table',
        start: line.start,
        end: line.end,
        raw: source.slice(line.start, line.end),
        atomic: true,
        unclosed: true,
      });
      i += 1;
      continue;
    }

    if (isHeadingLine(line.text)) {
      segments.push({
        kind: 'heading',
        start: line.start,
        end: line.end,
        raw: source.slice(line.start, line.end),
        atomic: false,
      });
      i += 1;
      continue;
    }

    // Paragraph: run of non-blank lines until a blank line, code fence, table, or heading.
    const start = line.start;
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j]!;
      if (candidate.text.trim() === '') break;
      if (parseFenceOpen(candidate.text) || isTableStart(lines, j) || isHeadingLine(candidate.text)) break;
      if (live && j === lines.length - 1 && candidate.text.trim().startsWith('|')) break;
      j += 1;
    }
    const end = lines[j - 1]!.end;
    segments.push({
      kind: 'paragraph',
      start,
      end,
      raw: source.slice(start, end),
      atomic: false,
    });
    i = j;
  }

  return segments;
}

type Span = readonly [number, number];

/** Protected inline ranges inside a paragraph where sentence splitting MUST NOT cut. */
function protectedInlineSpans(text: string, live = false): Span[] {
  const spans: Span[] = [];
  // Inline code (`...` / ``...``), markdown image/link ![alt](url) / [label](url), bare URLs.
  const re = /``[^`\n]+``|`[^`\n]+`|!?\[[^\]]*\]\(\s*(?:<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|https?:\/\/[^\s<>()]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  if (live) {
    // Protect an unterminated `![...` or `[...](...` or `` `... `` at the tail.
    const tailImg = text.lastIndexOf('![');
    if (tailImg >= 0 && !text.slice(tailImg).includes(')')) {
      spans.push([tailImg, text.length]);
    }
  }
  return spans;
}

function insideSpans(spans: readonly Span[], pos: number): boolean {
  for (const [a, b] of spans) {
    if (pos >= a && pos < b) return true;
  }
  return false;
}

const CLOSING_PUNCT = /^[”’」』）》】"'）)\]]/u;

export interface TextUnit {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  /** True when the unit ended on an explicit sentence terminator or line break. */
  readonly complete: boolean;
}

/**
 * Split a single line into complete sentences without breaking inline code,
 * markdown links/images, URLs, decimals, file paths, or list markers.
 */
export function splitLineIntoSentences(line: string, baseOffset = 0, live = false): TextUnit[] {
  if (!line) return [];
  const protectedSpans = protectedInlineSpans(line, live);
  const units: TextUnit[] = [];
  let start = 0;

  let i = 0;
  while (i < line.length) {
    if (insideSpans(protectedSpans, i)) {
      i += 1;
      continue;
    }
    const ch = line[i]!;
    let isBoundary = false;

    if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
      isBoundary = true;
    } else if (ch === '.' || ch === '!' || ch === '?') {
      const next = line[i + 1];
      const prev = i > 0 ? line[i - 1] : '';
      // Skip consecutive dots (e.g., `...`) until the last dot of the run.
      if (ch === '.' && next === '.') {
        i += 1;
        continue;
      }
      // Require end-of-line or whitespace (or closing quote + whitespace) after Latin sentence punct.
      let look = i + 1;
      while (look < line.length && CLOSING_PUNCT.test(line[look]!)) look += 1;
      const afterEnd = look >= line.length || /\s/u.test(line[look]!);
      if (afterEnd) {
        if (ch === '.') {
          // Do not split on numbered list prefix like `1. ` or `  12. ` at start of line,
          // or single-letter/decimal patterns like `v1.` / `3.`.
          const prefix = line.slice(start, i + 1);
          const isListMarker = /^[ \t]*\d+\.$/u.test(prefix);
          const isDecimal = prev !== undefined && /\d/u.test(prev) && next !== undefined && /\d/u.test(next);
          const isCommonAbbrev = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|Mr|Mrs|Ms|Dr|Prof|No|Fig|Eq)\.$/iu.test(prefix);
          if (!isListMarker && !isDecimal && !isCommonAbbrev) isBoundary = true;
        } else {
          isBoundary = true;
        }
      }
    }

    if (isBoundary) {
      let end = i + 1;
      while (end < line.length && CLOSING_PUNCT.test(line[end]!)) end += 1;
      // Include trailing horizontal spaces so the next sentence starts cleanly.
      while (end < line.length && (line[end] === ' ' || line[end] === '\t')) end += 1;
      const raw = line.slice(start, end);
      if (raw.trim()) {
        units.push({ start: baseOffset + start, end: baseOffset + end, raw, complete: true });
      }
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }

  if (start < line.length) {
    const raw = line.slice(start);
    if (raw.trim()) {
      units.push({ start: baseOffset + start, end: baseOffset + line.length, raw, complete: !live });
    }
  }
  return units;
}

/**
 * Split a paragraph into lines first; callers can try line-level packing before
 * falling back to sentence-level splitting on an oversized single line.
 */
export function splitParagraphLines(paragraph: string, baseOffset = 0, live = false): TextUnit[] {
  const lines = splitLines(paragraph);
  return lines
    .filter(line => line.text.trim() !== '')
    .map((line, index) => ({
      start: baseOffset + line.start,
      end: baseOffset + line.end,
      raw: line.text,
      complete: !live || index < lines.length - 1 || line.next > line.end,
    }));
}

const PREVIEW_CHARS = 360;

export function makePreview(raw: string, kind: OversizedItem['kind'], language?: string): string {
  const trimmed = raw.trim();
  const slice = trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS).trimEnd()}…` : trimmed;
  if (kind === 'code_block') {
    // Strip outer fence so the preview renders as a clean closed code block.
    const inner = stripOuterFence(trimmed);
    const shortInner = inner.length > PREVIEW_CHARS ? `${inner.slice(0, PREVIEW_CHARS).trimEnd()}\n…` : inner;
    return wrapCodeFence(shortInner, language ?? '');
  }
  return slice;
}

function stripOuterFence(raw: string): string {
  const lines = raw.split('\n');
  if (lines.length === 0) return raw;
  const open = parseFenceOpen(lines[0]!);
  if (!open) return raw;
  const body = lines.slice(1);
  if (body.length > 0 && isFenceClose(body[body.length - 1]!, open.char, open.length)) {
    body.pop();
  }
  return body.join('\n');
}

export function wrapCodeFence(value: string, language = ''): string {
  let fenceLength = 3;
  for (const match of value.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}${language}\n${value}\n${fence}`;
}

export function defaultOversizedPlaceholder(item: OversizedItem): string {
  const notice = `📎 **${item.label}**超出单卡容量（约 ${String(Buffer.byteLength(item.raw, 'utf8'))} 字节），完整原文将通过附件提供。`;
  return item.preview ? `${item.preview}\n\n${notice}` : notice;
}

function labelForSegment(kind: OversizedItem['kind'], language?: string): string {
  if (kind === 'code_block') return language ? `${language} 代码块` : '代码块';
  if (kind === 'table') return '表格';
  if (kind === 'tool') return '工具操作';
  return '单段内容';
}

export function createOversizedItem(
  key: string,
  kind: OversizedItem['kind'],
  raw: string,
  language?: string,
): OversizedItem {
  return {
    key,
    kind,
    raw,
    ...(language ? { language } : {}),
    label: labelForSegment(kind, language),
    preview: makePreview(raw, kind, language),
  };
}

/**
 * Group standalone headings with their immediately following segment so a heading
 * is not left orphaned at the bottom of a card when the content beneath it
 * moves to the next card.
 */
interface SegmentGroup {
  readonly segments: readonly MarkdownSegment[];
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly primary: MarkdownSegment;
}

function groupHeadings(source: string, segments: readonly MarkdownSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i]!;
    if (seg.kind === 'heading' && i + 1 < segments.length) {
      const next = segments[i + 1]!;
      groups.push({
        segments: [seg, next],
        start: seg.start,
        end: next.end,
        raw: source.slice(seg.start, next.end),
        primary: next,
      });
      i += 2;
      continue;
    }
    groups.push({
      segments: [seg],
      start: seg.start,
      end: seg.end,
      raw: seg.raw,
      primary: seg,
    });
    i += 1;
  }
  return groups;
}

export interface PaginateOptions {
  readonly blockId?: string;
  readonly makePlaceholder?: (item: OversizedItem) => string;
}

/**
 * Partition complete markdown text into one or more card slices.
 *
 * Fast path: if `fits(text, 0)` holds, returns a single slice untouched.
 * Otherwise splits at paragraph / structural boundaries first, falling back to
 * line then sentence boundaries for oversized paragraphs, and flagging single
 * indivisible items that exceed an empty card as oversized attachments.
 */
export function paginateMarkdown(
  source: string,
  fits: (candidateText: string, cardIndex: number) => boolean,
  opts: PaginateOptions = {},
): TextCardSlice[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  if (fits(source, 0)) {
    return [{ text: source, startOffset: 0, endOffset: source.length, oversized: [] }];
  }

  const blockId = opts.blockId ?? 'text';
  const makePlaceholder = opts.makePlaceholder ?? defaultOversizedPlaceholder;
  const segments = parseMarkdownBlocks(source, { live: false });
  if (segments.length === 0) {
    return [{ text: source, startOffset: 0, endOffset: source.length, oversized: [] }];
  }

  const groups = groupHeadings(source, segments);
  const slices: TextCardSlice[] = [];
  let currentPieces: string[] = [];
  let currentStart = 0;
  let currentEnd = 0;
  let currentOversized: OversizedItem[] = [];

  const joinPieces = (pieces: readonly string[], sep = '\n\n'): string => pieces.join(sep);

  const flush = (): void => {
    if (currentPieces.length === 0) return;
    slices.push({
      text: joinPieces(currentPieces),
      startOffset: currentStart,
      endOffset: currentEnd,
      oversized: currentOversized,
    });
    currentPieces = [];
    currentOversized = [];
  };

  const tryAppendPiece = (piece: string, start: number, end: number, sep = '\n\n', oversized?: OversizedItem): boolean => {
    const nextPieces = currentPieces.length === 0 ? [piece] : [...currentPieces, piece];
    const candidate = joinPieces(nextPieces, sep);
    if (!fits(candidate, slices.length)) return false;
    if (currentPieces.length === 0) currentStart = start;
    currentPieces = nextPieces;
    currentEnd = end;
    if (oversized) currentOversized.push(oversized);
    return true;
  };

  const emitUnits = (units: readonly TextUnit[], sep: string, allowSentenceFallback: boolean): void => {
    let idx = 0;
    while (idx < units.length) {
      // Binary search the largest prefix of `units[idx..]` that fits on the current card.
      let lo = 1;
      let hi = units.length - idx;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const chunk = units.slice(idx, idx + mid).map(u => u.raw).join(sep);
        const candidate = currentPieces.length === 0 ? chunk : `${joinPieces(currentPieces)}\n\n${chunk}`;
        if (fits(candidate, slices.length)) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (best > 0) {
        const chunk = units.slice(idx, idx + best).map(u => u.raw).join(sep);
        const start = units[idx]!.start;
        const end = units[idx + best - 1]!.end;
        if (currentPieces.length === 0) currentStart = start;
        currentPieces.push(chunk);
        currentEnd = end;
        idx += best;
        if (idx < units.length) flush();
        continue;
      }

      // Nothing from `units[idx..]` fits on the current card.
      if (currentPieces.length > 0) {
        flush();
        continue;
      }

      // Empty card still cannot fit `units[idx]` on its own!
      const single = units[idx]!;
      if (allowSentenceFallback) {
        const sentences = splitLineIntoSentences(single.raw, single.start, false);
        if (sentences.length > 1) {
          emitUnits(sentences, '', false);
          idx += 1;
          continue;
        }
      }

      // Indivisible single line/sentence exceeds empty card -> attachment fallback.
      const item = createOversizedItem(`${blockId}:${String(single.start)}`, 'text', single.raw);
      const placeholder = makePlaceholder(item);
      currentStart = single.start;
      currentEnd = single.end;
      currentPieces = [placeholder];
      currentOversized = [item];
      flush();
      idx += 1;
    }
  };

  const placeSegment = (seg: MarkdownSegment): void => {
    if (tryAppendPiece(seg.raw, seg.start, seg.end)) return;
    if (currentPieces.length > 0) {
      flush();
      if (tryAppendPiece(seg.raw, seg.start, seg.end)) return;
    }

    // Single segment does not fit even in an empty card.
    if (seg.kind === 'paragraph') {
      const lines = splitParagraphLines(seg.raw, seg.start, false);
      if (lines.length > 1) {
        emitUnits(lines, '\n', true);
      } else {
        const sentences = splitLineIntoSentences(seg.raw, seg.start, false);
        if (sentences.length > 1) {
          emitUnits(sentences, '', false);
        } else {
          const item = createOversizedItem(`${blockId}:${String(seg.start)}`, 'text', seg.raw);
          currentStart = seg.start;
          currentEnd = seg.end;
          currentPieces = [makePlaceholder(item)];
          currentOversized = [item];
          flush();
        }
      }
      return;
    }

    // Oversized atomic code block, table, or heading.
    const kind: OversizedItem['kind'] = seg.kind === 'code_block' ? 'code_block' : seg.kind === 'table' ? 'table' : 'text';
    const item = createOversizedItem(`${blockId}:${String(seg.start)}`, kind, seg.raw, seg.language);
    currentStart = seg.start;
    currentEnd = seg.end;
    currentPieces = [makePlaceholder(item)];
    currentOversized = [item];
    flush();
  };

  for (const group of groups) {
    if (tryAppendPiece(group.raw, group.start, group.end)) continue;
    if (currentPieces.length > 0) {
      flush();
      if (tryAppendPiece(group.raw, group.start, group.end)) continue;
    }
    // Group (e.g., heading + oversized body) didn't fit as a pair on an empty card.
    // Place each segment in order so heading stays intact and body decomposes cleanly.
    for (const seg of group.segments) {
      placeSegment(seg);
    }
  }

  flush();
  return slices;
}

/**
 * Decide how to handle a single live-streaming markdown block that has grown
 * past the current empty card's budget.
 *
 * Returns:
 *  - `fits`: the full `source` fits on the current card.
 *  - `split`: freeze `prefix` (`source.slice(0, splitOffset)`) on the current
 *    card and continue streaming `source.slice(splitOffset)` on a new card.
 *  - `streaming_oversized`: the very first segment is an unclosed code block or
 *    table (or an unbroken streaming line) that already exceeds an empty card;
 *    keep a bounded live preview until it closes, never mid-block split.
 *  - `oversized`: the very first segment is closed/settled yet exceeds an empty
 *    card; upload as attachment and advance past `segment.end`.
 */
export function findLiveMarkdownSplit(
  source: string,
  fits: (candidatePrefix: string) => boolean,
  opts: { live?: boolean; blockId?: string } = {},
): LiveSplitDecision {
  if (!source.trim() || fits(source)) return { kind: 'fits' };
  const live = opts.live ?? true;
  const blockId = opts.blockId ?? 'text';
  const segments = parseMarkdownBlocks(source, { live });
  if (segments.length === 0) return { kind: 'fits' };

  // 1. Try splitting on a complete top-level structural / paragraph boundary.
  //    Pick the largest boundary `k` (1 <= k < segments.length) where
  //    `source.slice(0, segments[k-1].end)` fits and doesn't leave a lone heading
  //    if an earlier boundary exists.
  let bestSegmentEnd = -1;
  for (let k = 1; k <= segments.length; k += 1) {
    const prev = segments[k - 1]!;
    if (prev.unclosed) break;
    // Never choose the very end of the entire source if it didn't fit above.
    if (k === segments.length) break;
    const prefix = source.slice(0, prev.end);
    if (!fits(prefix)) break;
    // Avoid ending on a trailing heading when we already have an earlier clean boundary.
    if (prev.kind === 'heading' && bestSegmentEnd > 0) continue;
    bestSegmentEnd = prev.end;
  }

  if (bestSegmentEnd > 0) {
    // Advance past trailing blank lines so the next card starts cleanly on the next segment.
    let splitOffset = bestSegmentEnd;
    while (splitOffset < source.length && (source[splitOffset] === '\r' || source[splitOffset] === '\n')) {
      splitOffset += 1;
    }
    return { kind: 'split', splitOffset, prefix: source.slice(0, bestSegmentEnd) };
  }

  // 2. Even the FIRST segment does not fit on its own.
  const first = segments[0]!;
  if (first.kind === 'paragraph') {
    // Try complete line boundaries first.
    const lines = splitParagraphLines(first.raw, first.start, live && segments.length === 1);
    const lineSplit = findFittingUnitPrefix(source, lines, fits);
    if (lineSplit !== null) return lineSplit;

    // Try complete sentence boundaries within the first line.
    const firstLine = lines[0];
    if (firstLine) {
      const sentences = splitLineIntoSentences(firstLine.raw, firstLine.start, live && segments.length === 1 && lines.length === 1);
      const sentSplit = findFittingUnitPrefix(source, sentences, fits);
      if (sentSplit !== null) return sentSplit;
    }

    // Even the first sentence/line doesn't fit on an empty card.
    if (live && segments.length === 1) {
      return { kind: 'streaming_oversized', segment: first };
    }
    return {
      kind: 'oversized',
      segment: first,
      item: createOversizedItem(`${blockId}:${String(first.start)}`, 'text', first.raw),
    };
  }

  // Atomic code block, table, or heading that doesn't fit on an empty card.
  if (first.unclosed || (live && segments.length === 1 && first.kind === 'heading')) {
    return { kind: 'streaming_oversized', segment: first };
  }
  const kind: OversizedItem['kind'] = first.kind === 'code_block' ? 'code_block' : first.kind === 'table' ? 'table' : 'text';
  return {
    kind: 'oversized',
    segment: first,
    item: createOversizedItem(`${blockId}:${String(first.start)}`, kind, first.raw, first.language),
  };
}

function findFittingUnitPrefix(
  source: string,
  units: readonly TextUnit[],
  fits: (candidatePrefix: string) => boolean,
): { kind: 'split'; splitOffset: number; prefix: string } | null {
  let bestEnd = -1;
  for (let k = 0; k < units.length; k += 1) {
    const unit = units[k]!;
    if (!unit.complete) break;
    // Must leave at least some remainder if we are splitting.
    if (unit.end >= source.length) break;
    const prefix = source.slice(0, unit.end);
    if (!fits(prefix)) break;
    bestEnd = unit.end;
  }
  if (bestEnd <= 0) return null;
  let splitOffset = bestEnd;
  while (splitOffset < source.length && (source[splitOffset] === '\r' || source[splitOffset] === '\n')) {
    splitOffset += 1;
  }
  return { kind: 'split', splitOffset, prefix: source.slice(0, bestEnd) };
}
