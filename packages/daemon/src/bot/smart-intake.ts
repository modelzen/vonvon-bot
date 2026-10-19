/**
 * The smart mode's intake (product.md 3.4, s25): the hourly judgement budget of a group, and the lanes
 * that keep judgements off the SDK's per-chat queue (Rakazo 第二轮 A1, A3).
 *
 * A message to judge is handed to its place's lane (a group's main area, or a topic) and the SDK queue
 * moves on. A message naming this bot is judged at once, beside anything else. Of the ones naming no one,
 * a place judges one at a time: those coming meanwhile wait, and the next judgement takes them all and
 * judges only the newest, the others being its context. Verdicts land in arrival order only where it
 * matters: one that puts its message into the place's session lands after every earlier message naming
 * this bot that may go there too landed or was dropped, so the reply to an @ is never woven into another turn's record block
 * first (design H1). An aside is judged separately at once, but holds no other landing. Verdicts that skip or open a topic land at once, and nothing waits on an unnamed one.
 */

/** Judgements per group in an hour (product.md 3.4 控制成本, v1-plan 第 5 节). */
export const JUDGE_BUDGET = 60;
export const JUDGE_BUDGET_WINDOW_MS = 60 * 60_000;

/** Judgement calls per group in a sliding hour, so there is no burst at the turn of an hour. In memory: a
 * restart starts over. Taken right before the call, so two messages at once cannot both pass the 60th. */
export class JudgeBudget {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly limit = JUDGE_BUDGET, private readonly windowMs = JUDGE_BUDGET_WINDOW_MS) {}

  take(chatId: string, now: number): boolean {
    const kept = (this.calls.get(chatId) ?? []).filter((at) => now - at < this.windowMs);
    const ok = kept.length < this.limit;
    if (ok) kept.push(now);
    if (kept.length) this.calls.set(chatId, kept);
    else this.calls.delete(chatId);
    return ok;
  }
}

/** A message on a lane. */
export interface LaneEntry {
  id: string;
  /** The chat id for the main area, the thread id for a topic. */
  place: string;
  /** It names this bot: judged at once, and later landings into the session wait for it. */
  named: boolean;
  /** Judged separately at once, without holding later landings: another bot's @ may be skipped. */
  aside?: true;
}

export interface LaneDeps<E extends LaneEntry, V> {
  /** Judges the newest of `batch` (the last; the others came while the one before was judged). Async: never
   * throws; a rejection is reported and drops the batch. */
  judge(batch: E[], signal: AbortSignal): Promise<V>;
  /** Whether `verdict` puts the message into the place's session, so it lands after the earlier named ones. */
  ordered(verdict: V): boolean;
  /** Hands `batch` on; resolves once its message reached its session's intake, or was dropped. Async: never throws. */
  land(batch: E[], verdict: V): Promise<void>;
  fail(error: unknown): void;
  track(task: Promise<unknown>): void;
}

interface Item<E> {
  entry: E;
  seq: number;
}

interface Slot<E, V> {
  items: Item<E>[];
  /** Arrival of its newest message. */
  seq: number;
  named: boolean;
  ctl: AbortController;
  verdict?: { value: V };
  landing?: true;
  /** Aborted: whatever its judgement says is dropped. */
  dead?: true;
}

interface Lane<E, V> {
  /** Judged or being judged, until landed or dropped. */
  slots: Slot<E, V>[];
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

  /** Takes `entry`, judged unless `verdict` is given (a named message over the budget). False once shut down. */
  submit(entry: E, verdict?: { value: V }): boolean {
    if (this.closed) return false;
    let lane = this.lanes.get(entry.place);
    if (!lane) this.lanes.set(entry.place, lane = { slots: [], waiting: [] });
    const item = { entry, seq: ++this.seq };
    if (verdict) {
      lane.slots.push({ items: [item], seq: item.seq, named: entry.named, ctl: new AbortController(), verdict });
      this.flush(lane);
    } else if (!entry.named && !entry.aside && lane.judging) lane.waiting.push(item);
    else this.start(lane, [item], entry.named, Boolean(entry.aside));
    return true;
  }

