import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { judgeProcessStats } from '../src/agent/codex-appserver/judge-process';
import { createJudge } from '../src/judge/judge';
import { DEFAULT_SMART_PROMPT, JUDGE_ALLOWED } from '../src/judge/prompt';
import type { JudgeLine, JudgeRequest, JudgeVariant } from '../src/judge/types';
import { filesWith } from './helpers/marker-scan';

/**
 * The real Codex judge on the owner's ChatGPT login (design 6.2). Skipped unless
 * VONVON_REAL_JUDGE=1; CI never runs it. Keeps the real HOME (the login lives there) and points
 * the data root (VONVON_HOME) and the judge cwd (VONVON_JUDGE_CWD) at a temporary directory.
 * `CODEX_BIN=<npm prefix>/node_modules/.bin/codex` runs it on another version, e.g. 0.156.1.
 * `VONVON_REAL_JUDGE_RUNS=<n>` repeats the two variants n times (e12).
 */
const REAL = process.env.VONVON_REAL_JUDGE === '1';
const RUNS = Math.max(1, Number(process.env.VONVON_REAL_JUDGE_RUNS ?? 1) || 1);
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const CLAUDE_HOME = join(homedir(), '.claude');

/** Never printed and never in an assertion message, so it stays out of this session's transcript. */
const marker = randomUUID();

const MESSAGES: Record<JudgeVariant, { text: string; mentions?: string[] }> = {
  main: { text: '今天食堂的红烧肉不错' },
  topic: { text: '这个报错能帮我看下吗' },
};

