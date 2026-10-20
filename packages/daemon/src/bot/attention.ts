import type { GroupAttention } from '@vonvon/protocol';
import type { JudgeResult } from '../judge/types';

export interface AttentionParams {
  places: number;
  intervalsMs: readonly number[];
  exitIntervalMs: number;
  quietMs: number;
  batch: number;
  overdueMs: number;
  lullMs: number;
  mainFocusMs: number;
  mainMisses: number;
  topicMisses: number;
  windowMs: number;
}

export const ATTENTION_DEFAULTS: Readonly<AttentionParams> = Object.freeze({
  places: 200,
  intervalsMs: Object.freeze([60_000, 180_000, 300_000]),
  exitIntervalMs: 180_000,
  quietMs: 20_000,
  batch: 10,
  overdueMs: 60_000,
  lullMs: 300_000,
  mainFocusMs: 600_000,
  mainMisses: 3,
  topicMisses: 5,
  windowMs: 600_000,
});

export type AttentionMode = 'focus' | 'watch';
/** Whether this judgement came from a hard signal, focus, or a periodic glance. */
export type LookKind = 'signal' | 'focus' | 'glance';
export type LookOutcome = 'reply' | 'skip' | 'error';

/** The main area's place is its chatId; a topic's place is its topic ID. */
export interface PlaceRef { chatId: string; place: string }

export interface PlaceView {
  chatId: string;
  topic: boolean;
  mode: AttentionMode;
  intervalMs: number;
  lookedAt?: number;
  arrivedAt?: number;
  repliedAt?: number;
  misses: number;
}

/** In-memory attention for one bot. All times come from the caller. */
export class Attention {
  private readonly params: AttentionParams;
  /** Oldest use first. Reads never change this order. */
  private readonly places = new Map<string, PlaceView>();
  private readonly prompts = new Map<string, string>();

  private observer?: (groups: GroupAttention[]) => void;

  observe(observer: (groups: GroupAttention[]) => void): void { this.observer = observer; this.changed(); }

  snapshot(): GroupAttention[] {
    const groups = new Map<string, GroupAttention>();
    for (const state of this.places.values()) {
      const group = groups.get(state.chatId) ?? { groupId: state.chatId, focusedTopics: 0, watchedTopics: 0 };
      if (!state.topic) group.main = { mode: state.mode, intervalMs: state.intervalMs };
      else if (state.mode === 'focus') group.focusedTopics++;
      else group.watchedTopics++;
      groups.set(state.chatId, group);
    }
    return [...groups.values()];
  }

  private changed(): void { this.observer?.(this.snapshot()); }

  constructor(params: Partial<AttentionParams> = {}) {
    const intervalsMs = [...(params.intervalsMs ?? ATTENTION_DEFAULTS.intervalsMs)];
    if (!intervalsMs.length || intervalsMs.some((value, index) =>
      !Number.isFinite(value) || (index > 0 && !(value > intervalsMs[index - 1]!)))) {
      throw new RangeError('Attention intervals must be strictly increasing');
    }
    this.params = { ...ATTENTION_DEFAULTS, ...params, intervalsMs };
  }

  private touch(ref: PlaceRef, create: boolean): PlaceView | undefined {
    let place = this.places.get(ref.place);
    if (!place && !create) return undefined;
    this.places.delete(ref.place);
    place ??= {
      chatId: ref.chatId,
      topic: ref.place !== ref.chatId,
      mode: 'watch',
      intervalMs: this.params.intervalsMs[0]!,
      misses: 0,
    };
    this.places.set(ref.place, place);
    while (this.places.size > this.params.places && this.places.size > 0) {
      const oldest = this.places.keys().next().value;
      if (oldest === undefined) break;
      this.places.delete(oldest);
    }
    return place;
  }

  arrive(ref: PlaceRef, now: number, opts: { mine?: boolean } = {}): AttentionMode {
    const fresh = !this.places.has(ref.place);
    const place = this.touch(ref, true)!;
    if (fresh) {
      if (place.topic && opts.mine) place.mode = 'focus';
      place.arrivedAt = now;
      this.changed();
      return place.mode;
    }
    if (!place.topic && place.mode === 'focus' && place.repliedAt !== undefined
      && now - place.repliedAt > this.params.mainFocusMs) {
      place.mode = 'watch';
      place.intervalMs = this.params.exitIntervalMs;
      place.misses = 0;
    }
    if (place.mode === 'watch' && place.arrivedAt !== undefined
      && now - place.arrivedAt >= this.params.lullMs) {
      place.intervalMs = this.params.intervalsMs[0]!;
    }
    place.arrivedAt = Math.max(place.arrivedAt ?? now, now);
    this.changed();
    return place.mode;
  }