  /** A recalled message: a waiting one leaves; one being judged for itself aborts its judgement, and the rest
   * of its batch is judged again; one that is only context of a batch leaves the batch. Landing checks again. */
  abort(id: string): void {
    for (const [place, lane] of this.lanes) {
      const waiting = lane.waiting.findIndex((item) => item.entry.id === id);
      if (waiting >= 0) {
        lane.waiting.splice(waiting, 1);
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
          this.next(lane);
        }
        this.flush(lane);
        this.tidy(place, lane);
        return;
      }
    }
  }

  /** The messages not landed yet, oldest first (a shutdown answers the named ones, s18c). */
  pending(): E[] {
    const items: Item<E>[] = [];
    for (const lane of this.lanes.values()) {
      for (const slot of lane.slots) if (!slot.dead) items.push(...slot.items);
      items.push(...lane.waiting);
    }
    return items.sort((a, b) => a.seq - b.seq).map((item) => item.entry);
  }

  /** Nothing more is taken or landed; every judgement in flight is aborted. */
  shutdown(): void {
    this.closed = true;
    for (const lane of this.lanes.values()) {
      for (const slot of lane.slots) {
        slot.dead = true;
        slot.ctl.abort();
      }
    }
    this.lanes.clear();
  }

  private start(lane: Lane<E, V>, items: Item<E>[], named: boolean, aside: boolean): void {
    const slot: Slot<E, V> = { items, seq: items[items.length - 1]!.seq, named, ctl: new AbortController() };
    lane.slots.push(slot);
    if (!named && !aside) lane.judging = slot;
    const place = items[0]!.entry.place;
    this.deps.track(this.deps.judge(items.map((item) => item.entry), slot.ctl.signal).then((value) => {
      if (!slot.dead) slot.verdict = { value };
    }, (error: unknown) => {
      this.deps.fail(error);
      slot.dead = true;
      const at = lane.slots.indexOf(slot);
      if (at >= 0) lane.slots.splice(at, 1);
    }).finally(() => {
      if (lane.judging === slot) {
        lane.judging = undefined;
        this.next(lane);
      }
      this.flush(lane);
      this.tidy(place, lane);
    }));
  }

  /** The waiting messages as one batch, once nothing unnamed is judged. */
  private next(lane: Lane<E, V>): void {
    if (this.closed || lane.judging || !lane.waiting.length) return;
    this.start(lane, lane.waiting.splice(0), false, false);
  }

  /** Lands every verdict that may land now. */
  private flush(lane: Lane<E, V>): void {
    if (this.closed) return;
    for (const slot of [...lane.slots]) {
      if (!slot.verdict || slot.landing || slot.dead) continue;
      const verdict = slot.verdict.value;
      if (this.deps.ordered(verdict) && lane.slots.some((other) => this.holds(other, slot))) continue;
      slot.landing = true;
      const place = slot.items[0]!.entry.place;
      this.deps.track(this.deps.land(slot.items.map((item) => item.entry), verdict).catch((error: unknown) => this.deps.fail(error)).finally(() => {
        const at = lane.slots.indexOf(slot);
        if (at >= 0) lane.slots.splice(at, 1);
        this.flush(lane);
        this.tidy(place, lane);
      }));
    }
  }

  /** Whether `other`, a named message that came before `slot`, may still go into the session first: not judged
   * yet, or judged so and not done landing. One judged to be skipped or to open a topic holds nothing back. */
  private holds(other: Slot<E, V>, slot: Slot<E, V>): boolean {
    return other.named && other.seq < slot.seq && (!other.verdict || this.deps.ordered(other.verdict.value));
  }

  /** An empty lane goes. */
  private tidy(place: string, lane: Lane<E, V>): void {
    if (!lane.slots.length && !lane.waiting.length && !lane.judging && this.lanes.get(place) === lane) this.lanes.delete(place);
  }
}
