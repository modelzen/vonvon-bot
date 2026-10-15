import { CODEX_INSTALL_VERSION } from './managed-install';

/**
 * Oldest Codex whose behaviour vonvon depends on and has run against: `turn/interrupt`
 * ending in `turn/completed(interrupted)` (watchdog.ts), goal auto-start and goal statuses
 * (backend.ts, types.ts). Every app-server method vonvon calls exists from 0.131.0, but
 * nothing below 0.139.0 was run. e05 and s39 raise this later (v1-plan).
 */
export const CODEX_MIN_VERSION = '0.139.0';
/** The version vonvon was tested on; the managed install pins the same one. */
export const CODEX_VERIFIED_VERSION = CODEX_INSTALL_VERSION;

export type CodexCompatibility = 'ok' | 'tooOld' | 'newer' | 'unknown';

type Version = { core: [number, number, number]; prerelease: string[] };

/** Parses `codex-cli 0.162.1`, `0.162.1` or a prerelease such as `0.125.0-alpha.3`. */
export function parseCodexVersion(text: string | null | undefined): string | null {
  return text?.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

function parse(version: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] };
}

/** Semver precedence: a prerelease sorts before its release (`0.139.0-alpha.1` < `0.139.0`). */
export function compareCodexVersions(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error(`Not a version: ${a ? right : left}`);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (delta) return delta;
  }
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) - Number(y);
    if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 够用 (`ok`), 太旧 (`tooOld`) or 比验证过的新 (`newer`); `unknown` when no version can be read. */
export function classifyCodexVersion(text: string | null | undefined): CodexCompatibility {
  const version = parseCodexVersion(text);
  if (!version) return 'unknown';
  if (compareCodexVersions(version, CODEX_MIN_VERSION) < 0) return 'tooOld';
  return compareCodexVersions(version, CODEX_VERIFIED_VERSION) > 0 ? 'newer' : 'ok';
}
