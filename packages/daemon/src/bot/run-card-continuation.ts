import { randomUUID } from 'node:crypto';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentEvent } from '../agent/types';
import {
  CONTINUATION_RESERVE,
  DEFAULT_CARD_BUDGET,
  fitsCardMetrics,
  measureCard,
  tryFitsCard,
  type CardBudget,
  type CardMetrics,
} from '../card/card-budget';
import {
  countMarkdownTables,
  createOversizedItem,
  findLiveMarkdownSplit,
  makePreview,
  paginateMarkdown,
  type OversizedItem,
} from '../card/content-split';
import { scanLocalFiles } from '../card/file-refs';
import { extractCardFences } from '../card/md-scan';
import {
  buildRunCard,
  runningAnswerText,
  type ContinuationReason,
  type RunCardState,
} from '../card/run-card';
import {
  createToolOverflowView,
  currentAnswerIndex,
  formatOverflowAttachmentMarkdown,
  formatOverflowAttachmentNotice,
  formatToolAttachmentText,
  type OverflowAttachmentView,
} from '../card/run-process';
import {
  advanceDisplayCursor,
  blockKey,
  EMPTY_DISPLAY_CURSOR,
  runSegment,
  sliceRunState,
  type DisplayCursor,
} from '../card/run-segment';
import type { Block, RunState, ToolEntry } from '../card/run-state';
import { finalMessageText } from '../card/run-state';
import { log } from '../core/logger';
import { MAX_FILE_BYTES, messageLink } from './outbound-files';

const ATTACHMENT_UPLOAD_TIMEOUT_MS = 30_000;
/** Cooldown after a transient continuation card creation failure so rapid deltas
 * don't tight-loop on Feishu 429s. */
const ROLLOVER_RETRY_COOLDOWN_MS = 2_500;
/** Estimated per-link expansion when `outboundFiles.prepare` converts local
 * file references into interactive_container/column_set components. */
const INLINE_FILE_BYTES_PER_LINK = 520;
const INLINE_FILE_COMPONENTS_PER_LINK = 6;
/** Headroom kept on frozen cards for finalization notes & icon replacement. */
const FROZEN_RESERVE: Partial<CardMetrics> = { bytes: 600, components: 6 };

export type LiveRolloverPlan =
  | { readonly action: 'keep' }
  | {
      readonly action: 'rollover_process';
      /** Blocks frozen onto the current card (complete blocks + optional split tail). */
      readonly frozenBlocks: readonly Block[];
      readonly completedBlocks: readonly Block[];
      readonly partialBlock?: { readonly key: string; readonly kind: 'text' | 'reasoning'; readonly consumedChars: number };
      readonly continued: ContinuationReason;
      readonly oversizedToUpload?: readonly OversizedUploadSpec[];
    }
  | {
      readonly action: 'rollover_answer';
      readonly frozenAnswerText: string;
      readonly answerKey: string;
      readonly consumedChars: number;
      readonly oversizedToUpload?: readonly OversizedUploadSpec[];
    }
  | {
      readonly action: 'mark_streaming_oversized';
      readonly key: string;
      readonly view: OverflowAttachmentView;
    }
  | {
      readonly action: 'upload_oversized_inplace';
      readonly uploads: readonly OversizedUploadSpec[];
    };

export interface OversizedUploadSpec {
  readonly key: string;
  readonly kind: OversizedItem['kind'];
  readonly raw: string;
  readonly language?: string;
  readonly label: string;
  readonly preview: string;
}

export interface PlannedTerminalCard {
  readonly role: 'combined' | 'process' | 'answer';
  readonly blocks: readonly Block[];
  readonly processOnly: boolean;
  readonly answerOnly: boolean;
  readonly continued?: ContinuationReason;
  /** Answer text to pass to `outboundFiles.prepare` (only on answer/combined cards). */
  readonly answerText: string;
  /** Oversized items referenced by this card that must be uploaded as attachments. */
  readonly oversized: readonly OversizedUploadSpec[];
}

function lastTextIndex(blocks: readonly Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b && b.kind === 'text' && b.content.trim()) return i;
  }
  return -1;
}

function processBlockVisibleFor(rc: RunCardState, block: Block, running: boolean): boolean {
  if (block.kind === 'compaction') return true;
  if (block.kind === 'text') return block.content.trim() !== '';
  if (block.kind === 'tool') {
    if (!rc.cardDisplay) return rc.showTools !== false;
    const cfg = rc.cardDisplay.blocks.find(item => item.kind === 'tools');
    return Boolean(cfg && (cfg.mode === 'always' || cfg.mode === (running ? 'running' : 'done')));
  }
  // reasoning
  if (!block.content.trim()) return false;
  if (!rc.cardDisplay) return true;
  const cfg = rc.cardDisplay.blocks.find(item => item.kind === 'thinking');
  return Boolean(cfg && (cfg.mode === 'always' || cfg.mode === (running ? 'running' : 'done')));
}

function hasVisibleProcess(rc: RunCardState, blocks: readonly Block[], running: boolean): boolean {
  if (rc.answerOnly) return false;
  return blocks.some(block => processBlockVisibleFor(rc, block, running));
}

function inlineFileReserve(answerText: string): Partial<CardMetrics> {
  if (!answerText.trim()) return {};
  const count = Math.min(10, scanLocalFiles(answerText).length);
  if (count === 0) return {};
  return {
    bytes: count * INLINE_FILE_BYTES_PER_LINK,
    components: count * INLINE_FILE_COMPONENTS_PER_LINK,
  };
}