  /** Earliest time to glance, never earlier than now. Pending is oldest first. */
  due(place: string, pending: readonly number[], now: number): number | undefined {
    if (!pending.length) return undefined;
    const state = this.places.get(place);
    if (state?.mode === 'focus' || pending.length >= this.params.batch) return now;
    const interval = state?.intervalMs ?? this.params.intervalsMs[0]!;
    const last = Math.max(state?.arrivedAt ?? -Infinity, pending[pending.length - 1]!);
    const quiet = Math.max(last + this.params.quietMs,
      state?.lookedAt === undefined ? -Infinity : state.lookedAt + interval);
    const overdue = pending[0]! + interval + this.params.overdueMs;
    return Math.max(now, Math.min(quiet, overdue));
  }

  glanced(ref: PlaceRef, now: number): void {
    this.touch(ref, true)!.lookedAt = now;
    this.changed();
  }

  private focus(place: PlaceView, now: number): void {
    place.mode = 'focus';
    place.intervalMs = this.params.intervalsMs[0]!;
    place.misses = 0;
    place.repliedAt = now;
    this.changed();
  }

  verdict(ref: PlaceRef, kind: LookKind, outcome: LookOutcome, now: number): void {
    const place = this.touch(ref, outcome === 'reply');
    if (!place) return;
    if (outcome === 'reply') {
      this.focus(place, now);
      return;
    }
    if (outcome === 'error') return;
    if (place.mode === 'focus') {
      if (kind === 'glance') return;
      place.misses++;
      if (place.misses >= (place.topic ? this.params.topicMisses : this.params.mainMisses)) {
        place.mode = 'watch';
        place.intervalMs = this.params.exitIntervalMs;
        place.misses = 0;
      }
      this.changed();
      return;
    }
    if (kind === 'signal') {
      place.intervalMs = this.params.intervalsMs[0]!;
    } else if (kind === 'glance') {
      place.intervalMs = this.params.intervalsMs.find(interval => interval > place.intervalMs) ?? place.intervalMs;
    }
    this.changed();
  }

  /** This bot successfully started a turn in this place. */
  replied(ref: PlaceRef, now: number): void {
    this.focus(this.touch(ref, true)!, now);
  }

  /** Freeze an existing focused place into watch without changing its reply time. */
  freeze(ref: PlaceRef, _now: number): boolean {
    const place = this.touch(ref, false);
    if (!place || place.mode !== 'focus') return false;
    place.mode = 'watch';
    place.intervalMs = this.params.exitIntervalMs;
    place.misses = 0;
    this.changed();
    return true;
  }

  state(place: string): PlaceView | undefined {
    const value = this.places.get(place);
    return value ? { ...value } : undefined;
  }

  forget(chatId: string): void {
    for (const [place, state] of this.places) {
      if (state.chatId === chatId) this.places.delete(place);
    }
    this.changed();
  }

  /** A changed smart prompt resets only this group's attention, not its hash. */
  notePrompt(chatId: string, hash: string): boolean {
    const previous = this.prompts.get(chatId);
    this.prompts.delete(chatId);
    this.prompts.set(chatId, hash);
    while (this.prompts.size > this.params.places && this.prompts.size > 0) {
      const oldest = this.prompts.keys().next().value;
      if (oldest === undefined) break;
      this.prompts.delete(oldest);
    }
    if (previous === undefined || previous === hash) return false;
    this.forget(chatId);
    return true;
  }

  /** Keep the latest batch of recent arrivals; leave everything else as context. */
  pickGlance<T extends { at: number }>(pending: readonly T[], now: number): { look: T[]; old: T[] } {
    const eligible = pending.map((item, index) => ({ item, index }))
      .filter(({ item }) => now - item.at <= this.params.windowMs)
      .sort((a, b) => b.item.at - a.item.at || b.index - a.index)
      .slice(0, this.params.batch);
    const chosen = new Set(eligible.map(({ index }) => index));
    const look: T[] = [];
    const old: T[] = [];
    pending.forEach((item, index) => (chosen.has(index) ? look : old).push(item));
    return { look, old };
  }
}

export function outcomeOf(result: Pick<JudgeResult, 'decision' | 'error'>): LookOutcome {
  if (result.error) return 'error';
  return result.decision === 'skip' ? 'skip' : 'reply';
}
