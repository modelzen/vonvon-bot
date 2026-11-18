import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { serviceActionReportSchema, type ServiceActionReason, type ServiceActionReport } from '@vonvon/protocol';
import { isDead } from '../config/data-access';
import { writeFileAtomic } from '../server/atomic-file';

/** `<root>/service-action.json`: what the last `vonvon service install|uninstall` helper is doing or did. The pid
 * tells a live helper from one that died; the daemon's snapshot and the desktop read it. */
const recordSchema = z.object({ pid: z.number().int().positive(), leftovers: z.array(z.string()).optional() });
export type ServiceActionRecord = ServiceActionReport & z.infer<typeof recordSchema>;
/** Machine-level choices, unlike the per-bot `bots/<id>/setup.json`; only the skipped service so far. */
const setupSchema = z.object({ service: z.object({ skipped: z.boolean(), at: z.number() }).optional() }).passthrough();

export const serviceActionPath = (root: string): string => join(root, 'service-action.json');
const setupPath = (root: string): string => join(root, 'setup.json');

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return undefined; }
}

/** Missing or unreadable reads as no report, so the step shows only the manager's state. */
export function readServiceActionRecord(root: string): ServiceActionRecord | null {
  const value = readJson(serviceActionPath(root));
  const report = serviceActionReportSchema.safeParse(value);
  const record = recordSchema.safeParse(value);
  return report.success && record.success ? { ...report.data, ...record.data } : null;
}

/** Longer than any helper runs: its launchctl calls (30 s each), readiness waits (25 s), a rollback and the restart. */
const RUNNING_REPORT_MAX_AGE = 10 * 60_000;

/**
 * A running record whose helper died (killed, or the machine slept and rebooted) is dropped. Its pid may have been
 * reused since: a process we may not signal is another user's, never our helper; one of ours only its age gives away.
 */
export function liveServiceActionRecord(root: string, now = Date.now()): ServiceActionRecord | null {
  const record = readServiceActionRecord(root);
  if (record?.phase !== 'running') return record;
  if (now - record.startedAt > RUNNING_REPORT_MAX_AGE) return null;
  try { return isDead(record.pid) ? null : record; }
  catch { return null; }
}

export async function writeServiceActionRecord(root: string, record: ServiceActionRecord): Promise<void> {
  await writeFileAtomic(serviceActionPath(root), `${JSON.stringify(record)}\n`);
}

export function readServiceSkipped(root: string): boolean {
  const parsed = setupSchema.safeParse(readJson(setupPath(root)));
  return parsed.success && parsed.data.service?.skipped === true;
}

/** Keeps the file's other keys; only the daemon writes it. */
export async function writeServiceSkipped(root: string, skipped: boolean, at = Date.now()): Promise<void> {
  const parsed = setupSchema.safeParse(readJson(setupPath(root)));
  await writeFileAtomic(setupPath(root), `${JSON.stringify({ ...(parsed.success ? parsed.data : {}), service: { skipped, at } })}\n`);
}

/** Each pattern matches one s07 refusal string; service-cli.test.ts pins the texts and service-transaction.test.ts the launchd outcomes.
 * A held service mutex is not here: that refusal writes no report (host/service-action.ts reports the helper's exit). */
const FAILURES: readonly [ServiceActionReason, RegExp][] = [
  // launchd.ts TRANSLOCATED_REFUSAL.
  ['translocated', /\(App Translocation\)/],
  // launchd.ts: a plist with no job while a daemon runs, and the bootstrap failure hint.
  ['turned-off', /turned off in System Settings/],
  // launchd.ts and systemd.ts: a loaded job with other bytes and a live process.
  ['replace-running', /Run vonvon daemon stop before replacing the service/],
  // adapter.ts, launchd.ts and systemd.ts: a development checkout or an unknown layout.
  ['distribution', /Distribution cannot install a service/],
  // launchd.ts and systemd.ts: a job left loaded without its definition.
  ['interrupted', /^Interrupted uninstall/],
  // launchd.ts and systemd.ts registrationDetail.
  ['other-root', /^Registration belongs to /],
  // launchd.ts: no GUI domain or an unreadable job record; systemd.ts: the user manager is not running.
  ['manager-unavailable', /^(GUI domain unavailable|launchd query failed|User manager unavailable)/],
];

export function classifyServiceFailure(detail: string): ServiceActionReason {
  return FAILURES.find(([, pattern]) => pattern.test(detail))?.[0] ?? 'other';
}