function mergeReserve(a?: Partial<CardMetrics>, b?: Partial<CardMetrics>): Partial<CardMetrics> {
  return {
    bytes: (a?.bytes ?? 0) + (b?.bytes ?? 0),
    components: (a?.components ?? 0) + (b?.components ?? 0),
    tables: (a?.tables ?? 0) + (b?.tables ?? 0),
  };
}

function settledAttachmentsOnly(
  attachments: ReadonlyMap<string, OverflowAttachmentView> | undefined,
): Map<string, OverflowAttachmentView> | undefined {
  if (!attachments || attachments.size === 0) return undefined;
  const out = new Map<string, OverflowAttachmentView>();
  for (const [k, v] of attachments) {
    if (v.status !== 'streaming') out.set(k, v);
  }
  return out.size > 0 ? out : undefined;
}

/** Build a frozen process-only card candidate for budget probing. */
function fitsFrozenProcessCandidate(
  rc: RunCardState,
  blocks: readonly Block[],
  budget: CardBudget,
  extraAttachments?: ReadonlyMap<string, OverflowAttachmentView>,
): boolean {
  const runningTools = blocks.filter(b => b.kind === 'tool' && b.tool.status === 'running').length;
  const reserve: Partial<CardMetrics> = {
    bytes: (FROZEN_RESERVE.bytes ?? 0) + Math.min(runningTools * 1_500, 6_000),
    components: FROZEN_RESERVE.components,
  };
  const candidate: RunCardState = {
    ...rc,
    rs: { ...rc.rs, blocks: [...blocks], terminal: 'done', footer: null },
    cardKey: undefined,
    continued: 'capacity',
    processOnly: true,
    answerOnly: false,
    unboundedProcess: true,
    localFiles: undefined,
    overflowAttachments: extraAttachments ?? settledAttachmentsOnly(rc.overflowAttachments),
  };
  return tryFitsCard(() => buildRunCard(candidate), budget, reserve);
}

/** Build a frozen answer-only card candidate for budget probing (uses terminal
 * rendering so pipe tables & inline file links are accounted for accurately). */
function fitsFrozenAnswerCandidate(
  rc: RunCardState,
  answerText: string,
  opts: {
    budget: CardBudget;
    continued?: ContinuationReason;
    extraAttachments?: ReadonlyMap<string, OverflowAttachmentView>;
    includeTerminalChrome?: boolean;
  },
): boolean {
  if (countMarkdownTables(answerText) > opts.budget.maxTables) return false;
  const block: Block = { kind: 'text', id: '__probe__', content: answerText, streaming: false };
  const candidate: RunCardState = {
    ...rc,
    rs: {
      ...rc.rs,
      blocks: [block],
      terminal: opts.includeTerminalChrome ? (rc.rs.terminal === 'running' ? 'done' : rc.rs.terminal) : 'done',
      footer: null,
    },
    cardKey: opts.includeTerminalChrome ? rc.cardKey : undefined,
    continued: opts.continued,
    processOnly: false,
    answerOnly: true,
    unboundedProcess: true,
    localFiles: undefined,
    label: undefined,
    sessionNotice: undefined,
    voiceMessages: undefined,
    overflowAttachments: opts.extraAttachments ?? settledAttachmentsOnly(rc.overflowAttachments),
  };
  const reserve = mergeReserve(FROZEN_RESERVE, inlineFileReserve(answerText));
  return tryFitsCard(() => buildRunCard(candidate), opts.budget, reserve);
}

function withAttachment(
  base: ReadonlyMap<string, OverflowAttachmentView> | undefined,
  key: string,
  view: OverflowAttachmentView,
): Map<string, OverflowAttachmentView> {
  const next = new Map(base);
  next.set(key, view);
  return next;
}

function makeToolUploadSpec(tool: ToolEntry): OversizedUploadSpec {
  const raw = formatToolAttachmentText(tool);
  const view = createToolOverflowView(tool, 'pending');
  return {
    key: `tool:${tool.id}`,
    kind: 'tool',
    raw,
    label: view.label,
    preview: view.preview,
  };
}

function itemToUploadSpec(item: OversizedItem): OversizedUploadSpec {
  return {
    key: item.key,
    kind: item.kind,
    raw: item.raw,
    ...(item.language ? { language: item.language } : {}),
    label: item.label,
    preview: item.preview,
  };
}

const PLACEHOLDER_PREFIX = '<<VONVON_OVERFLOW_ATTACHMENT:';
const PLACEHOLDER_SUFFIX = '>>';

export function placeholderToken(key: string): string {
  return `${PLACEHOLDER_PREFIX}${key}${PLACEHOLDER_SUFFIX}`;
}

function inlinePlaceholderFor(item: OversizedItem): string {
  const token = placeholderToken(item.key);
  return item.preview ? `${item.preview}\n\n${token}` : token;
}

/** Replace inline attachment placeholder tokens with the settled status line
 * (preview is already placed directly above the token by `inlinePlaceholderFor`). */
export function resolveAttachmentPlaceholders(
  text: string,
  views: ReadonlyMap<string, OverflowAttachmentView>,
): string {
  if (!text.includes(PLACEHOLDER_PREFIX)) return text;
  let out = text;
  for (const [key, view] of views) {
    const token = placeholderToken(key);
    if (out.includes(token)) {
      out = out.replaceAll(token, formatOverflowAttachmentNotice(view));
    }
  }
  return out;
}

/**
 * Pure planner for live streaming runs. Given the active card's current
 * unconsumed `RunCardState`, decides whether to keep updating in place, roll
 * over to a continuation card on a clean content boundary, or mark/upload a
 * single oversized item as an attachment.
 */