const request = (variant: JudgeVariant, extra: Partial<JudgeRequest> = {}): JudgeRequest => ({
  variant,
  appId: 'cli_realjudge',
  botName: '小码',
  group: { chatId: 'oc_realjudge', name: '测试群', backend: 'codex-appserver' },
  ...(variant === 'topic' ? { topicTitle: '订单接口报错' } : {}),
  context: [],
  message: { at: Date.now(), from: 'user', name: '张三', ...MESSAGES[variant], text: `${MESSAGES[variant].text} ${marker}` },
  ...extra,
});

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe.skipIf(!REAL)('真实 Codex 判断（VONVON_REAL_JUDGE=1）', () => {
  const started = Date.now() - 1000;
  const configPath = join(CODEX_HOME, 'config.toml');
  let configBefore: string | undefined;
  let ownCwd: string | undefined;
  let cwd: string;
  const judge = createJudge({
    backendFor: () => new CodexAppServerBackend(),
    readPrompt: async () => ({ source: 'default', text: DEFAULT_SMART_PROMPT, path: '' }),
    cwd: async () => cwd,
  });

  beforeAll(() => {
    try { configBefore = sha256(configPath); } catch { configBefore = undefined; }
    if (process.env.VONVON_JUDGE_CWD) cwd = process.env.VONVON_JUDGE_CWD;
    else cwd = ownCwd = mkdtempSync(join(tmpdir(), 'judge-real-cwd-'));
  });

  afterAll(async () => {
    await judge.shutdown();
    await shutdownResidentClients();
    if (ownCwd) rmSync(ownCwd, { recursive: true, force: true });
  });

  // first, so the first judgement starts the process
  it('复用：同一个进程；4 条并发都出结果', async () => {
    const spawned = judgeProcessStats().spawned;
    const first = await judge.judge(request('main'));
    const pid = judgeProcessStats().pid;
    expect(pid).toBeTypeOf('number');
    const second = await judge.judge(request('main'));
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(judgeProcessStats().pid).toBe(pid);
    // Logged, not asserted: the model's own latency (seconds) swamps the ~2 s cold start.
    console.log(JSON.stringify({ coldMs: first.ms, warmMs: second.ms }));
    const four = await Promise.all((['main', 'topic', 'topic', 'main'] as const).map(v => judge.judge(request(v))));
    expect(four.map(r => r.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(judgeProcessStats()).toMatchObject({ pid, spawned: spawned + 1, stuck: 0 });
  }, 120_000);

  it('两种变体：格式对，决定在这个变体允许的集合里', async () => {
    for (let run = 0; run < RUNS; run++) {
      for (const variant of ['main', 'topic'] as const) {
        const result = await judge.judge(request(variant));
        console.log(JSON.stringify({ variant, decision: result.decision, ms: result.ms, error: result.error?.kind }));
        expect(result.error).toBeUndefined();
        expect(JUDGE_ALLOWED[variant]).toContain(result.decision);
      }
    }
  }, 60_000 * RUNS);

  // product.md 3.4 例子第 3、4 行，主区没点名（s25 的分类；e12 里约 2.5% 会漏回，所以只记不断言第 3 行的去向）
  it('分类：发布要不要砍功能该接话，食堂闲聊不回', async () => {
    const ask = (text: string) => judge.judge(request('main', { message: { at: Date.now(), from: 'user', name: '张三', text: `${text} ${marker}` } }));
    for (let run = 0; run < RUNS; run++) {
      const release = await ask('下周发布要不要先砍掉导出功能？');
      const lunch = await ask('今天食堂的红烧肉不错');
      console.log(JSON.stringify({ release: release.decision, lunch: lunch.decision }));
      expect([release.error, lunch.error]).toEqual([undefined, undefined]);
      expect(lunch.decision).toBe('skip');
    }
  }, 60_000 * RUNS);

  // s25b：锚点只在主区没点名时问；模型指哪条是模型的事，只记下来（k/n），断言它在给的几条里。
  it('锚点：补一句的那条接的是前面的哪条', async () => {
    const at = Date.now();
    const context: JudgeLine[] = [
      { id: 'om_ask', at: at - 60_000, from: 'user', name: '张三', text: '导出接口 500 是谁在看？' },
      { id: 'om_mine', at: at - 30_000, from: 'user', name: '李四', text: '我在看' },
    ];
    for (let run = 0; run < RUNS; run++) {
      const result = await judge.judge(request('main', { context, message: { at, from: 'user', name: '张三', text: `补一句：是生产环境 ${marker}` } }));
      console.log(JSON.stringify({ decision: result.decision, anchor: result.anchor ?? 'm0' }));
      expect(result.error).toBeUndefined();
      expect([undefined, 'om_ask', 'om_mine']).toContain(result.anchor);
    }
  }, 60_000 * RUNS);

  it('超时：turn 跑起来以后超时，补发 interrupt，判断层兜底不回，进程照常用', async () => {
    const warm = await judge.judge(request('main'));
    expect(warm.error).toBeUndefined();
    const pid = judgeProcessStats().pid;
    const before = judgeProcessStats().interrupts;
    const timeoutMs = Math.max(800, Math.round(warm.ms * 0.6));
    const late = await judge.judge(request('main', { timeoutMs }));
    expect(late.error?.kind).toBe('timeout');
    expect(late.decision).toBe('skip');
    await vi.waitFor(() => expect(judgeProcessStats().interrupts).toBe(before + 1), { timeout: 20_000 });
    expect((await judge.judge(request('main'))).error).toBeUndefined();
    expect(judgeProcessStats().pid).toBe(pid);

    // Before any turnId (at most a late thread/start reply to unsubscribe): the process lives on.
    const instant = await judge.judge(request('main', { timeoutMs: 1 }));
    expect(instant.error?.kind).toBe('timeout');
    expect((await judge.judge(request('main'))).error).toBeUndefined();
    expect(judgeProcessStats()).toMatchObject({ pid, stuck: 0 });
  }, 120_000);

  it('副作用：config.toml 没变，聊天内容没写进 ~/.codex 和 ~/.claude', async () => {
    let after: string | undefined;
    try { after = sha256(configPath); } catch { after = undefined; }
    expect(after).toBe(configBefore);
    const hits = [...filesWith(CODEX_HOME, started, marker), ...filesWith(CLAUDE_HOME, started, marker)];
    expect(hits).toEqual([]);
  }, 120_000);
});
