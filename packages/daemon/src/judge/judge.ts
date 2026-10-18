import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogBackendIds } from '../agent/catalog';
import { BackendNotInstalledError } from '../agent/backend-loader';
import { ProviderProcessCleanupError } from '../agent/owned-process';
import { DEFAULT_BACKEND_ID, JudgeCallError, type AgentBackend, type JudgeCallOutput } from '../agent/types';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { createCooldown } from './cooldown';
import { parseStoredJudge, resolveJudgeModel } from './model';
import { judgeSchema, judgeSystem, parseVerdict, renderJudgeInput } from './prompt';
import { readSmartPrompt, SmartPromptError } from './smart-file';
import type { JudgeDecision, JudgeErrorKind, JudgeRequest, JudgeResult } from './types';

/** From the call to the result, queueing and a cold start included (design 3.2). A mention always
 * gets a reply and the judgement only picks where, so it waits less. e12: warm judgements took at most
 * 7.9 s (Codex) and 6.1 s (Claude), a new Codex judge process 10.3 to 11.1 s; 12 s covers those, 20 s
 * a warm judgement queued one round. */
export const JUDGE_TIMEOUT_MS = { main: 20_000, mentioned: 12_000, topic: 20_000 } as const;
/** How long an aborted backend call may take to clean up before its slot is given back anyway. */
export const JUDGE_SETTLE_MS = 15_000;
/** After a model-list fetch that left nothing cached, how long before trying again. */
export const MODEL_LIST_RETRY_MS = 5 * 60_000;
/** Per backend, per bot process. A Claude judgement runs a CLI of about 340 MB (e12: median 338 MB,
 * at most about 380 MB), so two are about 0.7 GB; four Codex judgements run truly in parallel on one
 * judge process. */
const LIMITS: Record<string, { running: number; queued: number }> = {
  'codex-appserver': { running: 4, queued: 16 },
  'claude-agent': { running: 2, queued: 16 },
};
const OTHER_LIMIT = { running: 2, queued: 16 };

export interface Judge {
  /** Never rejects: a failure still gives a decision (design 第 4 节) and says why in `error`. */
  judge(req: JudgeRequest): Promise<JudgeResult>;
  /** Fetch the backend's model list in the background (s23b also starts the Codex judge process). */
  warm(backend: string): void;
  /** Ends every queued and running judgement as `closed`; resolves once the backend calls settle. */
  shutdown(): Promise<void>;
}

export interface JudgeDeps {
  backendFor(id: string): AgentBackend;
  /** s38 swaps in the bot file module */
  readPrompt?: typeof readSmartPrompt;
  /** default `<data root>/judge`, 0700, empty */
  cwd?: () => Promise<string>;
  now?: () => number;
  /** s25 counts judgements per group per hour, s28 per day */
  onResult?: (req: JudgeRequest, result: JudgeResult) => void;
}

/** Ends a judgement early; the reason of the shared AbortController. */
class JudgeAbort extends Error {
  constructor(readonly kind: 'timeout' | 'aborted' | 'closed') {
    super(kind === 'timeout' ? '判断超时' : kind === 'aborted' ? '调用方放弃了' : 'bot 正在关闭');
    this.name = 'JudgeAbort';
  }
}

/** A failure the judge layer finds itself. */
class JudgeFail extends Error {
  constructor(readonly kind: JudgeErrorKind, message: string) {
    super(message);
  }
}

/** Running and queued slots of one backend. A slot is given back only when the backend call settles. */
class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: { running: number; queued: number }) {}

  /** Resolves holding a slot; rejects with `busy` when the queue is full, or the abort reason. */
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.running < this.limit.running) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.limit.queued) return Promise.reject(new JudgeFail('busy', '判断排队满了'));
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', leave);
        resolve();
      };
      const leave = (): void => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', leave, { once: true });
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight on
    else this.running--;
  }
}

function fallback(variant: JudgeRequest['variant'], kind: JudgeErrorKind): JudgeDecision {
  if (kind === 'aborted' || kind === 'closed') return 'skip';
  return variant === 'mentioned' ? 'main' : 'skip';
}

function kindOf(error: unknown): JudgeErrorKind {
  if (error instanceof JudgeAbort || error instanceof JudgeFail || error instanceof JudgeCallError) return error.kind;
  if (error instanceof SmartPromptError) return 'prompt';
  if (error instanceof BackendNotInstalledError) return 'unavailable';
  return 'failed';
}

/** First line, controls dropped, 120 characters (as `errorDetail` in bot/diagnostics). */
function detailOf(error: unknown): string | undefined {
  const text = (error instanceof Error ? error.message : String(error ?? '')).split('\n')[0]!.replace(/[\x00-\x1f\x7f]/g, '').trim();
  const path = error instanceof SmartPromptError && error.path ? `：${error.path}` : '';
  return text ? `${text}${path}`.slice(0, 120) : undefined;
}