export function planLiveRollover(
  rc: RunCardState,
  budget: CardBudget = DEFAULT_CARD_BUDGET,
): LiveRolloverPlan {
  // Always evaluate against settled attachments only so an active `'streaming'`
  // preview never masks a block once its code fence closes or more text arrives.
  const settled = settledAttachmentsOnly(rc.overflowAttachments);
  const probeRc: RunCardState = { ...rc, overflowAttachments: settled, unboundedProcess: true };
  if (tryFitsCard(() => buildRunCard(probeRc), budget, CONTINUATION_RESERVE)) {
    return { action: 'keep' };
  }

  const blocks = rc.rs.blocks;
  if (blocks.length === 0) return { action: 'keep' };

  const answerIdx = rc.processOnly ? -1 : currentAnswerIndex(blocks);
  const processBlocks = blocks.filter((_, i) => i !== answerIdx);
  const answerBlock = answerIdx >= 0 ? (blocks[answerIdx] as Extract<Block, { kind: 'text' }>) : undefined;
  const processVisible = hasVisibleProcess(probeRc, processBlocks, true);

  // Case L1: Card has both visible process and trailing streaming answer.
  // If the process alone fits, freeze ONLY the process onto the current card
  // and move the ENTIRE trailing answer onto a fresh continuation card (so if
  // it turns out to be the final answer, it stays whole on one card!).
  if (processVisible && answerBlock) {
    if (fitsFrozenProcessCandidate(probeRc, processBlocks, budget)) {
      return {
        action: 'rollover_process',
        frozenBlocks: processBlocks,
        completedBlocks: processBlocks,
        continued: 'capacity',
      };
    }
    // Otherwise process itself also overflows -> fall through to Case L2.
  }

  // Case L2: Process blocks exceed card budget.
  if (processVisible) {
    let maxFit = 0;
    for (let k = 1; k <= processBlocks.length; k += 1) {
      if (!fitsFrozenProcessCandidate(probeRc, processBlocks.slice(0, k), budget)) break;
      maxFit = k;
    }

    if (maxFit > 0) {
      // Prefer freezing at a settled boundary (before any still-running tool)
      // when at least one settled block precedes it, so in-flight tools land
      // complete on the continuation card.
      let splitAt = maxFit;
      const firstRunning = processBlocks.slice(0, maxFit).findIndex(
        b => (b.kind === 'tool' && b.tool.status === 'running')
          || (b.kind === 'compaction' && b.compaction.status === 'running'),
      );
      if (firstRunning > 0) splitAt = firstRunning;

      const frozen = processBlocks.slice(0, splitAt);
      return {
        action: 'rollover_process',
        frozenBlocks: frozen,
        completedBlocks: frozen,
        continued: 'capacity',
      };
    }

    // maxFit === 0: Even the VERY FIRST process block exceeds an empty card!
    const first = processBlocks[0]!;
    if (first.kind === 'tool') {
      const key = blockKey(first);
      const existing = settled?.get(key);
      if (first.tool.status === 'running') {
        return {
          action: 'mark_streaming_oversized',
          key,
          view: createToolOverflowView(first.tool, 'streaming'),
        };
      }
      if (existing) return { action: 'keep' };
      return {
        action: 'upload_oversized_inplace',
        uploads: [makeToolUploadSpec(first.tool)],
      };
    }

    if (first.kind === 'text' || first.kind === 'reasoning') {
      const key = blockKey(first);
      const decision = findLiveMarkdownSplit(
        first.content,
        prefix => fitsFrozenProcessCandidate(probeRc, [{ ...first, content: prefix, streaming: false }], budget),
        { live: first.streaming, blockId: key },
      );
      if (decision.kind === 'split') {
        return {
          action: 'rollover_process',
          frozenBlocks: [{ ...first, content: decision.prefix, streaming: false }],
          completedBlocks: [],
          partialBlock: { key, kind: first.kind, consumedChars: decision.splitOffset },
          continued: 'capacity',
        };
      }
      if (decision.kind === 'streaming_oversized') {
        const kind = decision.segment.kind === 'code_block' ? 'code_block' : decision.segment.kind === 'table' ? 'table' : 'text';
        const item = createOversizedItem(key, kind, decision.segment.raw, decision.segment.language);
        return {
          action: 'mark_streaming_oversized',
          key,
          view: {
            status: 'streaming',
            label: item.label,
            preview: item.preview,
            bytes: Buffer.byteLength(item.raw, 'utf8'),
          },
        };
      }
      if (decision.kind === 'oversized') {
        const spec = itemToUploadSpec(decision.item);
        let nextOffset = decision.segment.end;
        while (nextOffset < first.content.length && (first.content[nextOffset] === '\r' || first.content[nextOffset] === '\n')) {
          nextOffset += 1;
        }
        if (nextOffset < first.content.length) {
          // Freeze this oversized segment as an inline attachment placeholder on the current card
          // and advance past it so subsequent content continues cleanly on the next card.
          return {
            action: 'rollover_process',
            frozenBlocks: [{ ...first, content: inlinePlaceholderFor(decision.item), streaming: false }],
            completedBlocks: [],
            partialBlock: { key, kind: first.kind, consumedChars: nextOffset },
            continued: 'capacity',
            oversizedToUpload: [spec],
          };
        }
        return { action: 'upload_oversized_inplace', uploads: [{ ...spec, key }] };
      }
    }
  }

  // Case L3: No visible process (only trailing streaming answer) and answer alone overflows.
  if (answerBlock) {
    const key = blockKey(answerBlock);
    if (settled?.has(key)) return { action: 'keep' };
    const decision = findLiveMarkdownSplit(
      answerBlock.content,
      prefix => fitsFrozenAnswerCandidate(probeRc, prefix, { budget, continued: 'capacity' }),
      { live: answerBlock.streaming, blockId: key },
    );
    if (decision.kind === 'split') {
      return {
        action: 'rollover_answer',
        frozenAnswerText: decision.prefix,
        answerKey: key,
        consumedChars: decision.splitOffset,
      };
    }
    if (decision.kind === 'streaming_oversized') {
      const kind = decision.segment.kind === 'code_block' ? 'code_block' : decision.segment.kind === 'table' ? 'table' : 'text';
      const item = createOversizedItem(key, kind, decision.segment.raw, decision.segment.language);
      return {
        action: 'mark_streaming_oversized',
        key,
        view: {
          status: 'streaming',
          label: item.label,
          preview: item.preview,
          bytes: Buffer.byteLength(item.raw, 'utf8'),
        },
      };
    }
    if (decision.kind === 'oversized') {
      const spec = itemToUploadSpec(decision.item);
      let nextOffset = decision.segment.end;
      while (nextOffset < answerBlock.content.length && (answerBlock.content[nextOffset] === '\r' || answerBlock.content[nextOffset] === '\n')) {
        nextOffset += 1;
      }
      if (nextOffset < answerBlock.content.length) {
        return {
          action: 'rollover_answer',
          frozenAnswerText: inlinePlaceholderFor(decision.item),
          answerKey: key,
          consumedChars: nextOffset,
          oversizedToUpload: [spec],
        };
      }
      // Still streaming with nothing after the oversized segment yet: keep bounded preview
      // until either more content follows or the turn settles, avoiding an empty trailing card.
      if (answerBlock.streaming) {
        return {
          action: 'mark_streaming_oversized',
          key,
          view: {
            status: 'streaming',
            label: spec.label,
            preview: spec.preview,
            bytes: Buffer.byteLength(spec.raw, 'utf8'),
          },
        };
      }
      return { action: 'upload_oversized_inplace', uploads: [{ ...spec, key }] };
    }
  }

  return { action: 'keep' };
}

