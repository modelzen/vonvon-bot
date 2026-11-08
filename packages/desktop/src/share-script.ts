import type { MouseInputEvent, MouseWheelInputEvent } from 'electron';
import type { ShareLayout } from '../../ui/src/client-context.js';
import { SHARE_MARKER_STRIP, SHARE_STEP_MS } from './share-contract.js';

export type ShareInput = MouseInputEvent | MouseWheelInputEvent;

/** CSS pixels per millisecond: fast enough that entering a badge kicks its swing (the app's threshold is 0.32). */
const MOVE_SPEED = 1.4;
const SCROLL_MS = 450;
/** The whole GIF, settling included, stays within this. */
export const SHARE_MAX_MS = 10_000;
/** After the pointer has gone, at most this long for the last flip back and the swing to settle. */
export const SHARE_SETTLE_MS = 800;

/** Each badge's dwell shortens with the roster: about 3 s for four, 6 s for eight. Long enough for the 530 ms flip to
 * look finished, its curve being nearly flat by then. */
export function dwellMs(count: number): number {
  return Math.min(450, Math.max(350, 450 - (count - 4) * 25));
}

const steps = (ms: number): number => Math.max(1, Math.round(ms / SHARE_STEP_MS));

type Window = { scroll: number; badges: number[] };
/** The rail's stops: the badges in view at each, and the scroll that brings the next unseen one to the start, where the
 * app's snapping puts it. */
export function railWindows(layout: ShareLayout): Window[] {
  const { badges, rail } = layout;
  if (badges.length === 0) return [];
  const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
  const origin = badges[0]!.x;
  const inView = (index: number, scroll: number): boolean => {
    const b = badges[index]!;
    return b.x - scroll >= rail.x - 1 && b.x + b.width - scroll <= rail.x + rail.clientWidth + 1;
  };
  const windows: Window[] = [];
  let scroll = 0, next = 0;
  while (next < badges.length) {
    const shown: number[] = [];
    for (let i = next; i < badges.length && (inView(i, scroll) || shown.length === 0 && i === next); i++) shown.push(i);
    windows.push({ scroll, badges: shown });
    next = shown.at(-1)! + 1;
    if (next >= badges.length) break;
    const following = Math.min(max, Math.round(badges[next]!.x - origin));
    if (following <= scroll) {
      windows.at(-1)!.badges.push(...badges.slice(next).map((_, i) => next + i));
      break;
    }
    scroll = following;
  }
  return windows;
}

function* moveTo(from: [number, number], to: [number, number]): Generator<ShareInput[]> {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.ceil(distance / (MOVE_SPEED * SHARE_STEP_MS)));
  let last = from;
  for (let i = 1; i <= count; i++) {
    const point: [number, number] = [Math.round(from[0] + (to[0] - from[0]) * i / count), Math.round(from[1] + (to[1] - from[1]) * i / count)];
    if (point[0] === last[0] && point[1] === last[1]) { yield []; continue; }
    last = point;
    yield [{ type: 'mouseMove', x: point[0], y: point[1] }];
  }
}
function* hold(ms: number): Generator<ShareInput[]> {
  for (let i = steps(ms); i > 0; i--) yield [];
}
/** Horizontal wheel steps easing in and out, in whole pixels adding up to `distance`. Precise deltas scroll at once,
 * with no smooth-scroll animation of Chromium's own running on real time. */
function* wheel(at: [number, number], distance: number): Generator<ShareInput[]> {
  const count = steps(SCROLL_MS);
  let done = 0;
  for (let i = 1; i <= count; i++) {
    const u = i / count;
    const reached = Math.round(distance * u * u * (3 - 2 * u));
    const delta = reached - done;
    done = reached;
    // A negative deltaX scrolls right.
    yield delta === 0 ? [] : [{ type: 'mouseWheel', x: at[0], y: at[1], deltaX: -delta, deltaY: 0, hasPreciseScrollingDeltas: true, canScroll: true }];
  }
}

/**
 * The pointer's path over the card, one array of input per clock step. It passes over each badge from left to right and
 * stays until the flip has finished, so the app's own hover flip, swing, tilt and shine play. More badges than the rail
 * shows: between stops the pointer waits below the card, out of every element, while the wheel scrolls the rail on to
 * the next stop and at the end back to the start, so the last frame matches the first. `scrollLeft` is the rail's
 * position the page last reported, if it did.
 */
export function* pointerScript(layout: ShareLayout, scrollLeft: () => number | undefined = () => undefined): Generator<ShareInput[]> {
  const { badges, rail } = layout;
  const windows = railWindows(layout);
  const dwell = dwellMs(badges.length);
  const park: [number, number] = [2, Math.round(layout.height + SHARE_MARKER_STRIP / 2)];
  const wheelAt: [number, number] = [Math.round(rail.x + rail.width / 2), Math.round(rail.y + rail.height / 2)];
  const budget = steps(SHARE_MAX_MS - SHARE_SETTLE_MS);
  let used = 0, scroll = 0, at: [number, number] | undefined;
  const run = function* (part: Generator<ShareInput[]>): Generator<ShareInput[]> {
    for (const inputs of part) {
      used++;
      for (const input of inputs) if (input.type === 'mouseMove') at = [input.x, input.y];
      yield inputs;
    }
  };
  const teleport = function* (to: [number, number]): Generator<ShareInput[]> {
    if (at && at[0] === to[0] && at[1] === to[1]) return;
    yield* run((function* () { yield [{ type: 'mouseMove' as const, x: to[0], y: to[1] }]; })());
  };
  const perBadge = steps(dwell) + steps(220);
  for (const [w, window] of windows.entries()) {
    if (w > 0) {
      if (used + steps(SCROLL_MS) * 2 + window.badges.length * perBadge > budget) break;
      yield* teleport(park);
      yield* run(wheel(wheelAt, window.scroll - scroll));
      // A frame later the page has the compositor's scroll position.
      yield* run(hold(70));
      scroll = scrollLeft() ?? window.scroll;
    }
    const first = badges[window.badges[0]!]!;
    const y = (index: number): number => Math.round(badges[index]!.y + badges[index]!.height * 0.62);
    const before = window.badges[0]! > 0 ? badges[window.badges[0]! - 1]! : undefined;
    const enterX = before ? (before.x + before.width + first.x) / 2 : Math.max(0, first.x - 12);
    yield* teleport([Math.round(enterX - scroll), y(window.badges[0]!)]);
    for (const index of window.badges) {
      const b = badges[index]!;
      yield* run(moveTo(at!, [Math.round(b.x + b.width / 2 - scroll), y(index)]));
      yield* run(hold(dwell));
    }
    const lastIndex = window.badges.at(-1)!;
    const last = badges[lastIndex]!, after = badges[lastIndex + 1];
    const exitX = after ? (last.x + last.width + after.x) / 2 : last.x + last.width + 12;
    yield* run(moveTo(at!, [Math.round(exitX - scroll), y(lastIndex)]));
    yield* teleport(park);
  }
  if (scroll > 0) yield* run(wheel(wheelAt, -scroll));
}
