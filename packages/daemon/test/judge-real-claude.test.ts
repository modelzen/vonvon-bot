import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAgentBackend } from '../src/agent/claude-agent/backend';
import { claudeConfigDir } from '../src/agent/claude-agent/configured-model';
import { createJudge } from '../src/judge/judge';
import { DEFAULT_SMART_PROMPT, JUDGE_ALLOWED } from '../src/judge/prompt';
import type { JudgeLine, JudgeRequest, JudgeVariant } from '../src/judge/types';
import { filesWith } from './helpers/marker-scan';

/**
 * The real Claude judge on the owner's claude.ai login (design 6.2, s23c). Skipped unless
 * VONVON_REAL_JUDGE=1; CI never runs it. Keeps the real HOME (the login lives there) and points
 * the data root (VONVON_HOME) and the judge cwd (VONVON_JUDGE_CWD) at a temporary directory. The
 * judge cwd gets an empty `memory/` folder under ~/.claude/projects (s23c spike), so pass a fixed
 * VONVON_JUDGE_CWD across runs. `VONVON_REAL_JUDGE_RUNS=<n>` repeats the three variants n times (e12).
 */
const REAL = process.env.VONVON_REAL_JUDGE === '1';
const RUNS = Math.max(1, Number(process.env.VONVON_REAL_JUDGE_RUNS ?? 1) || 1);
const CLAUDE_HOME = claudeConfigDir();
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');

/** Never printed and never in an assertion message, so it stays out of this session's transcript. */
const marker = randomUUID();

const MESSAGES: Record<JudgeVariant, { text: string; mentions?: string[] }> = {
  main: { text: '今天食堂的红烧肉不错' },
  mentioned: { text: '@小码 订单接口一直报 500', mentions: ['小码'] },
  topic: { text: '这个报错能帮我看下吗' },
};

const request = (variant: JudgeVariant, extra: Partial<JudgeRequest> = {}): JudgeRequest => ({
  variant,
  appId: 'cli_realjudge',
  botName: '小码',
  group: { chatId: 'oc_realjudge', name: '测试群', backend: 'claude-agent' },
  ...(variant === 'topic' ? { topicTitle: '订单接口报错' } : {}),
  context: [],
  message: { at: Date.now(), from: 'user', name: '张三', ...MESSAGES[variant], text: `${MESSAGES[variant].text} ${marker}` },
  ...extra,
});

const sha256 = (path: string): string | undefined => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return undefined; }
};

describe.skipIf(!REAL)('真实 Claude 判断（VONVON_REAL_JUDGE=1）', () => {
  const started = Date.now() - 1000;
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  const settingsBefore = sha256(settingsPath);
  let ownCwd: string | undefined;
  let cwd: string;
  const judge = createJudge({
    backendFor: () => new ClaudeAgentBackend(),
    readPrompt: async () => ({ source: 'default', text: DEFAULT_SMART_PROMPT, path: '' }),
    cwd: async () => cwd,
  });

  beforeAll(() => {
    if (process.env.VONVON_JUDGE_CWD) cwd = process.env.VONVON_JUDGE_CWD;
    else cwd = ownCwd = mkdtempSync(join(tmpdir(), 'judge-real-cwd-'));
  });

  afterAll(async () => {
    await judge.shutdown();
    if (ownCwd) rmSync(ownCwd, { recursive: true, force: true });
  });

  it('haiku，字符串 systemPrompt：三种变体格式对，决定在这个变体允许的集合里', async () => {
    for (let run = 0; run < RUNS; run++) {
      for (const variant of ['main', 'mentioned', 'topic'] as const) {
        const result = await judge.judge(request(variant));
        console.log(JSON.stringify({ variant, model: result.model, decision: result.decision, ms: result.ms, error: result.error?.kind }));
        expect(result.error).toBeUndefined();
        expect(JUDGE_ALLOWED[variant]).toContain(result.decision);
        expect(result.modelSource).toBe('default');
      }
    }
  }, 90_000 * RUNS);

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

  it('副作用：settings.json 没变，聊天内容没写进 ~/.claude 和 ~/.codex', () => {
    expect(sha256(settingsPath)).toBe(settingsBefore);
    const hits = [...filesWith(CLAUDE_HOME, started, marker), ...filesWith(CODEX_HOME, started, marker)];
    expect(hits).toEqual([]);
  }, 120_000);
});