/**
 * Pure terminal pagination planner.
 *
 * Implements Requirement 3 + confirmed default #1:
 *  - If the current card's remaining process + final answer fit together on one
 *    card, return a single `'combined'` card (staying on the last card!).
 *  - Otherwise paginate any remaining process blocks into `'process'` card(s),
 *    and evaluate the FULL final answer against a FRESH EMPTY card:
 *      - If the full final answer fits in one empty card -> emit ONE `'answer'`
 *        card showing the complete reply.
 *      - Only if the full final answer itself exceeds an empty card -> split at
 *        paragraph / sentence / atomic boundaries across multiple `'answer'` cards,
 *        with single oversized items flagged for attachment delivery.
 */
export function planTerminalCards(
  rc: RunCardState,
  budget: CardBudget = DEFAULT_CARD_BUDGET,
): PlannedTerminalCard[] {
  const blocks = rc.rs.blocks;
  const answerIdx = rc.processOnly ? -1 : lastTextIndex(blocks);
  const answerBlock = answerIdx >= 0 ? (blocks[answerIdx] as Extract<Block, { kind: 'text' }>) : undefined;
  const rawAnswer = answerBlock?.content.trim() ?? '';
  const strippedAnswer = rawAnswer ? extractCardFences(rawAnswer).stripped.trim() : '';
  const processBlocks = blocks.filter((_, i) => i !== answerIdx);
  const processVisible = hasVisibleProcess(rc, processBlocks, false);

  const settled = settledAttachmentsOnly(rc.overflowAttachments);
  const baseRc: RunCardState = {
    ...rc,
    overflowAttachments: settled,
    unboundedProcess: true,
    localFiles: undefined,
  };

  // Fast path: check whether remaining process + full final answer fit on ONE card.
  const combinedReserve = mergeReserve(FROZEN_RESERVE, inlineFileReserve(strippedAnswer));
  const combinedCandidate: RunCardState = {
    ...baseRc,
    rs: { ...baseRc.rs, blocks: [...blocks] },
    continued: undefined,
    processOnly: false,
    answerOnly: !processVisible && baseRc.answerOnly === true,
  };
  if (
    countMarkdownTables(strippedAnswer) <= budget.maxTables
    && tryFitsCard(() => buildRunCard(combinedCandidate), budget, combinedReserve)
  ) {
    return [{
      role: 'combined',
      blocks,
      processOnly: false,
      answerOnly: !processVisible && baseRc.answerOnly === true,
      answerText: rawAnswer,
      oversized: [],
    }];
  }

  const cards: PlannedTerminalCard[] = [];

  // 1. Paginate any remaining visible process blocks into process-only card(s).
  if (processVisible) {
    const processCards = paginateProcessBlocks(baseRc, processBlocks, budget);
    const hasAnswerAfter = Boolean(strippedAnswer);
    processCards.forEach((pCard, index) => {
      const isLastProcess = index === processCards.length - 1;
      const continued: ContinuationReason | undefined = !isLastProcess
        ? 'capacity'
        : hasAnswerAfter ? 'answer' : undefined;
      cards.push({
        role: 'process',
        blocks: pCard.blocks,
        processOnly: true,
        answerOnly: false,
        continued,
        answerText: '',
        oversized: pCard.oversized,
      });
    });
  }

  // 2. Plan final answer cards on a fresh empty card budget (Requirement 3).
  if (strippedAnswer) {
    const answerKey = answerBlock ? blockKey(answerBlock) : 'text:answer';
    const baseAnswerRc: RunCardState = {
      ...baseRc,
      label: undefined,
      sessionNotice: undefined,
      voiceMessages: undefined,
      answerOnly: true,
      processOnly: false,
    };

    // Check full final answer against ONE empty card first!
    if (fitsFrozenAnswerCandidate(baseAnswerRc, strippedAnswer, { budget, includeTerminalChrome: true })) {
      cards.push({
        role: 'answer',
        blocks: [{ kind: 'text', id: answerBlock?.id ?? 'answer', content: rawAnswer, streaming: false }],
        processOnly: false,
        answerOnly: true,
        answerText: rawAnswer,
        oversized: [],
      });
    } else {
      // Full answer itself exceeds one empty card -> split at clean paragraph/sentence/atomic boundaries.
      const slices = paginateMarkdown(
        strippedAnswer,
        (candidateText, _index) => fitsFrozenAnswerCandidate(baseAnswerRc, candidateText, {
          budget,
          continued: 'capacity',
          includeTerminalChrome: true,
        }),
        {
          blockId: answerKey,
          makePlaceholder: inlinePlaceholderFor,
        },
      );
      slices.forEach((slice, index) => {
        const isLast = index === slices.length - 1;
        const uploads = slice.oversized.map(itemToUploadSpec);
        cards.push({
          role: 'answer',
          blocks: [{ kind: 'text', id: `${answerBlock?.id ?? 'answer'}_p${String(index)}`, content: slice.text, streaming: false }],
          processOnly: false,
          answerOnly: true,
          continued: isLast ? undefined : 'capacity',
          answerText: slice.text,
          oversized: uploads,
        });
      });
    }
  } else if (cards.length === 0) {
    // No visible process and no stripped answer (e.g., error/timeout/empty card or fence-only reply).
    cards.push({
      role: 'combined',
      blocks,
      processOnly: false,
      answerOnly: baseRc.answerOnly === true,
      answerText: rawAnswer,
      oversized: [],
    });
  }

  return cards;
}

