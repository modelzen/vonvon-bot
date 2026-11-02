import { realpathSync } from 'node:fs';

/**
 * The CLI entry this process runs, resolved once (server-3 4.7). A standalone server is started through
 * `<installRoot>/current/app/bin/vonvon.mjs`; an update moves `current` to the new release while this process still
 * runs the old one, so whatever it starts afterwards (a bot, the restart helper) must name its own
 * release, not `current`. Resolved again only when `process.argv[1]` itself changes (tests set it); a path that does
 * not exist is kept as it is. `process.execPath` needs no pin: Node already resolves it (test/self-entry.test.ts).
 */
let pinned: { raw: string; real: string } | undefined;

export function selfEntry(): string {
  const raw = process.argv[1] ?? '';
  if (pinned?.raw === raw) return pinned.real;
  let real = raw;
  try { if (raw) real = realpathSync(raw); } catch { /* keep the path as given */ }
  pinned = { raw, real };
  return real;
}

selfEntry();
