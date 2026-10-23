import { errorKindFromText, type AgentErrorKind } from '../agent/error-kind';
import type { AgentEvent, ToolKind } from '../agent/types';

/**
 * Structured run state for the in-topic run card. AgentEvents are folded into
 * this (pure {@link reduce}) and {@link buildRunCard} renders it — reasoning and
 * tool calls become collapsible panels, text streams in order. Modeled on
 * zara/feishu-claude-code-bridge `src/card/run-state.ts`, adapted to this
 * repo's event shape (text_delta/text + thinking_delta/thinking keyed by
 * itemId, commandExecution carrying its command as `title` + aggregatedOutput).
 */

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  /** itemId from the agent event */
  id: string;
  /** human-readable label (for commandExecution this IS the command) */
  title: string;
  /** secondary detail, e.g. cwd for a shell command */
  detail?: string;
  /** coarse category — drives rendering (command → full ```bash body). Absent ⇒ 'tool'. */
  kind?: ToolKind;
  status: ToolStatus;
  output?: string;
  exitCode?: number | null;
}

/** Context-window occupancy: `window` null when the backend reports none. */
export interface Usage {
  used: number;
  window: number | null;
}

/**
 * One native compaction during the run, shown as a line in the process area
 * ("已压缩 85% → 20%"). `before` is the meter's reading when it started, else the
 * first reading during it (Codex's summarization request still carries the old
 * history); Claude's pre_tokens overrides. `after`: Claude's post_tokens, else
 * Codex's recomputed reading during it if lower than before, else the first
 * reading once it ended. `undefined` = still waiting, `null` = none came.
 */
export interface CompactionEntry {
  id: string;
  status: 'running' | 'done' | 'failed';
  before?: Usage;
  after?: Usage | null;
  /** latest reading while running: the after candidate */
  pending?: Usage;
  /** Codex's deprecated thread/compacted for this compaction was seen */
  legacySeen?: boolean;
}

export type Block =
  | { kind: 'reasoning'; id: string; content: string; streaming: boolean }
  | { kind: 'text'; id: string; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry }
  | { kind: 'compaction'; compaction: CompactionEntry };

type TextBlock = Extract<Block, { kind: 'reasoning' | 'text' }>;
type CompactionBlock = Extract<Block, { kind: 'compaction' }>;

/** One reasoning item (codex may emit several across a turn). */
export interface ReasoningItem {
  id: string;
  text: string;
}

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | 'retrying' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface SubagentRow {
  id: string;
  parentId?: string;
  name: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  steps: Array<{ stepId: string; title: string; status: 'running' | 'done' | 'failed'; kind?: ToolKind; detail?: string }>;
  result?: string;
  stoppable: boolean;
  stepCount: number;
  startedAt: number;
  endedAt?: number;
}

export interface RunState {
  awaitingSubagents?: true;
  subagents: SubagentRow[];
  startedAt?: number;
  completedAt?: number;
  /** reasoning + text + tool blocks in arrival order (text/tool interleave preserved) */
  blocks: Block[];
  /** reasoning items, keyed by id so deltas + final reconcile without dupes */
  reasoning: ReasoningItem[];
  reasoningActive: boolean;
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** set with {@link errorMsg}: the backend's own code, else guessed from the text */
  errorKind?: AgentErrorKind;
  /** set when terminal === 'idle_timeout' — seconds idle before watchdog gave up */
  idleTimeoutSeconds?: number;
  /** latest context-window usage (from context_usage events, or seeded from the
   * session's last reading); drives the meter at the top of the run card. */
  usage?: Usage;
}

export const initialState: RunState = {
  subagents: [],
  blocks: [],
  reasoning: [],
  reasoningActive: false,
  footer: 'thinking',
  terminal: 'running',
};

/** Joined reasoning text across all items (for the reasoning panel body). */
export function reasoningContent(state: RunState): string {
  return state.reasoning
    .map((r) => r.text)
    .filter((t) => t.trim())
    .join('\n\n');
}

