import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOP_LAG_REPORT_MS, startLoopLagMonitor, type LagHistogram } from '../src/core/loop-lag';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

/** A histogram whose numbers the test sets, in milliseconds. */
function histogram() {
  const made: Array<LagHistogram & { set(max: number, p99?: number): void; enabled: boolean; resets: number }> = [];
  const factory = () => {
    let max = 0;
    let p99 = 0;
    const h = {
      enabled: false,
      resets: 0,
      enable() { h.enabled = true; },
      disable() { h.enabled = false; },
      reset() { max = 0; p99 = 0; h.resets++; },
      get max() { return max * 1e6; },
      percentile: (p: number) => (p === 99 ? p99 * 1e6 : 0),
      set(m: number, p = m) { max = m; p99 = p; },
    };
    made.push(h);
    return h;
  };
  return { factory, made };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('event loop lag (s23f2)', () => {
  it('a line a minute with p99 and max, a warning within a second of a stall over 200 ms, and nothing after the stop', async () => {
    vi.useFakeTimers();
    const h = histogram();
    const stop = startLoopLagMonitor({ pid: 42, bot: 'cli_a' }, h.factory);
    const [minute, second] = h.made;
    expect(minute!.enabled && second!.enabled).toBe(true);

    second!.set(200);
    minute!.set(200);
    await vi.advanceTimersByTimeAsync(1_000);
    // 200 ms is not over
    expect(fake.log.warn).not.toHaveBeenCalled();
    second!.set(260);
    minute!.set(260, 30);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.log.warn).toHaveBeenCalledTimes(1);
    expect(fake.log.warn).toHaveBeenCalledWith('daemon-run', 'loop-lag-high', { pid: 42, bot: 'cli_a', maxMs: 260 });
    // read each second afresh: the same stall is not warned twice
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.log.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LOOP_LAG_REPORT_MS - 3_000);
    expect(fake.log.info).toHaveBeenCalledTimes(1);
    expect(fake.log.info).toHaveBeenCalledWith('daemon-run', 'loop-lag', { pid: 42, bot: 'cli_a', p99Ms: 30, maxMs: 260 });
    expect(minute!.resets).toBe(1);

    stop();
    stop();
    expect(minute!.enabled || second!.enabled).toBe(false);
    second!.set(900);
    await vi.advanceTimersByTimeAsync(LOOP_LAG_REPORT_MS * 2);
    expect(fake.log.warn).toHaveBeenCalledTimes(1);
    expect(fake.log.info).toHaveBeenCalledTimes(1);
  });

  it('holds no process open: with the real histogram, no timer of its keeps the loop alive', () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const idle = timers();
    const stop = startLoopLagMonitor();
    try {
      expect(timers()).toBe(idle);
    } finally {
      stop();
    }
  });
});
