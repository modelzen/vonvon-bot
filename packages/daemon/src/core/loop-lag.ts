import { monitorEventLoopDelay } from 'node:perf_hooks';
import { log } from './logger';

/** A line a minute with the minute's p99 and max (s23f2). */
export const LOOP_LAG_REPORT_MS = 60_000;
/** A stall this long is written at once, as a warning: Node's happy eyeballs gave each connection attempt 250 ms. */
export const LOOP_LAG_WARN_MS = 200;
/** How often a stall is looked for, and the histograms' sampling interval. */
const CHECK_MS = 1_000;
const RESOLUTION_MS = 20;

/** The part of Node's event loop delay histogram used here: nanoseconds, as `monitorEventLoopDelay` gives. */
export interface LagHistogram {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  readonly max: number;
  percentile(p: number): number;
}

const ms = (ns: number): number => Math.round(ns / 1e6);

/**
 * Watches this process's event loop, to tell a stalled process from a slow network the next time a connection times
 * out (s23f2): every minute an info line with the minute's p99 and max, and a warning within a second of any stall over
 * {@link LOOP_LAG_WARN_MS}. Its timers never hold the process open. Returns the stop, which is safe to call twice.
 */
export function startLoopLagMonitor(fields: Record<string, unknown> = {}, histogram: () => LagHistogram = () => monitorEventLoopDelay({ resolution: RESOLUTION_MS })): () => void {
  // two histograms: a stall shorter than the minute's worst still gets its warning
  const minute = histogram();
  const second = histogram();
  minute.enable();
  second.enable();
  const check = setInterval(() => {
    const max = ms(second.max);
    second.reset();
    if (max > LOOP_LAG_WARN_MS) log.warn('daemon-run', 'loop-lag-high', { ...fields, maxMs: max });
  }, CHECK_MS);
  const report = setInterval(() => {
    log.info('daemon-run', 'loop-lag', { ...fields, p99Ms: ms(minute.percentile(99)), maxMs: ms(minute.max) });
    minute.reset();
  }, LOOP_LAG_REPORT_MS);
  check.unref();
  report.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(check);
    clearInterval(report);
    minute.disable();
    second.disable();
  };
}