export function createJudge(deps: JudgeDeps): Judge {
  const now = deps.now ?? Date.now;
  const readPrompt = deps.readPrompt ?? readSmartPrompt;
  let cwdOnce: Promise<string> | undefined;
  const cwd = deps.cwd ?? (() => {
    const dir = join(paths.appDir, 'judge');
    cwdOnce ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => dir, (error: unknown) => {
      cwdOnce = undefined;
      throw error;
    });
    return cwdOnce;
  });
  const limiters = new Map<string, Limiter>();
  const cooldown = createCooldown(now);
  /** Stored settings already reported as unusable, so each is logged once. */
  const ignored = new Set<string>();
  const listFetch = new Map<string, { running: boolean; retryAt: number }>();
  /** Controllers of judgements not yet settled, aborted on shutdown. */
  const live = new Set<AbortController>();
  /** Backend calls not yet settled (or force-released), awaited by shutdown. */
  const settling = new Set<Promise<void>>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  function limiterFor(id: string): Limiter {
    let limiter = limiters.get(id);
    if (!limiter) limiters.set(id, limiter = new Limiter(LIMITS[id] ?? OTHER_LIMIT));
    return limiter;
  }

  /** One background `listModels()` per backend at a time, never awaited by a judgement. When it
   * leaves nothing cached (Codex returns its static list without caching), not again for 5 minutes,
   * so a failing list does not start and kill a utility process on every message. */
  function fetchModels(backend: AgentBackend): void {
    if (closed || !backend.peekModels || backend.peekModels()) return;
    const state = listFetch.get(backend.id) ?? { running: false, retryAt: 0 };
    listFetch.set(backend.id, state);
    if (state.running || now() < state.retryAt) return;
    state.running = true;
    const done = (): void => {
      state.running = false;
      let cached: unknown;
      try { cached = backend.peekModels?.(); } catch { /* counts as not cached */ }
      if (!cached) state.retryAt = now() + MODEL_LIST_RETRY_MS;
    };
    try {
      backend.listModels().then(done, done);
    } catch {
      done();
    }
  }

  /** A stored setting, or nothing (logged once per layer and value) when it cannot be used. */
  function storedJudge(value: unknown, layer: string) {
    const parsed = parseStoredJudge(value, catalogBackendIds());
    if (parsed.why) {
      const key = `${layer}\n${JSON.stringify(value)}`;
      if (!ignored.has(key)) {
        ignored.add(key);
        log.warn('judge', 'setting-ignored', { layer, why: parsed.why });
      }
    }
    return parsed.value;
  }

  /** Give the slot back when the backend call settles, or 15 s after the judgement was aborted. */
  function releaseWhenSettled(limiter: Limiter, call: Promise<unknown>, signal: AbortSignal, backend: string): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortedAt = 0;
      const onAbort = (): void => {
        abortedAt = now();
        timer = setTimeout(() => {
          log.warn('judge', 'slow-settle', { backend, ms: now() - abortedAt });
          release();
        }, JUDGE_SETTLE_MS);
        timer.unref?.();
      };
      let done = false;
      release = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        limiter.release();
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    settling.add(released);
    void released.then(() => settling.delete(released));
    call.then(() => release(), () => release());
  }

  async function run(req: JudgeRequest, started: number): Promise<JudgeResult> {
    const fields = { chatId: req.group.chatId, ref: req.ref?.slice(-6), variant: req.variant };
    // Backend and model first, so every later failure still reports them.
    let base: Pick<JudgeResult, 'backend' | 'model' | 'effort' | 'modelSource' | 'promptSource'> = {
      backend: req.group.backend ?? DEFAULT_BACKEND_ID, model: '', modelSource: 'default', promptSource: 'default',
    };
    let queueMs: number | undefined;
    const finish = (result: JudgeResult, extra: Record<string, unknown> = {}): JudgeResult => {
      const common = { ...fields, backend: result.backend, model: result.model, effort: result.effort, modelSource: result.modelSource, promptSource: result.promptSource, ms: result.ms, queueMs, ...extra };
      if (result.error) {
        // the caller giving up and shutdown are not faults: info, so a shutdown does not fill the terminal with warnings
        const quiet = result.error.kind === 'aborted' || result.error.kind === 'closed';
        log[quiet ? 'info' : 'warn']('judge', 'failed', { ...common, kind: result.error.kind, detail: result.error.detail });
      }
      else log.info('judge', 'verdict', { ...common, decision: result.decision });
      try {
        deps.onResult?.(req, result);
      } catch (error) {
        log.fail('judge', error, { phase: 'on-result' });
      }
      return result;
    };
    const fail = (error: unknown): JudgeResult => {
      const kind = kindOf(error);
      const detail = kind === 'format' ? '模型没按格式回答' : detailOf(error);
      return finish({ decision: fallback(req.variant, kind), reason: '', error: { kind, ...(detail ? { detail } : {}) }, ...base, ms: now() - started });
    };

    if (closed) return fail(new JudgeAbort('closed'));
    const ctl = new AbortController();
    const timeoutMs = req.timeoutMs ?? JUDGE_TIMEOUT_MS[req.variant];
    const timer = setTimeout(() => ctl.abort(new JudgeAbort('timeout')), timeoutMs);
    timer.unref?.();
    const onCallerAbort = (): void => ctl.abort(new JudgeAbort('aborted'));
    if (req.signal?.aborted) onCallerAbort();
    else req.signal?.addEventListener('abort', onCallerAbort, { once: true });
    live.add(ctl);
    const aborted = new Promise<never>((_, reject) => {
      if (ctl.signal.aborted) reject(ctl.signal.reason);
      else ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
    });
    aborted.catch(() => undefined);

    try {
      const backend = deps.backendFor(base.backend);
      const models = backend.peekModels?.();
      if (backend.peekModels && !models) fetchModels(backend);
      base = {
        ...base, backend: backend.id,
        ...resolveJudgeModel(backend.id, { group: storedJudge(req.group.judge, req.group.chatId), bot: storedJudge(req.botJudge, 'bot') }, models),
      };

      // Steps 3 to 6 race the shared controller: a stuck file read, queue or backend still returns
      // on time. The backend call keeps running and cleans up on its own; its slot waits for that.
      const work = (async (): Promise<JudgeCallOutput> => {
        const prompt = await readPrompt(req.appId, req.group.chatId);
        base = { ...base, promptSource: prompt.source };
        if (!backend.judge) throw new JudgeFail('unavailable', `${backend.displayName} 不支持判断`);
        const cooling = cooldown.check(backend.id, base.model);
        if (cooling) throw new JudgeFail(cooling.kind, cooling.detail);
        const dir = await cwd();
        const limiter = limiterFor(backend.id);
        const queuedAt = now();
        await limiter.acquire(ctl.signal);
        queueMs = now() - queuedAt;
        let call: Promise<JudgeCallOutput>;
        if (ctl.signal.aborted) {
          // granted in the same tick as the abort: hand the slot straight back
          limiter.release();
          throw ctl.signal.reason;
        }
        // a judgement that ran while this one queued may have just started a cooldown
        const cooledWhileQueued = cooldown.check(backend.id, base.model);
        if (cooledWhileQueued) {
          limiter.release();
          throw new JudgeFail(cooledWhileQueued.kind, cooledWhileQueued.detail);
        }
        try {
          call = backend.judge({
            system: judgeSystem(prompt.text, req.variant),
            input: renderJudgeInput(req),
            model: base.model,
            ...(base.effort ? { effort: base.effort } : {}),
            schema: judgeSchema(req.variant),
            cwd: dir,
            signal: ctl.signal,
          });
        } catch (error) {
          call = Promise.reject(error);
        }
        const { model } = base;
        call.catch((error: unknown) => {
          cooldown.note(backend.id, model, error);
          // The result already says timeout, aborted or closed; a process the call could not clean up
          // (it needed SIGKILL, pipes stayed open, its exit was never confirmed) would go unreported.
          if (ctl.signal.aborted && error instanceof ProviderProcessCleanupError) log.fail('judge', error, { phase: 'abandoned-call', backend: backend.id });
        });
        releaseWhenSettled(limiter, call, ctl.signal, backend.id);
        return call;
      })();
      work.catch(() => undefined);
      const output = await Promise.race([work, aborted]);
      const verdict = parseVerdict(req.variant, output);
      if (!verdict) throw new JudgeFail('format', '模型没按格式回答');
      const usage = output.usage;
      return finish({ ...verdict, ...base, ms: now() - started }, {
        cold: output.cold, inputTokens: usage?.input, cachedTokens: usage?.cached, outputTokens: usage?.output, reasoningTokens: usage?.reasoning,
      });
    } catch (error) {
      // Once the controller fired, its reason names the failure, whatever the backend threw after.
      return fail(ctl.signal.aborted ? ctl.signal.reason : error);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCallerAbort);
      live.delete(ctl);
    }
  }

  return {
    judge(req) {
      const started = now();
      return run(req, started).catch((error: unknown) => {
        // run() catches its own failures; this is the last guard of "never rejects".
        log.fail('judge', error, { phase: 'judge' });
        return {
          decision: fallback(req.variant, 'failed'), reason: '', error: { kind: 'failed' as const, detail: detailOf(error) },
          backend: req.group.backend ?? DEFAULT_BACKEND_ID, model: '', modelSource: 'default' as const, promptSource: 'default' as const, ms: now() - started,
        };
      });
    },
    warm(id) {
      if (closed) return;
      try {
        fetchModels(deps.backendFor(id));
      } catch (error) {
        log.fail('judge', error, { phase: 'warm' });
      }
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      for (const ctl of live) ctl.abort(new JudgeAbort('closed'));
      shutdownPromise = Promise.all([...settling]).then(() => undefined);
      return shutdownPromise;
    },
  };
}
