import { z } from 'zod';
import { log } from '../../core/logger';
import { codexErrorKind } from '../error-kind';
import type { AgentEvent } from '../types';
import type { FileUpdateChange, ServerNotification, ThreadItem } from './protocol';

/** Files named in a fileChange title before collapsing to `等 N 个文件`. */
const TITLE_FILES_MAX = 2;
/**
 * Cap on the rendered diff body. Pre-fenced output bypasses the card layer's
 * OUTPUT_MAX belt (re-truncating would cut the closing fence), so the diff
 * caps itself here — same budget, and the fenced block stays well under the
 * card layer's BODY_TOTAL_MAX.
 */
const DIFF_MAX = 1200;
/** Without a known cwd, an absolute path longer than this keeps only its
 * trailing segments (`…/dir/file.ts`) so the tool title stays one line. */
const PATH_TAIL_MAX = 40;

/**
 * Optional mapping context. `cwd` — the thread's project working directory —
 * relativizes fileChange title paths (a path OUTSIDE cwd stays absolute on
 * purpose: the user should see the agent touched something out of the
 * project). Callers that don't know the cwd omit it; titles then fall back to
 * a tail-segment shortening for length control.
 */
export interface MapContext {
  cwd?: string;
}

/**
 * Map one app-server ServerNotification to a normalized AgentEvent.
 * Returns null for notifications we don't surface (M1 subset).
 *
 * Streaming: token-level deltas via item/agentMessage/delta &
 * item/reasoning/textDelta; item/completed gives the final text for
 * reconciliation; commandExecution/fileChange map to tool blocks.
 */
// 0.156.1 code-mode models emit this item instead of collab spawn notifications.
const subAgentActivity = z.object({ type: z.literal('subAgentActivity'), id: z.string(), kind: z.string(), agentThreadId: z.string(), agentPath: z.string() });
const threadSpawn = z.object({ thread_spawn: z.object({ parent_thread_id: z.string(), agent_nickname: z.string().nullish(), agent_role: z.string().nullish() }) });
const subagentSource = z.union([z.object({ subagent: threadSpawn }), z.object({ subAgent: threadSpawn })]);
export function readSubagentSpawn(source: unknown) {
  const parsed = subagentSource.safeParse(source);
  if (!parsed.success) return undefined;
  return 'subagent' in parsed.data ? parsed.data.subagent.thread_spawn : parsed.data.subAgent.thread_spawn;
}

export function readSubAgentActivity(item: unknown) {
  const parsed = subAgentActivity.safeParse(item);
  return parsed.success ? parsed.data : undefined;
}

export function mapNotification(n: ServerNotification, ctx?: MapContext): AgentEvent | null {
  if (n.method === 'item/started' || n.method === 'item/completed') {
    const activity = readSubAgentActivity(n.params.item);
    if (activity) return activity.kind !== 'started' ? null : n.method === 'item/started'
      ? { type: 'tool_use', itemId: activity.id, title: `子 agent：${activity.agentPath.split('/').pop() ?? '子 agent'}`, kind: 'tool' }
      : { type: 'tool_result', itemId: activity.id };
  }
  switch (n.method) {
    case 'thread/started':
      return { type: 'system', threadId: n.params.thread.id };
    case 'turn/started':
      return { type: 'turn_started', turnId: n.params.turn.id };
    case 'item/agentMessage/delta':
      return { type: 'text_delta', itemId: n.params.itemId, delta: n.params.delta };
    case 'item/reasoning/textDelta':
      return { type: 'thinking_delta', itemId: n.params.itemId, delta: n.params.delta };
    case 'item/started':
      return mapItemStart(n.params.item, ctx);
    case 'item/completed':
      return mapItemComplete(n.params.item);
    case 'thread/tokenUsage/updated':
      // `last` (most recent turn), NOT `total` (cumulative session sum). `total`
      // only ever grows — it can exceed the window and never drops after a
      // /compact — so it's wrong for a "how full is the context right now" gauge.
      // `last.totalTokens` is the size of the latest request's context, which is
      // what gets re-sent next turn and what shrinks once compaction takes hold.
      return {
        type: 'context_usage',
        usedTokens: n.params.tokenUsage.last.totalTokens,
        contextWindow: n.params.tokenUsage.modelContextWindow,
      };
    case 'thread/compacted':
      // Deprecated; codex main no longer sends it to v2 clients. Where it still
      // comes, it repeats a contextCompaction item's end (the run state dedupes).
      return { type: 'compaction', phase: 'end', legacy: true };
    case 'turn/completed':
      return { type: 'done', turnId: n.params.turn.id };
    case 'thread/goal/updated': {
      const g = n.params.goal;
      return {
        type: 'goal_update',
        status: g.status,
        objective: g.objective,
        tokensUsed: g.tokensUsed,
        timeUsedSeconds: g.timeUsedSeconds,
        tokenBudget: g.tokenBudget,
      };
    }
    // thread/goal/cleared — we clear goals ourselves; nothing to surface.
    case 'error':
      return {
        type: 'error',
        message: n.params.error.message,
        willRetry: n.params.willRetry,
        kind: codexErrorKind(n.params.error.codexErrorInfo),
      };
    default:
      return null;
  }
}

