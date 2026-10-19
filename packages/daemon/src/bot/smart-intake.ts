/** Judgements per group in an hour (product.md 3.4 控制成本, v1-plan 第 5 节). */
export const JUDGE_BUDGET = 60;
export const JUDGE_BUDGET_WINDOW_MS = 60 * 60_000;

/** Glances stop before the full budget is spent (product.md 3.4). */
export const JUDGE_GLANCE_CAP = 45;
export type JudgeKind = 'named' | 'bot' | 'name' | 'focus' | 'glance';

/** Sliding group budget, taken immediately before judgement; a restart starts over. */
export class JudgeBudget {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly limit = JUDGE_BUDGET, private readonly windowMs = JUDGE_BUDGET_WINDOW_MS,
    private readonly glanceCap = JUDGE_GLANCE_CAP) {}

  take(chatId: string, now: number, kind: JudgeKind): boolean {
    if (kind === 'named') return true;
    const kept = this.kept(chatId, now);
    if (kept.length >= (kind === 'glance' ? this.glanceCap : this.limit)) return false;
    kept.push(now);
    this.calls.set(chatId, kept);
    return true;
  }

  used(chatId: string, now: number): number { return this.kept(chatId, now).length; }

  freeAt(chatId: string, now: number, below: number): number {
    const kept = this.kept(chatId, now);
    below = Math.max(1, below);
    return kept.length < below ? now : kept[kept.length - below]! + this.windowMs;
  }

  private kept(chatId: string, now: number): number[] {
    const kept = (this.calls.get(chatId) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length) this.calls.set(chatId, kept);
    else this.calls.delete(chatId);
    return kept;
  }
}

export type LaneKind = 'named' | 'aside' | 'chat';
export const LANE_WAITING_MAX = 40;
export interface Waiting<E> { entry: E; at: number }

/** A message on a lane. */
export interface LaneEntry {
  id: string;
  /** The chat id for the main area, the thread id for a topic. */
  place: string;
  kind: LaneKind;
}

export interface LaneDeps<E extends LaneEntry, V> {
  /** Judges the newest of `batch` (the last; the others came while the one before was judged). Async: never
   * throws; a rejection is reported and drops the batch. */
  judge(batch: E[], signal: AbortSignal, glance: boolean): Promise<V>;
  /** Whether `verdict` puts the message into the place's session, so it lands after the earlier named ones. */
  ordered(verdict: V): boolean;
  /** Hands `batch` on; resolves once its message reached its session's intake, or was dropped. Async: never throws. */
  land(batch: E[], verdict: V, glance: boolean): Promise<void>;
  /** Undefined judges immediately; a timestamp schedules a glance of the waiting batch. */
  due(place: string, waiting: readonly Waiting<E>[], now: number): number | undefined;
  overflow?(dropped: E[]): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  fail(error: unknown): void;
  track(task: Promise<unknown>): void;
}

interface Item<E> {
  entry: E;
  seq: number;
  at: number;
}

interface Slot<E, V> {
  items: Item<E>[];
  /** Arrival of its newest message. */
  seq: number;
  kind: LaneKind;
  glance: boolean;
  ctl: AbortController;
  verdict?: { value: V };
  landing?: true;
  /** Aborted: whatever its judgement says is dropped. */
  dead?: true;
}

interface Lane<E, V> {
  /** Judged or being judged, until landed or dropped. */
  slots: Slot<E, V>[];
  timer?: { handle: unknown; at: number };
  /** The unnamed batch being judged: at most one per place. */
  judging?: Slot<E, V>;
  /** Unnamed messages that came meanwhile: the next batch. */
  waiting: Item<E>[];
}

export class SmartLanes<E extends LaneEntry, V> {
  private readonly lanes = new Map<string, Lane<E, V>>();
  private seq = 0;
  private closed = false;

  constructor(private readonly deps: LaneDeps<E, V>) {}

  /** Takes an entry; hard signals judge separately without consuming the waiting batch. */
  submit(entry: E): boolean {
    if (this.closed) return false;
    let lane = this.lanes.get(entry.place);
    if (!lane) this.lanes.set(entry.place, lane = { slots: [], waiting: [] });
    const item = { entry, seq: ++this.seq, at: this.deps.now() };
    if (entry.kind !== 'chat') this.start(lane, [item], entry.kind, false);
    else {
      lane.waiting.push(item);
      this.trimWaiting(lane);
      if (!lane.judging) this.arm(lane);
    }
    return true;
  }

  dueAt(place: string): number | undefined { return this.lanes.get(place)?.timer?.at; }

  prune(place: string, taken: (entry: E) => boolean): E[] {
    const lane = this.lanes.get(place);
    if (!lane) return [];
    const removed: E[] = [];
    lane.waiting = lane.waiting.filter((item) => {
      if (!taken(item.entry)) return true;
      removed.push(item.entry);
      return false;
    });
    if (!lane.judging) this.arm(lane);
    this.tidy(place, lane);
    return removed;
  }

  /** A recalled message: a waiting one leaves; one being judged for itself aborts its judgement, and the rest
   * of its batch is judged again; one that is only context of a batch leaves the batch. Landing checks again. */
  abort(id: string): void {
    for (const [place, lane] of this.lanes) {
      const waiting = lane.waiting.findIndex((item) => item.entry.id === id);
      if (waiting >= 0) {
        lane.waiting.splice(waiting, 1);
        if (!lane.judging) this.arm(lane);
        this.tidy(place, lane);
        return;
      }
      for (const slot of lane.slots) {
        const at = slot.items.findIndex((item) => item.entry.id === id);
        if (at < 0 || slot.verdict || slot.landing) continue;
        if (at < slot.items.length - 1) {
          slot.items.splice(at, 1);
          return;
        }
        slot.dead = true;
        slot.ctl.abort();
        lane.slots.splice(lane.slots.indexOf(slot), 1);
        if (lane.judging === slot) {
          lane.judging = undefined;
          lane.waiting.unshift(...slot.items.slice(0, -1));
          this.trimWaiting(lane);
          this.arm(lane);
        }
        this.flush(lane);
        this.settle(lane);
        this.tidy(place, lane);
        return;
      }
    }
  }