interface PaginatedProcessCard {
  readonly blocks: readonly Block[];
  readonly oversized: readonly OversizedUploadSpec[];
}

function paginateProcessBlocks(
  baseRc: RunCardState,
  processBlocks: readonly Block[],
  budget: CardBudget,
): PaginatedProcessCard[] {
  const result: PaginatedProcessCard[] = [];
  let currentBlocks: Block[] = [];
  let currentOversized: OversizedUploadSpec[] = [];
  let currentAttachments = new Map(baseRc.overflowAttachments);

  const flush = (): void => {
    if (currentBlocks.length === 0) return;
    result.push({ blocks: currentBlocks, oversized: currentOversized });
    currentBlocks = [];
    currentOversized = [];
    currentAttachments = new Map(baseRc.overflowAttachments);
  };

  const fitsCurrent = (candidate: readonly Block[], attachments = currentAttachments): boolean =>
    fitsFrozenProcessCandidate(baseRc, candidate, budget, attachments);

  for (const block of processBlocks) {
    if (!processBlockVisibleFor(baseRc, block, false)) continue;

    if (fitsCurrent([...currentBlocks, block])) {
      currentBlocks.push(block);
      continue;
    }

    if (currentBlocks.length > 0) {
      flush();
      if (fitsCurrent([block])) {
        currentBlocks.push(block);
        continue;
      }
    }

    // Single block does not fit even in an empty process card!
    if (block.kind === 'tool') {
      const spec = makeToolUploadSpec(block.tool);
      const pendingView = createToolOverflowView(block.tool, 'pending');
      currentAttachments = withAttachment(currentAttachments, spec.key, pendingView);
      currentBlocks.push(block);
      currentOversized.push(spec);
      flush();
      continue;
    }

    if (block.kind === 'text' || block.kind === 'reasoning') {
      const key = blockKey(block);
      const slices = paginateMarkdown(
        block.content,
        candidateText => fitsCurrent([{ ...block, content: candidateText, streaming: false }]),
        {
          blockId: key,
          makePlaceholder: inlinePlaceholderFor,
        },
      );
      slices.forEach((slice, sliceIdx) => {
        const sliceBlock: Block = {
          kind: block.kind,
          id: slices.length === 1 ? block.id : `${block.id}_p${String(sliceIdx)}`,
          content: slice.text,
          streaming: false,
        };
        const uploads = slice.oversized.map(itemToUploadSpec);
        if (currentBlocks.length > 0 && !fitsCurrent([...currentBlocks, sliceBlock])) flush();
        currentBlocks.push(sliceBlock);
        currentOversized.push(...uploads);
        if (sliceIdx < slices.length - 1) flush();
      });
      continue;
    }

    // Compaction marker (tiny, always keep).
    currentBlocks.push(block);
  }

  flush();
  return result;
}

const LANG_EXT: Readonly<Record<string, string>> = {
  ts: '.ts', typescript: '.ts', tsx: '.tsx',
  js: '.js', javascript: '.js', jsx: '.jsx', mjs: '.mjs', cjs: '.cjs',
  py: '.py', python: '.py',
  sh: '.sh', bash: '.sh', zsh: '.sh', shell: '.sh',
  json: '.json', yaml: '.yaml', yml: '.yaml', toml: '.toml', xml: '.xml',
  sql: '.sql', html: '.html', css: '.css', scss: '.scss',
  go: '.go', rs: '.rs', rust: '.rs', java: '.java', kt: '.kt', swift: '.swift',
  c: '.c', cpp: '.cpp', h: '.h', cs: '.cs', rb: '.rb', php: '.php',
  diff: '.diff', patch: '.diff', md: '.md', markdown: '.md', csv: '.csv',
};

export function overflowAttachmentFileName(spec: Pick<OversizedUploadSpec, 'kind' | 'language'>, seq: number): string {
  if (spec.kind === 'code_block') {
    const ext = spec.language ? (LANG_EXT[spec.language.toLowerCase()] ?? '.txt') : '.txt';
    return `code-${String(seq)}${ext}`;
  }
  if (spec.kind === 'table') return `table-${String(seq)}.md`;
  if (spec.kind === 'tool') return `operation-${String(seq)}.md`;
  return `content-${String(seq)}.md`;
}