/**
 * The agent's FINAL message — the content of the last non-empty text block.
 * Codex emits several agentMessage items per turn (progress/preamble messages
 * plus the actual answer); for a one-shot reply with no streaming UI (a
 * cloud-doc comment) we want only the last one, not all of them concatenated.
 * Returns '' if the turn produced no text.
 */
export function finalMessageText(state: RunState): string {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b && b.kind === 'text' && b.content.trim()) return b.content.trim();
  }
  return '';
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) => ((b.kind === 'text' || b.kind === 'reasoning') && b.streaming ? { ...b, streaming: false } : b));
}

function upsertText(blocks: Block[], id: string, mutate: (prev: string) => string, kind: 'text' | 'reasoning' = 'text'): Block[] {
  const idx = blocks.findIndex((b) => b.kind === kind && b.id === id);
  if (idx === -1) {
    return [...closeStreamingText(blocks), { kind, id, content: mutate(''), streaming: true }];
  }
  const prev = blocks[idx] as TextBlock;
  const next: Block = { ...prev, content: mutate(prev.content) };
  return [...blocks.slice(0, idx), next, ...blocks.slice(idx + 1)];
}

function upsertReasoning(items: ReasoningItem[], id: string, mutate: (prev: string) => string): ReasoningItem[] {
  const idx = items.findIndex((r) => r.id === id);
  if (idx === -1) return [...items, { id, text: mutate('') }];
  const prev = items[idx]!;
  const next: ReasoningItem = { id: prev.id, text: mutate(prev.text) };
  return [...items.slice(0, idx), next, ...items.slice(idx + 1)];
}

