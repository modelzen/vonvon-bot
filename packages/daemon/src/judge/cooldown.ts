import { JudgeCallError } from '../agent/types';
import { log } from '../core/logger';
import { DecisionError } from './typesafe';
import type { JudgeErrorKind } from './types';

/** After a structured auth, quota, version or model failure, how long the judge skips the backend. */
export const JUDGE_COOLDOWN_MS = 5 * 60_000;

type CoolKind = Extract<JudgeErrorKind, 'auth' | 'quota' | 'version' | 'model' | 'busy'>;
const COOL_KINDS: readonly JudgeErrorKind[] = ['auth', 'quota', 'version', 'model', 'busy'];

/**
 * Cooldown after a failure the backend reported with a structured code (design 第 4 节): auth and
 * quota cool the whole backend, version and model only that backend with that model. A kind only
 * guessed from the message text (`structured: false`) never cools: the text rules are broad, and one
 * misread would stop every smart group of the bot for 5 minutes.
 *
 * A decision model's provider is a "backend" here (s23f): its failure says how long (a 429's `retry-after`), a 429
 * (`busy`) cools the whole provider, and a cooldown noted with a key's tag holds only while that key is the one read,
 * so a key changed by any means is tried at once.
 */
export function createCooldown(now: () => number) {
  const until = new Map<string, { kind: CoolKind; at: number; until: number; tag?: string }>();
  const keyOf = (kind: CoolKind, backend: string, model: string): string =>
    kind === 'auth' || kind === 'quota' || kind === 'busy' ? backend : `${backend}\n${model}`;

  return {
    /** The failure to repeat instead of calling the backend, while one is cooling. */
    check(backend: string, model: string, tag?: string): { kind: CoolKind; detail: string } | undefined {
      const t = now();
      for (const key of [backend, `${backend}\n${model}`]) {
        const hit = until.get(key);
        if (!hit) continue;
        if (t >= hit.until) {
          until.delete(key);
          continue;
        }
        if (hit.tag !== undefined && hit.tag !== tag) continue;
        const minutes = Math.floor((t - hit.at) / 60_000);
        return { kind: hit.kind, detail: `${minutes ? `${minutes} 分钟` : '不到 1 分钟'}前刚失败过，${Math.ceil((hit.until - hit.at) / 60_000)} 分钟内不再调` };
      }
      return undefined;
    },
    /** Records a backend failure; only a structured auth, quota, version or model one, or a decision model's busy, starts a cooldown. */
    note(backend: string, model: string, error: unknown, tag?: string): void {
      if (!(error instanceof JudgeCallError) || !error.structured) return;
      const kind = error.kind;
      if (!COOL_KINDS.includes(kind)) return;
      // only a decision model's 429 says how long; no backend reports busy structured today, and one that did
      // should not stop the backend for every smart group of the bot unasked (review)
      if (kind === 'busy' && !(error instanceof DecisionError)) return;
      const at = now();
      const end = at + (error instanceof DecisionError && error.coolMs !== undefined ? error.coolMs : JUDGE_COOLDOWN_MS);
      until.set(keyOf(kind as CoolKind, backend, model), { kind: kind as CoolKind, at, until: end, ...(tag ? { tag } : {}) });
      log.info('judge', 'cooldown', { backend, model, kind, until: end });
    },
  };
}
