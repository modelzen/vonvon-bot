import { JudgeCallError } from '../agent/types';
import { log } from '../core/logger';
import type { JudgeErrorKind } from './types';

/** After a structured auth, quota, version or model failure, how long the judge skips the backend. */
export const JUDGE_COOLDOWN_MS = 5 * 60_000;

type CoolKind = Extract<JudgeErrorKind, 'auth' | 'quota' | 'version' | 'model'>;

/**
 * Cooldown after a failure the backend reported with a structured code (design 第 4 节): auth and
 * quota cool the whole backend, version and model only that backend with that model. A kind only
 * guessed from the message text (`structured: false`) never cools: the text rules are broad, and one
 * misread would stop every smart group of the bot for 5 minutes.
 */
export function createCooldown(now: () => number) {
  const until = new Map<string, { kind: CoolKind; at: number; until: number }>();
  const keyOf = (kind: CoolKind, backend: string, model: string): string =>
    kind === 'auth' || kind === 'quota' ? backend : `${backend}\n${model}`;

  return {
    /** The failure to repeat instead of calling the backend, while one is cooling. */
    check(backend: string, model: string): { kind: CoolKind; detail: string } | undefined {
      const t = now();
      for (const key of [backend, `${backend}\n${model}`]) {
        const hit = until.get(key);
        if (!hit) continue;
        if (t >= hit.until) {
          until.delete(key);
          continue;
        }
        const minutes = Math.floor((t - hit.at) / 60_000);
        return { kind: hit.kind, detail: `${minutes ? `${minutes} 分钟` : '不到 1 分钟'}前刚失败过，5 分钟内不再调` };
      }
      return undefined;
    },
    /** Records a backend failure; only a structured auth, quota, version or model one starts a cooldown. */
    note(backend: string, model: string, error: unknown): void {
      if (!(error instanceof JudgeCallError) || !error.structured) return;
      const kind = error.kind;
      if (kind !== 'auth' && kind !== 'quota' && kind !== 'version' && kind !== 'model') return;
      const at = now();
      until.set(keyOf(kind, backend, model), { kind, at, until: at + JUDGE_COOLDOWN_MS });
      log.info('judge', 'cooldown', { backend, model, kind, until: at + JUDGE_COOLDOWN_MS });
    },
  };
}