/** Fold one normalized AgentEvent into the run state (pure). */
export function reduce(state: RunState, evt: AgentEvent, now = Date.now()): RunState {
  switch (evt.type) {
    case 'text_delta':
      return {
        ...state,
        blocks: upsertText(state.blocks, evt.itemId, (prev) => prev + evt.delta),
        reasoningActive: false,
        footer: 'streaming',
      };

    case 'text': {
      // item/completed → the reconciled full text; replace the streamed buffer.
      const idx = state.blocks.findIndex((b) => b.kind === 'text' && b.id === evt.itemId);
      const blocks =
        idx === -1
          ? [...state.blocks, { kind: 'text', id: evt.itemId, content: evt.text, streaming: false } as Block]
          : [
              ...state.blocks.slice(0, idx),
              { kind: 'text', id: evt.itemId, content: evt.text, streaming: false } as Block,
              ...state.blocks.slice(idx + 1),
            ];
      return { ...state, blocks, reasoningActive: false };
    }

    case 'thinking_delta':
      return {
        ...state,
        blocks: upsertText(state.blocks, evt.itemId, (prev) => prev + evt.delta, 'reasoning'),
        reasoning: upsertReasoning(state.reasoning, evt.itemId, (prev) => prev + evt.delta),
        reasoningActive: true,
        footer: state.footer === 'streaming' ? state.footer : 'thinking',
      };

    case 'thinking':
      return {
        ...state,
        blocks: upsertText(state.blocks, evt.itemId, () => evt.text, 'reasoning').map(b =>
          b.kind === 'reasoning' && b.id === evt.itemId ? { ...b, streaming: false } : b),
        reasoning: upsertReasoning(state.reasoning, evt.itemId, () => evt.text),
      };

    case 'tool_use': {
      const existing = state.blocks.findIndex(b => b.kind === 'tool' && b.tool.id === evt.itemId);
      if (existing >= 0) {
        return {
          ...state,
          blocks: state.blocks.map((b, index) => index === existing && b.kind === 'tool'
            ? { ...b, tool: { ...b.tool, title: evt.title,
              detail: evt.detail ?? b.tool.detail, kind: evt.kind ?? b.tool.kind } }
            : b),
        };
      }
      const tool: ToolEntry = {
        id: evt.itemId,
        title: evt.title,
        detail: evt.detail,
        kind: evt.kind,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoningActive: false,
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const isError = evt.exitCode != null && evt.exitCode !== 0;
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.itemId) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: isError ? ('error' as const) : ('done' as const),
            output: evt.output,
            exitCode: evt.exitCode,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'subagent_start': {
      const rows = state.subagents ?? [];
      if (rows.some(row => row.id === evt.id)) return state;
      const row: SubagentRow = { id: evt.id, parentId: evt.parentId, name: evt.name,
        task: evt.task.slice(0, 120), status: 'running', steps: [], stepCount: 0, startedAt: now, stoppable: evt.stoppable };
      return { ...state, subagents: [...rows, row] };
    }

    case 'subagent_step':
      return { ...state, subagents: (state.subagents ?? []).map(row => {
        if (row.id !== evt.id) return row;
        if (evt.status === 'running') {
          if (row.steps.some(step => step.stepId === evt.stepId)) return row;
          return { ...row, stepCount: row.stepCount + 1, steps: [...row.steps, { stepId: evt.stepId, title: evt.title,
            status: evt.status, kind: evt.kind, detail: evt.detail }].slice(-5) };
        }
        return { ...row, steps: row.steps.map(step => step.stepId === evt.stepId
          ? { ...step, status: evt.status } : step) };
      }) };

    case 'subagent_status':
      return { ...state, subagents: (state.subagents ?? []).map(row => {
        if (row.id !== evt.id || row.status === 'stopped' || row.status === 'failed') return row;
        if (evt.status === 'running') return row.status === 'completed' ? { ...row, status: evt.status, endedAt: undefined } : row;
        return { ...row, status: evt.status, endedAt: row.endedAt ?? now, result: evt.result?.slice(0, 600) };
      }) };

    case 'awaiting_subagents':
      return { ...state, awaitingSubagents: true, footer: null };

    case 'context_usage': {
      const usage = { used: evt.usedTokens, window: evt.contextWindow };
      return { ...state, usage, blocks: noteUsage(onWindow(state.blocks, usage.window), usage) };
    }

    case 'compaction':
      return evt.phase === 'start' ? startCompaction(state, evt.itemId) : endCompaction(state, evt);

    case 'error':
      // willRetry: codex 瞬断后会自己重试 — NOT terminal. Flipping to the error
      // layout here flashes a fake "失败" (and drops the ⏹ button) that the next
      // event would revert; surface a retrying footer instead and let the
      // follow-up deltas overwrite it.
      if (evt.willRetry) {
        return { ...state, footer: 'retrying' };
      }
      return {
        ...state,
        terminal: 'error',
        subagents: closeSubagents(state, 'failed', now),
        errorMsg: evt.message,
        errorKind: evt.kind ?? errorKindFromText(evt.message),
        footer: null,
      };

    case 'done':
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoningActive: false,
        terminal: 'done',
        footer: null,
      };

    case 'system':
    case 'turn_started':
    case 'usage':
    case 'goal_update':
    case 'ask':
    case 'ask_cancelled':
      return state;
    default: {
      const exhaustive: never = evt;
      return exhaustive;
    }
  }
}

function lastCompaction(blocks: Block[], match: (c: CompactionEntry) => boolean): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind === 'compaction' && match(b.compaction)) return i;
  }
  return -1;
}

function compactionAt(blocks: Block[], idx: number): CompactionEntry {
  return (blocks[idx] as CompactionBlock).compaction;
}

function withCompaction(blocks: Block[], idx: number, next: CompactionEntry): Block[] {
  return blocks.map((b, i) => (i === idx ? { kind: 'compaction', compaction: next } : b));
}

function appendCompaction(blocks: Block[], entry: CompactionEntry): Block[] {
  return [...closeStreamingText(blocks), { kind: 'compaction', compaction: entry }];
}

function startCompaction(state: RunState, itemId: string | undefined): RunState {
  const id = itemId ?? `compaction${state.blocks.length}`;
  // A repeated start (same item, or another Claude 'compacting' status) is the same compaction.
  if (lastCompaction(state.blocks, (c) => c.id === id || (itemId === undefined && c.status === 'running')) >= 0) return state;
  const entry: CompactionEntry = { id, status: 'running', ...(state.usage ? { before: state.usage } : {}) };
  return { ...state, blocks: appendCompaction(state.blocks, entry) };
}