async function timed<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('附件上传超时')), ATTACHMENT_UPLOAD_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Upload an oversized single item's raw UTF-8 text as a Feishu file attachment
 * and send it into the same topic/chat. Deduplicated per `spec.key` by the
 * caller's cache. Never throws — returns a `sent` or `failed` view.
 */
export async function sendOverflowAttachment(
  channel: LarkChannel,
  spec: OversizedUploadSpec,
  opts: {
    readonly chatId: string;
    readonly replyTo: string;
    readonly replyInThread: boolean;
    readonly seq: number;
  },
): Promise<OverflowAttachmentView> {
  const bytes = Buffer.from(spec.raw, 'utf8');
  const fileName = overflowAttachmentFileName(spec, opts.seq);
  const baseView = {
    label: spec.label,
    preview: spec.preview,
    bytes: bytes.length,
    fileName,
  };
  if (bytes.length === 0) {
    return { ...baseView, status: 'failed', error: '内容为空' };
  }
  if (bytes.length > MAX_FILE_BYTES) {
    return { ...baseView, status: 'failed', error: '超过 30 MB 飞书附件上限' };
  }
  const fileApi = channel.rawClient?.im?.v1?.file;
  const messageApi = channel.rawClient?.im?.v1?.message;
  if (!fileApi?.create || !messageApi?.reply) {
    return { ...baseView, status: 'failed', error: '文件接口不可用' };
  }
  try {
    const uploaded = await timed(fileApi.create({
      data: { file_type: 'stream', file_name: fileName, file: bytes },
    })) as { file_key?: string; data?: { file_key?: string } } | undefined;
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key;
    if (!fileKey) throw new Error('未返回 file_key');
    const sent = await timed(messageApi.reply({
      path: { message_id: opts.replyTo },
      data: {
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
        reply_in_thread: opts.replyInThread,
        uuid: randomUUID(),
      },
    })) as { code?: number; data?: { message_id?: string; message_app_link?: string; message_position?: string; chat_id?: string } } | undefined;
    if (sent?.code && sent.code !== 0) throw new Error(`发送失败 (${String(sent.code)})`);
    const link = sent?.data ? messageLink(sent.data, opts.chatId) : undefined;
    log.info('card', 'overflow-attachment-sent', { key: spec.key, fileName, bytes: bytes.length });
    return {
      ...baseView,
      status: 'sent',
      ...(link ? { messageLink: link } : {}),
    };
  } catch (err) {
    log.fail('card', err, { phase: 'overflow-attachment', key: spec.key, fileName, bytes: bytes.length });
    const message = err instanceof Error ? err.message.slice(0, 80) : '上传失败';
    return { ...baseView, status: 'failed', error: message };
  }
}

interface FrozenRunningToolEntry {
  readonly rc: RunCardState;
  readonly update: (rc: RunCardState) => Promise<boolean>;
  readonly messageId: string;
}

export interface ContinuationHost {
  readonly channel: LarkChannel;
  readonly chatId: string;
  readonly replyInThread: boolean;
  readonly budget?: CardBudget;
  /** Create a new continuation card replying to `replyTo` and make it active.
   * Returns `{ messageId }` on success, or `null` if creation failed. */
  readonly openNextCard: (opts: {
    readonly replyTo: string;
    readonly nextRs: RunState;
    readonly answerOnly?: boolean;
    readonly attachments: ReadonlyMap<string, OverflowAttachmentView>;
  }) => Promise<{ readonly messageId: string } | null>;
  /** Finalize the PREVIOUS active card (after `openNextCard` has swapped active
   * state to the new card) with `frozenRc`. */
  readonly finalizePreviousCard: (frozenRc: RunCardState) => Promise<{
    readonly messageId: string;
    readonly updateCard: (rc: RunCardState) => Promise<boolean>;
  }>;
  /** Current active card's messageId (empty string in completionOnly or lazy goal mode). */
  readonly activeMessageId: () => string;
  /** Current active card's RunCardState (mutated in place as state evolves). */
  readonly activeCard: () => RunCardState;
  /** Current active card's live push callback. */
  readonly pushActiveCard: (builtFrame?: ReturnType<typeof buildRunCard>) => void;
}

/**
 * Stateful per-turn continuation manager shared by `launchRun` and `launchGoalRun`.
 *
 * Owns:
 *  - `DisplayCursor` (both capacity rollovers and steer resets)
 *  - `uploadedAttachments` cache (deduplicated per oversized item key) + live `streamingPreviews`
 *  - `frozenTools` (in-place completion for parallel tools on frozen cards)
 *  - Rollover failure cooldown (graceful fallback when Feishu refuses card creation)
 */
export class RunCardContinuation {
  private cursor: DisplayCursor = EMPTY_DISPLAY_CURSOR;
  private steerBoundary: RunState | undefined;
  private readonly uploadedAttachments = new Map<string, OverflowAttachmentView>();
  private readonly streamingPreviews = new Map<string, OverflowAttachmentView>();
  private readonly frozenTools = new Map<string, FrozenRunningToolEntry>();
  private attachmentSeq = 0;
  private rolloverBlockedUntil = 0;
  private rolloverCount = 0;

  constructor(private readonly host: ContinuationHost) {}

  get hasRolledOver(): boolean {
    return this.rolloverCount > 0;
  }

  /** Full final answer text since the start of the turn (or last steer), across
   * any capacity-driven continuation splits. Used for handoff, clean fences,
   * usage notes, and recent-message memory. */
  fullTurnAnswerText(fullState: RunState): string {
    return finalMessageText(runSegment(fullState, this.steerBoundary));
  }