function mapItemStart(item: ThreadItem, ctx?: MapContext): AgentEvent | null {
  switch (item.type) {
    case 'collabAgentToolCall':
      return { type: 'tool_use', itemId: item.id, title: item.tool === 'wait' ? '等子 agent' : item.tool === 'closeAgent' ? '关子 agent' : `子 agent：${(item.prompt ?? '').slice(0, 40)}`, kind: 'tool' };
    case 'commandExecution':
      return { type: 'tool_use', itemId: item.id, title: item.command, detail: String(item.cwd), kind: 'command' };
    case 'fileChange':
      return { type: 'tool_use', itemId: item.id, title: fileChangeTitle(item.changes, ctx?.cwd), kind: 'file' };
    case 'webSearch':
      return {
        type: 'tool_use',
        itemId: item.id,
        title: item.query ? `联网搜索：${item.query}` : '联网搜索',
        kind: 'search',
      };
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        itemId: item.id,
        title: `mcp__${item.server}__${item.tool}`,
        detail: JSON.stringify(item.arguments, null, 2),
        kind: 'tool',
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_use',
        itemId: item.id,
        title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        detail: JSON.stringify(item.arguments, null, 2),
        kind: 'tool',
      };
    case 'contextCompaction':
      return { type: 'compaction', phase: 'start', itemId: item.id };
    default:
      return null;
  }
}

function mapItemComplete(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case 'collabAgentToolCall':
      return { type: 'tool_result', itemId: item.id, exitCode: item.status === 'failed' ? 1 : undefined };
    case 'agentMessage':
      return { type: 'text', itemId: item.id, text: item.text };
    case 'reasoning': {
      const text = item.content.length ? item.content.join('\n') : item.summary.join('\n');
      return { type: 'thinking', itemId: item.id, text };
    }
    case 'commandExecution':
      return {
        type: 'tool_result',
        itemId: item.id,
        output: item.aggregatedOutput ?? undefined,
        exitCode: item.exitCode,
      };
    case 'fileChange':
      return { type: 'tool_result', itemId: item.id, output: fileChangeDiffMd(item.changes) };
    case 'webSearch':
      return { type: 'tool_result', itemId: item.id };
    case 'mcpToolCall':
      return {
        type: 'tool_result',
        itemId: item.id,
        output: item.error
          ? JSON.stringify({ result: item.result, error: item.error }, null, 2)
          : item.result === null ? undefined : JSON.stringify(item.result, null, 2),
        exitCode: item.status === 'failed' || item.error !== null ? 1 : undefined,
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_result',
        itemId: item.id,
        output: item.contentItems?.map((content) => content.type === 'inputText'
          ? content.text : JSON.stringify(content)).join('\n'),
        exitCode: item.status === 'failed' || item.success === false ? 1 : undefined,
      };
    case 'contextCompaction':
      return { type: 'compaction', phase: 'end', itemId: item.id };
    default:
      return null;
  }
}