function endCompaction(state: RunState, evt: Extract<AgentEvent, { type: 'compaction' }>): RunState {
  const window = evt.contextWindow ?? state.usage?.window ?? null;
  const counted = (used: number | undefined): Usage | undefined => (used === undefined ? undefined : { used, window });
  let idx = evt.itemId === undefined ? -1 : lastCompaction(state.blocks, (c) => c.id === evt.itemId);
  if (idx < 0) idx = lastCompaction(state.blocks, (c) => c.status === 'running');
  // Codex versions that still send thread/compacted send it after the item's end.
  if (idx < 0 && evt.legacy) idx = lastCompaction(state.blocks, (c) => !c.legacySeen);
  const found = idx < 0 ? undefined : compactionAt(state.blocks, idx);
  if (found && found.status !== 'running') {
    return evt.legacy ? { ...state, blocks: withCompaction(state.blocks, idx, { ...found, legacySeen: true }) } : state;
  }
  // An end with no start on this card gets its own line.
  const prev: CompactionEntry = found ?? { id: evt.itemId ?? `compaction${state.blocks.length}`, status: 'running' };
  const before = counted(evt.preTokens) ?? prev.before;
  const reported = counted(evt.postTokens);
  const recomputed = prev.pending && before && prev.pending.used < before.used ? prev.pending : undefined;
  const after = reported ?? recomputed;
  const { pending: _pending, ...rest } = prev;
  const next: CompactionEntry = {
    ...rest,
    status: evt.failed ? 'failed' : 'done',
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(evt.legacy ? { legacySeen: true } : {}),
  };
  const blocks = found ? withCompaction(state.blocks, idx, next) : appendCompaction(state.blocks, next);
  return { ...state, ...(reported ? { usage: reported } : {}), blocks };
}

/** A reading's window becomes the window of the run's compaction lines. On a
 * Claude thread's first turn the mid-turn window is a guess from the model id
 * until the turn-end getContextUsage(); this way the lines end on the same window
 * as the meter. A reading with no window leaves them. */
function onWindow(blocks: Block[], window: number | null): Block[] {
  if (window === null) return blocks;
  const moved = (u: Usage | null | undefined): boolean => !!u && u.window !== window;
  return blocks.map((b) => {
    if (b.kind !== 'compaction') return b;
    const c = b.compaction;
    if (!moved(c.before) && !moved(c.after) && !moved(c.pending)) return b;
    const next: CompactionEntry = {
      ...c,
      ...(c.before ? { before: { ...c.before, window } } : {}),
      ...(c.after ? { after: { ...c.after, window } } : {}),
      ...(c.pending ? { pending: { ...c.pending, window } } : {}),
    };
    return { kind: 'compaction', compaction: next };
  });
}

/** A usage reading goes to the latest compaction: while it runs, as `before`
 * (if none) or the after candidate; once done, as `after` if still missing. */
function noteUsage(blocks: Block[], usage: Usage): Block[] {
  const idx = lastCompaction(blocks, () => true);
  if (idx < 0) return blocks;
  const c = compactionAt(blocks, idx);
  if (c.status === 'running') {
    return withCompaction(blocks, idx, c.before ? { ...c, pending: usage } : { ...c, before: usage });
  }
  if (c.status === 'done' && c.after === undefined) {
    return withCompaction(blocks, idx, { ...c, after: !c.before || usage.used < c.before.used ? usage : null });
  }
  return blocks;
}

function closeSubagents(state: RunState, status: 'stopped' | 'failed', now: number): SubagentRow[] {
  return (state.subagents ?? []).map(row => row.status === 'running' ? { ...row, status, endedAt: row.endedAt ?? now } : row);
}

export function markInterrupted(state: RunState, now = Date.now()): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoningActive: false,
    terminal: 'interrupted',
    subagents: closeSubagents(state, 'stopped', now),
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, seconds: number, now = Date.now()): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoningActive: false,
    terminal: 'idle_timeout',
    subagents: closeSubagents(state, 'stopped', now),
    footer: null,
    idleTimeoutSeconds: seconds,
  };
}

export function finalizeIfRunning(state: RunState, now = Date.now()): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoningActive: false,
    terminal: 'done',
    subagents: closeSubagents(state, 'failed', now),
    footer: null,
  };
}