  /** Merged map of settled uploads + active streaming previews for live rendering. */
  currentAttachments(): ReadonlyMap<string, OverflowAttachmentView> | undefined {
    if (this.uploadedAttachments.size === 0 && this.streamingPreviews.size === 0) return undefined;
    const merged = new Map(this.uploadedAttachments);
    for (const [k, v] of this.streamingPreviews) {
      if (!merged.has(k)) merged.set(k, v);
    }
    return merged;
  }

  /** Settled (sent/failed) attachments only, for terminal rendering. */
  settledAttachments(): ReadonlyMap<string, OverflowAttachmentView> | undefined {
    return this.uploadedAttachments.size > 0 ? this.uploadedAttachments : undefined;
  }

  /** Project the full `RunState` through the current display cursor. */
  segmentOf(fullState: RunState): RunState {
    return sliceRunState(fullState, this.cursor);
  }

  /** Advance cursor on an accepted steer boundary (replaces legacy `boundary: RunState`). */
  resetForSteer(fullState: RunState, nextStartedAt: number): void {
    const consumed = new Map(this.cursor.consumed);
    for (const block of fullState.blocks) {
      const k = blockKey(block);
      if (block.kind === 'tool') {
        const running = block.tool.status === 'running';
        consumed.set(k, { kind: 'tool', wasRunning: running, fullyConsumed: !running });
      } else if (block.kind === 'compaction') {
        const running = block.compaction.status === 'running';
        consumed.set(k, { kind: 'compaction', wasRunning: running, fullyConsumed: !running });
      } else {
        consumed.set(k, { kind: block.kind, committedPrefix: block.content });
      }
    }
    this.cursor = { consumed, startedAt: nextStartedAt };
    this.steerBoundary = fullState;
    this.streamingPreviews.clear();
    this.frozenTools.clear();
  }

  /** Upload any oversized specs not yet uploaded (deduplicated by `spec.key`). */
  async ensureAttachments(
    specs: readonly OversizedUploadSpec[],
    replyTo: string,
  ): Promise<ReadonlyMap<string, OverflowAttachmentView>> {
    for (const spec of specs) {
      const existing = this.uploadedAttachments.get(spec.key);
      if (existing && (existing.status === 'sent' || existing.status === 'failed')) continue;
      const view = await sendOverflowAttachment(this.host.channel, spec, {
        chatId: this.host.chatId,
        replyTo,
        replyInThread: this.host.replyInThread,
        seq: ++this.attachmentSeq,
      });
      this.uploadedAttachments.set(spec.key, view);
      this.streamingPreviews.delete(spec.key);
    }
    return this.uploadedAttachments;
  }

  /**
   * Handle one live event after `render.apply(ev)`. Updates any frozen card
   * waiting on a parallel tool result, rolls over to continuation card(s) if
   * the active card exceeds capacity, and pushes the bounded active card.
   */
  async syncLive(fullState: RunState, ev?: AgentEvent, opts: { skipPush?: boolean } = {}): Promise<void> {
    if (ev?.type === 'tool_result') {
      const frozen = this.frozenTools.get(ev.itemId);
      if (frozen) {
        this.frozenTools.delete(ev.itemId);
        await this.updateFrozenToolResult(frozen, fullState, ev.itemId);
      }
    }

    const activeMsgId = this.host.activeMessageId();
    if (!activeMsgId) {
      const rc = this.host.activeCard();
      rc.rs = this.segmentOf(fullState);
      return;
    }

    const budget = this.host.budget ?? DEFAULT_CARD_BUDGET;

    for (let step = 0; step < 8; step += 1) {
      const currentRc = this.host.activeCard();
      currentRc.rs = this.segmentOf(fullState);
      currentRc.overflowAttachments = this.currentAttachments();
      currentRc.unboundedProcess = true;

      const plan = planLiveRollover(currentRc, budget);
      if (plan.action === 'keep') {
        // Clear stale streaming previews once the real content fits cleanly.
        if (this.streamingPreviews.size > 0) {
          this.streamingPreviews.clear();
          currentRc.overflowAttachments = this.currentAttachments();
        }
        if (!opts.skipPush) {
          const built = buildRunCard(currentRc);
          if (fitsCardMetrics(measureCard(built), budget)) {
            this.host.pushActiveCard(built);
          } else {
            this.host.pushActiveCard(buildRunCard({ ...currentRc, unboundedProcess: false }));
          }
        }
        return;
      }

      if (plan.action === 'mark_streaming_oversized') {
        this.streamingPreviews.set(plan.key, plan.view);
        currentRc.overflowAttachments = this.currentAttachments();
        if (!opts.skipPush) {
          const built = buildRunCard(currentRc);
          if (fitsCardMetrics(measureCard(built), budget)) {
            this.host.pushActiveCard(built);
          } else {
            this.host.pushActiveCard(buildRunCard({ ...currentRc, unboundedProcess: false }));
          }
        }
        return;
      }

      if (plan.action === 'upload_oversized_inplace') {
        await this.ensureAttachments(plan.uploads, this.host.activeMessageId());
        currentRc.overflowAttachments = this.currentAttachments();
        continue;
      }

      if (Date.now() < this.rolloverBlockedUntil) {
        if (!opts.skipPush) {
          this.host.pushActiveCard(buildRunCard({ ...currentRc, unboundedProcess: false }));
        }
        return;
      }

      const prevMsgId = this.host.activeMessageId();
      if (plan.oversizedToUpload?.length) {
        await this.ensureAttachments(plan.oversizedToUpload, prevMsgId);
      }

      const nextStartedAt = Date.now();
      const nextCursor = plan.action === 'rollover_process'
        ? advanceDisplayCursor(this.cursor, currentRc.rs, {
            completedBlocks: plan.completedBlocks,
            partialBlock: plan.partialBlock,
            nextStartedAt,
          })
        : advanceDisplayCursor(this.cursor, currentRc.rs, {
            partialBlock: { key: plan.answerKey, kind: 'text', consumedChars: plan.consumedChars },
            nextStartedAt,
          });

      const nextRs = sliceRunState(fullState, nextCursor);
      const nextAnswerOnly = plan.action === 'rollover_answer';

      this.streamingPreviews.clear();
      const opened = await this.host.openNextCard({
        replyTo: prevMsgId,
        nextRs,
        answerOnly: nextAnswerOnly,
        attachments: this.uploadedAttachments,
      });
      if (!opened) {
        this.rolloverBlockedUntil = Date.now() + ROLLOVER_RETRY_COOLDOWN_MS;
        if (!opts.skipPush) {
          this.host.pushActiveCard(buildRunCard({ ...currentRc, unboundedProcess: false }));
        }
        return;
      }

      // Resolve any inline attachment placeholders inside the frozen card's blocks.
      const rawFrozenBlocks: Block[] = plan.action === 'rollover_process'
        ? [...plan.frozenBlocks]
        : [{ kind: 'text', id: plan.answerKey.replace(/^text:/u, ''), content: plan.frozenAnswerText, streaming: false }];
      const frozenBlocks = applyResolvedAttachmentsToBlocks(rawFrozenBlocks, this.uploadedAttachments);

      const frozenRc: RunCardState = {
        ...currentRc,
        rs: {
          ...currentRc.rs,
          blocks: frozenBlocks,
          terminal: 'done',
          footer: null,
          completedAt: nextStartedAt,
        },
        cardKey: undefined,
        continued: plan.action === 'rollover_process' ? plan.continued : 'capacity',
        processOnly: plan.action === 'rollover_process',
        answerOnly: plan.action === 'rollover_answer',
        unboundedProcess: true,
        overflowAttachments: this.uploadedAttachments.size > 0 ? new Map(this.uploadedAttachments) : undefined,
      };

      this.cursor = nextCursor;
      this.rolloverCount += 1;

      const finalized = await this.host.finalizePreviousCard(frozenRc);

      if (plan.action === 'rollover_process') {
        for (const block of frozenBlocks) {
          if (block.kind === 'tool' && block.tool.status === 'running') {
            this.frozenTools.set(block.tool.id, {
              rc: frozenRc,
              update: finalized.updateCard,
              messageId: finalized.messageId,
            });
          }
        }
      }
    }

    if (!opts.skipPush) {
      const currentRc = this.host.activeCard();
      this.host.pushActiveCard(buildRunCard({ ...currentRc, unboundedProcess: false }));
    }
  }