/**
 * Per-kind `diff` field semantics (verified against codex rust-v0.139.0,
 * app-server-protocol/src/protocol/item_builders.rs `format_file_change_diff`):
 *   - add    → the RAW new-file content（无 +/- 前缀，不是 unified diff）
 *   - delete → the RAW deleted content（同上）
 *   - update → a unified diff（rename 时尾附 `Moved to: <path>`）
 * 行前缀计数/红绿渲染对 add/delete 不成立，必须按 kind 分流。
 */
type ChangeKind = 'add' | 'delete' | 'update';

/** Change kind off the wire（serde tag → `{type:'add'|'delete'|'update'}`）；
 * tolerate a bare string and default to 'update'（旧形态/防御）。 */
function changeKind(c: FileUpdateChange): ChangeKind {
  const k = c.kind as unknown;
  const t = typeof k === 'string' ? k : (k as { type?: string } | null)?.type;
  return t === 'add' || t === 'delete' ? t : 'update';
}

/** Lines in a raw-content `diff` field（add/delete）— one trailing newline
 * doesn't count as an extra line; empty content is 0 lines. */
function contentLineCount(content: string): number {
  if (!content) return 0;
  return content.replace(/\n$/, '').split('\n').length;
}

/** +/− line counts for one change, kind-aware（见 {@link changeKind} 上方注释）。 */
function countChange(c: FileUpdateChange): { adds: number; dels: number } {
  const kind = changeKind(c);
  if (kind === 'add') return { adds: contentLineCount(c.diff), dels: 0 };
  if (kind === 'delete') return { adds: 0, dels: contentLineCount(c.diff) };
  let adds = 0;
  let dels = 0;
  for (const line of c.diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) adds++;
    else if (line.startsWith('-') && !line.startsWith('---')) dels++;
  }
  return { adds, dels };
}

/** Title path: relative inside cwd / absolute outside it（看得出越界）；no cwd →
 * long paths keep only trailing segments within {@link PATH_TAIL_MAX}. */
function displayPath(p: string, cwd?: string): string {
  if (cwd) {
    const sep = cwd.includes('\\') ? '\\' : '/';
    const root = cwd.endsWith(sep) ? cwd : cwd + sep;
    return p.startsWith(root) && p.length > root.length ? p.slice(root.length) : p;
  }
  if (p.length <= PATH_TAIL_MAX || !p.includes('/')) return p;
  const segs = p.split('/');
  let out = segs[segs.length - 1]!;
  for (let i = segs.length - 2; i >= 0; i--) {
    const cand = `${segs[i]}/${out}`;
    if (cand.length > PATH_TAIL_MAX) break;
    out = cand;
  }
  return `…/${out}`;
}

/** `新建 foo.md (+3)` / `删除 foo.md` / `编辑 src/foo.ts (+12 −3)` — verb by
 * kind（全 add→新建、全 delete→删除、其余→编辑）；multi-file lists the first N
 * paths + a count, +/− aggregate kind-aware over every file. Falls back to the
 * old fixed label when codex sent no changes. */
function fileChangeTitle(changes: FileUpdateChange[] | undefined, cwd?: string): string {
  if (!changes?.length) return '编辑文件';
  let adds = 0;
  let dels = 0;
  const kinds = new Set<ChangeKind>();
  for (const c of changes) {
    kinds.add(changeKind(c));
    const n = countChange(c);
    adds += n.adds;
    dels += n.dels;
  }
  const verb = kinds.size > 1 ? '编辑' : kinds.has('add') ? '新建' : kinds.has('delete') ? '删除' : '编辑';
  const names = changes.slice(0, TITLE_FILES_MAX).map((c) => displayPath(c.path, cwd)).join('、');
  const files = changes.length > TITLE_FILES_MAX ? `${names} 等 ${changes.length} 个文件` : names;
  // 删除不报行数；新建只报 +N；编辑报 +N −M。
  const suffix = verb === '删除' ? '' : verb === '新建' ? ` (+${adds})` : ` (+${adds} −${dels})`;
  return `${verb} ${files}${suffix}`;
}

