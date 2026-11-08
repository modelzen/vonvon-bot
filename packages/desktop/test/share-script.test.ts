import { describe, expect, it } from 'vitest';
import type { ShareLayout } from '../../ui/src/client-context.js';
import { SHARE_STEP_MS } from '../src/share-contract.js';
import { dwellMs, pointerScript, railWindows, SHARE_MAX_MS, SHARE_SETTLE_MS, type ShareInput } from '../src/share-script.js';

/** Badges 180 wide, 16 apart, in a rail 24 in from the card's edge that shows four. */
function layout(count: number): ShareLayout {
  const badges = Array.from({ length: count }, (_, i) => ({ x: 24 + i * 196, y: 120, width: 180, height: 300 }));
  return {
    width: 840, height: 900, badges,
    rail: { x: 0, y: 80, width: 840, height: 360, clientWidth: 840, scrollWidth: Math.max(840, 24 + count * 196 + 8) },
  };
}
/** Plays the script as the page would: the rail's position follows the wheel exactly. */
function play(value: ShareLayout) {
  let scroll = 0;
  const steps: ShareInput[][] = [];
  for (const inputs of pointerScript(value, () => scroll)) {
    steps.push(inputs);
    for (const input of inputs) if (input.type === 'mouseWheel') scroll -= (input as { deltaX: number }).deltaX;
  }
  const moves = steps.flatMap((inputs, step) => inputs.filter(input => input.type === 'mouseMove').map(input => ({ step, x: input.x, y: input.y })));
  return { steps, moves, scroll, ms: steps.length * SHARE_STEP_MS };
}
/** The steps the pointer rests on badge `index`'s centre. */
function dwell(value: ShareLayout, run: ReturnType<typeof play>, index: number, scrollAt: number): number {
  const b = value.badges[index]!;
  const at = run.moves.findIndex(move => move.x === Math.round(b.x + b.width / 2 - scrollAt));
  return at < 0 ? 0 : (run.moves[at + 1]?.step ?? run.steps.length) - run.moves[at]!.step;
}

describe('share pointer script', () => {
  it('passes over every badge of a short roster, resting until each flip is done, in about 3 s', () => {
    const value = layout(4);
    const run = play(value);
    expect(railWindows(value)).toEqual([{ scroll: 0, badges: [0, 1, 2, 3] }]);
    for (let i = 0; i < 4; i++) expect(dwell(value, run, i, 0) * SHARE_STEP_MS).toBeGreaterThanOrEqual(dwellMs(4) - 1);
    expect(run.ms + SHARE_SETTLE_MS).toBeLessThan(3500);
    expect(run.steps.flat().some(input => input.type === 'mouseWheel')).toBe(false);
    // It leaves to the right of the last badge, then below the card, where nothing reacts to it.
    expect(run.moves.at(-1)).toMatchObject({ x: 2, y: 904 });
    // Fast enough across a badge for the app's swing kick (0.32 px/ms).
    const first = run.moves.slice(1, 4);
    expect((first[2]!.x - first[0]!.x) / ((first[2]!.step - first[0]!.step) * SHARE_STEP_MS)).toBeGreaterThan(0.32);
  });

  it('scrolls eight badges on with the wheel and back to the start, in about 6 s', () => {
    const value = layout(8);
    const windows = railWindows(value);
    // The second stop is the end of the rail, where the app's snapping also lets it rest.
    expect(windows).toEqual([{ scroll: 0, badges: [0, 1, 2, 3] }, { scroll: 760, badges: [4, 5, 6, 7] }]);
    const run = play(value);
    expect(run.scroll).toBe(0);
    expect(run.ms + SHARE_SETTLE_MS).toBeGreaterThan(5000);
    expect(run.ms + SHARE_SETTLE_MS).toBeLessThan(7000);
    for (let i = 0; i < 8; i++) expect(dwell(value, run, i, i < 4 ? 0 : 760) * SHARE_STEP_MS).toBeGreaterThanOrEqual(dwellMs(8) - 1);
    // The pointer waits below the card while the rail scrolls, so no badge flips under it.
    const wheelSteps = run.steps.flatMap((inputs, step) => inputs.some(input => input.type === 'mouseWheel') ? [step] : []);
    for (const step of wheelSteps) expect(run.moves.filter(move => move.step <= step).at(-1)).toMatchObject({ x: 2, y: 904 });
  });

  it('clamps the last stop to the end of the rail and keeps ten badges within 10 s', () => {
    const value = layout(10);
    const max = value.rail.scrollWidth - value.rail.clientWidth;
    expect(railWindows(value).map(window => window.scroll)).toEqual([0, 784, max]);
    expect(railWindows(value).flatMap(window => window.badges)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const run = play(value);
    expect(run.scroll).toBe(0);
    expect(run.ms + SHARE_SETTLE_MS).toBeLessThanOrEqual(SHARE_MAX_MS);
    expect(dwellMs(10)).toBe(350);
  });

  it('stops visiting badges where 10 s runs out, still ending at the start', () => {
    const run = play(layout(30));
    expect(run.ms + SHARE_SETTLE_MS).toBeLessThanOrEqual(SHARE_MAX_MS);
    expect(run.scroll).toBe(0);
  });

  it('follows where the page says the rail is after a scroll', () => {
    const value = layout(8);
    const moves: number[] = [];
    let reported: number | undefined;
    for (const inputs of pointerScript(value, () => reported)) {
      for (const input of inputs) {
        if (input.type === 'mouseWheel') reported = 700;
        if (input.type === 'mouseMove') moves.push(input.x);
      }
    }
    expect(moves).toContain(Math.round(value.badges[4]!.x + 90 - 700));
  });

  it('has nothing to do without badges', () => {
    expect(play({ width: 600, height: 400, badges: [], rail: { x: 0, y: 0, width: 600, height: 0, clientWidth: 600, scrollWidth: 600 } }).steps).toEqual([]);
  });
});
