import { card, colorNote, note, noteMd, type CardElement, type CardObject, type NoteColor } from './cards';
import type { CompactionEntry, Usage } from './run-state';

/**
 * Context-window usage gauge. Every run card opens with a one-line meter (s12),
 * grey below the first tier and tier-colored above it; both backends compact on
 * their own, so it carries no `/compact` nudge. The same tiers back the on-demand
 * `/context` card. Codex numbers come from `thread/tokenUsage/updated` (used =
 * last.totalTokens — the current context occupancy, NOT cumulative total;
 * window = modelContextWindow), Claude's from the request usage and
 * getContextUsage(). Thresholds are fractions of the window — tune here.
 */
export const CTX_WARN = 0.7; // 🟡 first colored tier
export const CTX_HIGH = 0.85; // 🟠
export const CTX_CRIT = 0.95; // 🔴

export interface CtxTier {
  /** 0 = below WARN (grey meter); 1/2/3 = yellow/orange/red */
  level: 0 | 1 | 2 | 3;
  color: NoteColor;
  /** colored dot — the reliable cross-client color signal */
  dot: string;
  /** `/compact` nudge ('' at level 0) */
  advice: string;
}

/** Tier for a usage fraction (used/window, 0..1+). */
export function ctxTier(frac: number): CtxTier {
  if (frac >= CTX_CRIT) return { level: 3, color: 'red', dot: '🔴', advice: '强烈建议 `/compact` 压缩' };
  if (frac >= CTX_HIGH) return { level: 2, color: 'orange', dot: '🟠', advice: '建议 `/compact` 压缩' };
  if (frac >= CTX_WARN) return { level: 1, color: 'yellow', dot: '🟡', advice: '可考虑 `/compact` 压缩' };
  return { level: 0, color: 'green', dot: '🟢', advice: '' };
}

/** Usage as a whole percent (capped 0..100), or null when window is unknown. */
export function ctxPercent(used: number, window: number | null): number | null {
  if (!window || window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / window) * 100)));
}

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n)));
}

/**
 * The meter line at the top of every run card. Before the session's first
 * reading it shows `上下文 —` so the card doesn't jump when the number lands;
 * with no window it shows the tokens used.
 */
export function runCardMeter(usage: Usage | undefined): CardElement {
  if (!usage) return colorNote('上下文 —', 'grey');
  const pct = ctxPercent(usage.used, usage.window);
  if (pct === null || !usage.window) return colorNote(`上下文 已用 ${k(usage.used)}`, 'grey');
  const t = ctxTier(usage.used / usage.window);
  const text = `上下文 ${pct}% · ${k(usage.used)}/${k(usage.window)}`;
  return t.level === 0 ? colorNote(text, 'grey') : colorNote(`${t.dot} ${text}`, t.color);
}

/** The process-area line for one compaction, e.g. `已压缩 85% → 20%`. Both ends
 * share one window; without a window they show tokens. `live`: the run is still
 * going, so an unfinished compaction reads as in progress. */
export function compactionLine(c: CompactionEntry, live: boolean): CardElement {
  return noteMd(`<font color='grey'>🗜️ ${compactionText(c, live)}</font>`);
}

function compactionText(c: CompactionEntry, live: boolean): string {
  if (c.status === 'failed') return '上下文压缩失败';
  if (c.status === 'running') return live ? '正在压缩上下文…' : '上下文压缩没有完成';
  const window = c.before?.window ?? c.after?.window ?? null;
  const at = (u: Usage): string => {
    const pct = ctxPercent(u.used, window);
    return pct === null ? k(u.used) : `${pct}%`;
  };
  if (c.before && c.after) return `已压缩 ${at(c.before)} → ${at(c.after)}`;
  if (c.before) return `已压缩，压缩前 ${at(c.before)}`;
  if (c.after) return `已压缩，现在 ${at(c.after)}`;
  return '已压缩上下文';
}

/** On-demand `/context` card — always shows, even at low usage. */
export function buildContextCard(used: number, window: number | null): CardObject {
  const pct = ctxPercent(used, window);
  if (pct === null) {
    const line = used > 0 ? `🧠 已用 ${k(used)} tokens（上下文窗口未知）` : '🧠 还没有用量数据，跑一轮对话后再看 `/context`。';
    return card([note(line)], { summary: '上下文用量' });
  }
  const t = ctxTier(used / window!);
  const els: CardElement[] = [colorNote(`${t.dot} **上下文 ${pct}%** · ${k(used)}/${k(window!)} tokens`, t.color)];
  els.push(note(t.level >= 1 ? `${t.advice}：总结早前对话、释放空间。` : '空间充足，无需压缩。'));
  return card(els, { summary: '上下文用量' });
}

/** Spinner frames for the "压缩中" card — a rotating half-filled circle the
 * caller cycles by re-rendering with an incrementing tick, so the card visibly
 * keeps working instead of looking stuck. */
const COMPACT_SPINNER = ['◐', '◓', '◑', '◒'];

/**
 * Manual `/compact` card — sent as a managed entity in the "压缩中" state, then
 * re-rendered in place at an incrementing `tick` (rotating spinner ⇒ liveness)
 * until codex's background compaction turn finishes (it's not instant), at which
 * point it flips to {@link buildCompactedCard} / {@link buildCompactFailedCard}.
 */
export function buildCompactingCard(tick = 0): CardObject {
  const spin = COMPACT_SPINNER[((tick % COMPACT_SPINNER.length) + COMPACT_SPINNER.length) % COMPACT_SPINNER.length];
  return card([colorNote(`🗜️ 正在压缩上下文 ${spin}`, 'blue'), note('总结早前对话、释放空间，请稍候。')], {
    summary: '正在压缩上下文',
  });
}

/**
 * Terminal "压缩完成" state. `usage` is the post-compaction occupancy (from
 * `last`), `before` the pre-compaction reading. We only print a number when it
 * actually dropped (showing 旧% → 新%): codex sometimes only surfaces the reduced
 * context on the *next* turn, so a stale, unchanged number would just look broken
 * — in that case say the reduction lands on the next message instead.
 */
export function buildCompactedCard(
  usage: { usedTokens: number; contextWindow: number | null } | null,
  before?: { used: number; window: number | null } | null,
): CardObject {
  const els: CardElement[] = [colorNote('✅ 上下文压缩完成', 'green')];
  const pct = usage ? ctxPercent(usage.usedTokens, usage.contextWindow) : null;
  const dropped = usage != null && before != null && usage.usedTokens < before.used;
  if (usage && pct !== null && usage.contextWindow && (dropped || before == null)) {
    const beforePct = before ? ctxPercent(before.used, before.window) : null;
    const from = dropped && beforePct !== null ? `${beforePct}% → ` : '';
    els.push(note(`早前对话已总结归档，现已用 ${from}${pct}%（${k(usage.usedTokens)}/${k(usage.contextWindow)} tokens）。`));
  } else {
    els.push(note('早前对话已总结归档、腾出空间继续；发下一条消息后，`/context` 即可看到占用下降。'));
  }
  return card(els, { summary: '上下文压缩完成' });
}

/** Terminal "压缩失败" state of the manual `/compact` card. */
export function buildCompactFailedCard(message: string): CardObject {
  return card([colorNote(`⚠️ 压缩失败：${message}`, 'red')], { summary: '压缩失败' });
}
