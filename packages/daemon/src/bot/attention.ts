import type { GroupAttention } from '@vonvon/protocol';
import type { JudgeResult } from '../judge/types';

export interface AttentionParams {
  places: number;
  intervalsMs: readonly number[];
  quietMs: number;
  batch: number;
  overdueMs: number;
  lullMs: number;
  windowMs: number;
  focusBatchMs: number;
  followupMs: number;
  decayMs: readonly number[];
}

export const ATTENTION_DEFAULTS: Readonly<AttentionParams> = Object.freeze({
  places: 200,
  intervalsMs: Object.freeze([60_000, 180_000, 300_000]),
  quietMs: 20_000,
  batch: 10,
  overdueMs: 60_000,
  lullMs: 300_000,
  windowMs: 600_000,
  focusBatchMs: 5_000,
  followupMs: 120_000,
  decayMs: Object.freeze([120_000, 600_000, 1_200_000, 1_800_000]),
});

type AttentionScore = 10 | 25 | 50 | 75 | 100;
export type AttentionMode = 'focus' | 'watch';
export type LookKind = 'signal' | 'focus' | 'glance';
export type LookOutcome = 'reply' | 'skip' | 'error';
export interface PlaceRef { chatId: string; place: string }

declare const attentionTicket: unique symbol;
/** An opaque, one-reply capability. It cannot pick up a later reply's shortcut. */
export interface AttentionTicket { readonly [attentionTicket]: true }
declare const attentionGroupToken: unique symbol;
export interface AttentionGroupToken { readonly [attentionGroupToken]: true }

/** Per-position history for context and routing, with the group's current cadence. */
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

interface PlaceState extends PlaceView {
  followup?: FollowupState;
}
interface GroupState {
  score: AttentionScore;
  updatedAt: number;
  participatedAt?: number;
  arrivedAt?: number;
  lookedAt?: number;
  coldStartedAt?: number;
}

interface FollowupState {
  chatId: string;
  group: GroupState;
  until: number;
  senderId?: string;
  consumed?: boolean;
}

/** A single attention score per group. Times come from the caller's logical clock. */
export class Attention {
  private readonly params: AttentionParams;
  private readonly places = new Map<string, PlaceState>();
  private readonly groups = new Map<string, GroupState>();
  private readonly prompts = new Map<string, string>();
  private readonly tickets = new WeakMap<AttentionTicket, FollowupState>();
  private now = 0;
  private observer?: (groups: GroupAttention[]) => void;

  constructor(params: Partial<AttentionParams> = {}) {
    if (params.places !== undefined && (!Number.isInteger(params.places) || params.places < 1)) throw new RangeError('Attention memory must have positive capacity');
    const intervalsMs = [...(params.intervalsMs ?? ATTENTION_DEFAULTS.intervalsMs)];
    const decayMs = [...(params.decayMs ?? ATTENTION_DEFAULTS.decayMs)];
    for (const values of [intervalsMs, decayMs]) {
      if (!values.length || values.some((value, index) => !Number.isFinite(value) || value <= 0
        || (index > 0 && value <= values[index - 1]!))) throw new RangeError('Attention times must be positive and strictly increasing');
    }
    if (intervalsMs.length !== 3 || decayMs.length !== 4) throw new RangeError('Attention requires three intervals and four decay boundaries');
    this.params = { ...ATTENTION_DEFAULTS, ...params, intervalsMs, decayMs };
  }

  observe(observer: (groups: GroupAttention[]) => void): void { this.observer = observer; this.changed(); }
  private changed(): void { this.observer?.(this.snapshot()); }

  private interval(group: GroupState): number {
    return group.score === 100 ? this.params.focusBatchMs : group.score === 75 ? this.params.intervalsMs[0]!
      : group.score === 50 ? this.params.intervalsMs[1]! : this.params.intervalsMs[2]!;
  }

  private score(group: GroupState): AttentionScore {
    if (group.participatedAt === undefined) return 10;
    const age = this.now - group.participatedAt;
    const tier = this.params.decayMs.findIndex(boundary => age < boundary);
    return tier === -1 ? 10 : ([100, 75, 50, 25] as const)[tier]!;
  }