/** Renderable diff body for ONE change: add/delete carry raw content（见
 * {@link changeKind} 上方注释）→ synthesize +/− prefixed lines so the ```diff
 * fence shows real red/green; update is already a unified diff, pass through. */
function changeDiffBody(c: FileUpdateChange): string {
  const kind = changeKind(c);
  if (kind === 'update') return c.diff;
  const content = c.diff.replace(/\n$/, '');
  if (!content) return '';
  const prefix = kind === 'add' ? '+' : '-';
  return content
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** The changes as ONE pre-fenced ```diff block (truncated at {@link DIFF_MAX}).
 * The card layer passes pre-fenced output through as-is, so Feishu's diff
 * highlighting (red/green lines) survives. Multi-file chunks get a diff-native
 * `diff --git` header so each file stays identifiable inside the block. */
function fileChangeDiffMd(changes: FileUpdateChange[] | undefined): string | undefined {
  if (!changes?.length) return undefined;
  const joined = changes
    .map((c) => {
      const body = changeDiffBody(c);
      return changes.length > 1 ? `diff --git a/${c.path} b/${c.path}\n${body}` : body;
    })
    .join('\n')
    .replace(/\n+$/, '');
  if (!joined.trim()) return undefined; // e.g. 新建空文件 — 没有可渲染的 diff
  const cut = joined.length > DIFF_MAX;
  const body = cut ? `${joined.slice(0, DIFF_MAX)}…` : joined;
  const note = cut ? `\n_（已截断，完整 diff ${joined.length} 字符）_` : '';
  return `\`\`\`diff\n${body}\n\`\`\`${note}`;
}


export interface Child {
  closed?: boolean;
  stopRequested?: boolean;
  parentId?: string;
  turnId?: string;
  running: boolean;
  nickname?: string;
  role?: string;
  result?: string;
}

/** Child activity never becomes a parent text, error or done event. */
export function mapChildNotification(id: string, n: ServerNotification, child: Child): { events: AgentEvent[]; patch?: Partial<Child> } {
  switch (n.method) {
    case 'turn/started':
      return { events: [{ type: 'subagent_status', id, status: 'running' }], patch: { turnId: n.params.turn.id, running: true, closed: false, result: undefined } };
    case 'turn/completed':
      return { events: [{ type: 'subagent_status', id, status: n.params.turn.status === 'interrupted' ? 'stopped' : n.params.turn.status === 'failed' ? 'failed' : 'completed', result: child.result }], patch: { running: false, stopRequested: false } };
    case 'thread/closed':
      return { events: child.running ? [{ type: 'subagent_status', id, status: 'stopped' }] : [], patch: { running: false, closed: true, stopRequested: false } };
    case 'error':
      log.warn('agent', 'subagent-error', { id: id.slice(-6) });
      return { events: [] };
    case 'item/started':
    case 'item/completed': {
      const item = n.params.item;
      if (n.method === 'item/completed' && item.type === 'agentMessage') return { events: [], patch: { result: item.text.slice(0, 600) } };
      if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) return { events: [] };
      const ev = n.method === 'item/started' ? mapItemStart(item) : mapItemComplete(item);
      if (ev?.type === 'tool_use') return { events: [{ type: 'subagent_step', id, stepId: item.id, title: ev.title, status: 'running' }] };
      if (ev?.type === 'tool_result') return { events: [{ type: 'subagent_step', id, stepId: item.id, title: '', status: ev.exitCode != null && ev.exitCode !== 0 ? 'failed' : 'done' }] };
      return { events: [] };
    }
    default:
      return { events: [] };
  }
}