  /** Named messages not landed yet, oldest first, for shutdown recovery (s18c). */
  pending(): E[] {
    const items: Item<E>[] = [];
    for (const lane of this.lanes.values()) {
      for (const slot of lane.slots) if (!slot.dead && slot.kind === 'named') items.push(...slot.items);
    }
    return items.sort((a, b) => a.seq - b.seq).map((item) => item.entry);
  }

  /** Nothing more is taken or landed; every judgement in flight is aborted. */
  shutdown(): void {
    this.closed = true;
    for (const lane of this.lanes.values()) {
      this.clearTimer(lane);
      for (const slot of lane.slots) {
        slot.dead = true;
        slot.ctl.abort();
      }
    }
    this.lanes.clear();
  }

  private start(lane: Lane<E, V>, items: Item<E>[], kind: LaneKind, glance: boolean): void {
    const slot: Slot<E, V> = { items, seq: items[items.length - 1]!.seq, kind, glance, ctl: new AbortController() };
    lane.slots.push(slot);
    if (kind === 'chat') lane.judging = slot;
    const place = items[0]!.entry.place;
    this.deps.track(this.deps.judge(items.map((item) => item.entry), slot.ctl.signal, glance).then((value) => {
      if (!slot.dead) slot.verdict = { value };
    }, (error: unknown) => {
      this.deps.fail(error);
      slot.dead = true;
      const at = lane.slots.indexOf(slot);
      if (at >= 0) lane.slots.splice(at, 1);
    }).finally(() => {
      if (lane.judging === slot) {
        lane.judging = undefined;
      }
      this.settle(lane);
      this.flush(lane);
      this.tidy(place, lane);
    }));
  }

  private trimWaiting(lane: Lane<E, V>): void {
    if (lane.waiting.length > LANE_WAITING_MAX) {
      const dropped = lane.waiting.splice(0, lane.waiting.length - LANE_WAITING_MAX);
      this.deps.overflow?.(dropped.map((item) => item.entry));
    }
  }

  private clearTimer(lane: Lane<E, V>): void {
    if (lane.timer) this.deps.clearTimer(lane.timer.handle);
    lane.timer = undefined;
  }

  private arm(lane: Lane<E, V>): void {
    this.clearTimer(lane);
    if (this.closed || !lane.waiting.length) return;
    const place = lane.waiting[0]!.entry.place;
    const now = this.deps.now();
    let at: number | undefined;
    try { at = this.deps.due(place, lane.waiting, now); }
    catch (error) { this.deps.fail(error); }
    if (at === undefined) this.startWaiting(lane, false);
    else if (at <= now) {
      if (!lane.slots.some((s) => s.kind !== 'chat' && !s.dead)) this.startWaiting(lane, true);
    } else {
      // Identity also rejects a cleared callback arriving after a replacement was armed.
      const timer: NonNullable<Lane<E, V>['timer']> = { handle: undefined, at };
      timer.handle = this.deps.setTimer(() => {
        if (this.closed || this.lanes.get(place) !== lane || lane.timer !== timer) return;
        lane.timer = undefined;
        if (!lane.judging) this.arm(lane);
      }, at - now);
      lane.timer = timer;
    }
  }

  private startWaiting(lane: Lane<E, V>, glance: boolean): void {
    this.start(lane, lane.waiting.splice(0), 'chat', glance);
  }

  private settle(lane: Lane<E, V>): void {
    if (!this.closed && !lane.judging && lane.waiting.length && !lane.timer) this.arm(lane);
  }

  /** Lands every verdict that may land now. */
  private flush(lane: Lane<E, V>): void {
    if (this.closed) return;
    for (const slot of [...lane.slots]) {
      if (!slot.verdict || slot.landing || slot.dead) continue;
      const verdict = slot.verdict.value;
      if (this.deps.ordered(verdict)) {
        if (lane.slots.some((other) => this.holds(other, slot))) continue;
        if (lane.slots.some((other) => other.landing && other.verdict && this.deps.ordered(other.verdict.value))) continue;
      }
      slot.landing = true;
      const place = slot.items[0]!.entry.place;
      this.deps.track(this.deps.land(slot.items.map((item) => item.entry), verdict, slot.glance).catch((error: unknown) => this.deps.fail(error)).finally(() => {
        const at = lane.slots.indexOf(slot);
        if (at >= 0) lane.slots.splice(at, 1);
        this.flush(lane);
        this.settle(lane);
        this.tidy(place, lane);
      }));
    }
  }

  /** Whether `other`, a named message that came before `slot`, may still go into the session first: not judged
   * yet, or judged so and not done landing. One judged to be skipped or to open a topic holds nothing back. */
  private holds(other: Slot<E, V>, slot: Slot<E, V>): boolean {
    return other.kind === 'named' && other.seq < slot.seq && (!other.verdict || this.deps.ordered(other.verdict.value));
  }

  /** An empty lane goes. */
  private tidy(place: string, lane: Lane<E, V>): void {
    if (!lane.slots.length && !lane.waiting.length && !lane.judging && !lane.timer && this.lanes.get(place) === lane) this.lanes.delete(place);
  }
}