  private advance(now: number): boolean {
    this.now = Math.max(this.now, now);
    let changed = false;
    for (const group of this.groups.values()) {
      const score = this.score(group);
      if (score !== group.score) {
        group.score = score;
        group.updatedAt = this.now;
        changed = true;
      }
    }
    return changed;
  }

  snapshot(): GroupAttention[] {
    return [...this.groups].map(([groupId, group]) => {
      const main = this.places.get(groupId);
      let topics = 0;
      for (const place of this.places.values()) if (place.chatId === groupId && place.topic) topics++;
      const mode = group.score === 100 ? 'focus' as const : 'watch' as const;
      const intervalMs = this.interval(group);
      return {
        groupId,
        ...(main ? { main: { mode, intervalMs } } : {}),
        focusedTopics: 0,
        watchedTopics: topics,
        group: { score: group.score, intervalMs, updatedAt: group.updatedAt },
      };
    });
  }

  private touch(ref: PlaceRef): PlaceState {
    let place = this.places.get(ref.place);
    this.places.delete(ref.place);
    place ??= { chatId: ref.chatId, topic: ref.place !== ref.chatId, mode: 'watch', intervalMs: this.params.intervalsMs[2]!, misses: 0 };
    this.places.set(ref.place, place);
    if (!this.groups.has(ref.chatId)) this.groups.set(ref.chatId, { score: 10, updatedAt: this.now });
    while (this.places.size > this.params.places) {
      const oldest = this.places.keys().next().value;
      if (oldest === undefined) break;
      this.places.delete(oldest);
    }
    const chats = new Set([...this.places.values()].map(value => value.chatId));
    for (const chatId of this.groups.keys()) if (!chats.has(chatId)) this.groups.delete(chatId);
    return place;
  }

  arrive(ref: PlaceRef, now: number, _opts: { mine?: boolean; senderId?: string } = {}): AttentionMode {
    this.advance(now);
    const place = this.touch(ref);
    const group = this.groups.get(ref.chatId)!;
    // One cold-start batch for the whole group. Further arrivals cannot start it again.
    if (group.arrivedAt === undefined || this.now - group.arrivedAt >= this.params.lullMs) group.coldStartedAt = this.now;
    group.arrivedAt = this.now;
    place.arrivedAt = this.now;
    this.changed();
    return group.score === 100 ? 'focus' : 'watch';
  }

  /** A bounded group's identity also invalidates delayed acceptance after reset or eviction. */
  captureGroup(chatId: string): AttentionGroupToken | undefined {
    return this.groups.get(chatId) as unknown as AttentionGroupToken | undefined;
  }

  isCurrentGroup(chatId: string, token: AttentionGroupToken | undefined): boolean {
    return token !== undefined && token === (this.groups.get(chatId) as unknown);
  }

  /** Stage boundaries update snapshots even when no message arrives. */
  expire(now: number): boolean {
    const changed = this.advance(now);
    if (changed) this.changed();
    return changed;
  }

  nextExpiryAt(): number | undefined {
    let next = Infinity;
    for (const group of this.groups.values()) {
      if (group.participatedAt === undefined) continue;
      for (const boundary of this.params.decayMs) {
        const deadline = group.participatedAt + boundary;
        if (deadline > this.now) { next = Math.min(next, deadline); break; }
      }
    }
    return Number.isFinite(next) ? next : undefined;
  }

  /** Ordinary messages always batch, including at score 100. Old batches cannot starve behind other topics. */
  due(place: string, pending: readonly number[], now: number): number | undefined {
    if (!pending.length) return undefined;
    const changed = this.advance(now);
    if (changed) this.changed();
    const position = this.places.get(place);
    const group = position ? this.groups.get(position.chatId) : undefined;
    const interval = group ? this.interval(group) : this.params.intervalsMs[2]!;
    const first = pending[0]!;
    const last = Math.max(group?.arrivedAt ?? -Infinity, pending[pending.length - 1]!);
    const cold = group?.coldStartedAt !== undefined;
    const quietMs = interval === this.params.focusBatchMs ? this.params.focusBatchMs : this.params.quietMs;
    const cooldown = group?.lookedAt === undefined ? -Infinity : group.lookedAt + interval;
    const quiet = Math.max(last + quietMs, cold ? -Infinity : cooldown);
    const overdue = interval === this.params.focusBatchMs ? first + this.params.focusBatchMs
      : first + (cold ? this.params.quietMs : interval) + this.params.overdueMs;
    return Math.max(this.now, Math.min(quiet, overdue));
  }

