/**
 * Oldest Codex vonvon supports. e05: with a ChatGPT login the server refused every model tried on
 * 0.139.0 and gpt-6-luna on 0.148.0; 0.156.1 passed everything, including the smart-mode judge
 * (s23b). The server's line keeps moving up, so a newer Codex can still be refused: a turn with
 * "requires a newer version" is `version` (s19); a judgement "not supported when using Codex with
 * a ChatGPT account" is `version` below this line and `model` above it (judge-process.ts).
 */
export const CODEX_MIN_VERSION = '0.156.1';
/** Historical verified baseline, independent of the latest stable installer. */
export const CODEX_VERIFIED_VERSION = '0.156.1';

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