  private async updateFrozenToolResult(
    entry: FrozenRunningToolEntry,
    fullState: RunState,
    toolId: string,
  ): Promise<void> {
    const latest = fullState.blocks.find(
      (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool' && b.tool.id === toolId,
    );
    if (!latest) return;
    const budget = this.host.budget ?? DEFAULT_CARD_BUDGET;
    const updatedBlocks = entry.rc.rs.blocks.map(b =>
      b.kind === 'tool' && b.tool.id === toolId ? latest : b,
    );
    entry.rc.rs = { ...entry.rc.rs, blocks: updatedBlocks };
    if (!tryFitsCard(() => buildRunCard(entry.rc), budget, FROZEN_RESERVE)) {
      const spec = makeToolUploadSpec(latest.tool);
      await this.ensureAttachments([spec], entry.messageId);
      entry.rc.overflowAttachments = new Map(this.uploadedAttachments);
    }
    await entry.update(entry.rc).catch(err =>
      log.fail('card', err, { phase: 'frozen-tool-update', toolId }),
    );
  }
}

export function applyResolvedAttachmentsToBlocks(
  blocks: readonly Block[],
  views: ReadonlyMap<string, OverflowAttachmentView>,
): Block[] {
  return blocks.map(block => {
    if (block.kind !== 'text' && block.kind !== 'reasoning') return block;
    const resolved = resolveAttachmentPlaceholders(block.content, views);
    return resolved === block.content ? block : { ...block, content: resolved };
  });
}

export function extractFullAnswerText(state: RunState): string {
  return finalMessageText(state);
}

/** Build a live card guaranteed to fit within `budget` (falling back to bounded
 * process rendering if the live frame temporarily sits above budget, e.g. during
 * rollover retry cooldown). */
export function buildSafeLiveCard(
  rc: RunCardState,
  budget: CardBudget = DEFAULT_CARD_BUDGET,
): ReturnType<typeof buildRunCard> {
  const built = buildRunCard(rc);
  if (fitsCardMetrics(measureCard(built), budget)) return built;
  return buildRunCard({ ...rc, unboundedProcess: false });
}

/** Build a pending-status attachment view map for initial carrier creation when
 * a newly created terminal card contains oversized items not yet uploaded. */
export function pendingAttachmentsFor(
  base: ReadonlyMap<string, OverflowAttachmentView> | undefined,
  specs: readonly OversizedUploadSpec[],
): Map<string, OverflowAttachmentView> {
  const map = new Map(base);
  for (const spec of specs) {
    if (!map.has(spec.key)) {
      map.set(spec.key, {
        status: 'pending',
        label: spec.label,
        preview: spec.preview,
        bytes: Buffer.byteLength(spec.raw, 'utf8'),
      });
    }
  }
  return map;
}

/** Running text helper re-exported for callers finalizing frozen segment images. */
export function segmentImageText(state: RunState): string {
  return runningAnswerText(state);
}