  glanced(ref: PlaceRef, now: number): void {
    this.advance(now);
    const place = this.touch(ref);
    place.lookedAt = this.now;
    const group = this.groups.get(ref.chatId)!;
    group.lookedAt = this.now;
    group.coldStartedAt = undefined;
    this.changed();
  }

  /** Model intent alone does not prove that the Bot actually joined a conversation. */
  verdict(_ref: PlaceRef, _kind: LookKind, _outcome: LookOutcome, now: number): void {
    if (this.advance(now)) this.changed();
  }

  /** A real landing is the only event that raises or renews group attention. */
  replied(ref: PlaceRef, now: number, opts: { senderId?: string; participation?: boolean } = {}): AttentionTicket | undefined {
    this.advance(now);
    const place = this.touch(ref);
    let ticket: AttentionTicket | undefined;
    if (opts.participation !== false) {
      const group = this.groups.get(ref.chatId)!;
      group.participatedAt = this.now;
      group.updatedAt = this.now;
      group.score = 100;
      place.repliedAt = this.now;
      const followup: FollowupState = { chatId: ref.chatId, group, until: this.now + this.params.followupMs,
        ...(opts.senderId ? { senderId: opts.senderId } : {}) };
      ticket = {} as AttentionTicket;
      this.tickets.set(ticket, followup);
      place.followup = followup;
    }
    this.changed();
    return ticket;
  }

  /** One short-lived, structural follow-up per actual reply, with no score renewal. */
  followup(ref: PlaceRef, now: number, senderId?: string): boolean {
    if (this.advance(now)) this.changed();
    const place = this.places.get(ref.place);
    const followup = place?.followup;
    if (!place || place.chatId !== ref.chatId || !followup || followup.consumed || this.now >= followup.until || this.groups.get(ref.chatId) !== followup.group) return false;
    if (!place.topic && (!senderId || senderId !== followup.senderId)) return false;
    followup.consumed = true;
    return true;
  }

  /** An actually opened topic shares the originating reply's one-use shortcut. */
  openedTopic(chatId: string, topicId: string, ticket?: AttentionTicket, now = this.now): void {
    if (this.advance(now)) this.changed();
    const origin = ticket && this.tickets.get(ticket);
    if (!origin || origin.chatId !== chatId || origin.group !== this.groups.get(chatId) || origin.consumed || this.now >= origin.until) return;
    this.touch({ chatId, place: topicId }).followup = origin;
    this.changed();
  }

  /** Budget throttling removes the shortcut while the group's natural score stays visible. */
  freeze(ref: PlaceRef, now: number): boolean {
    if (this.advance(now)) this.changed();
    const place = this.places.get(ref.place);
    if (!place?.followup || place.followup.consumed) return false;
    place.followup.consumed = true;
    return true;
  }

  state(place: string): PlaceView | undefined {
    const value = this.places.get(place);
    const group = value && this.groups.get(value.chatId);
    if (!value || !group) return undefined;
    return { chatId: value.chatId, topic: value.topic, mode: group.score === 100 ? 'focus' : 'watch', intervalMs: this.interval(group),
      ...(value.lookedAt === undefined ? {} : { lookedAt: value.lookedAt }),
      ...(value.arrivedAt === undefined ? {} : { arrivedAt: value.arrivedAt }),
      ...(value.repliedAt === undefined ? {} : { repliedAt: value.repliedAt }), misses: 0 };
  }

  forget(chatId: string): void {
    for (const [place, state] of this.places) if (state.chatId === chatId) this.places.delete(place);
    this.groups.delete(chatId);
    this.changed();
  }

  notePrompt(chatId: string, hash: string): boolean {
    const previous = this.prompts.get(chatId);
    this.prompts.delete(chatId);
    this.prompts.set(chatId, hash);
    while (this.prompts.size > this.params.places) {
      const oldest = this.prompts.keys().next().value;
      if (oldest === undefined) break;
      this.prompts.delete(oldest);
    }
    if (previous === undefined || previous === hash) return false;
    this.forget(chatId);
    return true;
  }

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
