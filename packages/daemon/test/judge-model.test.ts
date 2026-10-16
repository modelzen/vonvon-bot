import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeUserEnv, readConfiguredClaudeModel } from '../src/agent/claude-agent/configured-model';
import type { ModelInfo, ReasoningEffort } from '../src/agent/types';
import { claudeJudgeDefault, codexJudgeDefault, judgeEffort } from '../src/judge/model';

const model = (id: string, supportedEfforts: ReasoningEffort[]): ModelInfo => ({
  id, displayName: id, description: '', supportedEfforts, defaultEffort: supportedEfforts[0] ?? 'medium', isDefault: false, hidden: false,
});
const LUNA = model('gpt-6-luna', ['max', 'low', 'medium', 'high', 'xhigh']);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('judge default model', () => {
  it('takes the lowest effort the list gives', () => {
    expect(judgeEffort('gpt-6-luna', [LUNA])).toBe('low');
    expect(judgeEffort('m', [model('m', ['high', 'minimal', 'medium'])])).toBe('minimal');
    expect(judgeEffort('m', [model('m', ['low', 'none'])])).toBe('none');
    expect(judgeEffort('m', [model('m', [])])).toBeUndefined();
    expect(judgeEffort('gpt-6-luna', [LUNA], true)).toBeUndefined();
    expect(judgeEffort('my-gw/qwen', [LUNA], true)).toBeUndefined();
  });

  it('without a cached list: gpt-6-luna gets low, other models nothing', () => {
    expect(judgeEffort('gpt-6-luna', undefined)).toBe('low');
    expect(judgeEffort('gpt-6.1-sol', undefined)).toBeUndefined();
    expect(codexJudgeDefault(undefined)).toEqual({ model: 'gpt-6-luna', effort: 'low' });
  });

  it('falls back to another *-luna in the list', () => {
    expect(codexJudgeDefault([LUNA, model('gpt-6.1-luna', ['minimal'])])).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(codexJudgeDefault([model('gpt-6.1-sol', ['low']), model('gpt-6.1-luna', ['medium', 'low'])])).toEqual({ model: 'gpt-6.1-luna', effort: 'low' });
    expect(codexJudgeDefault([model('gpt-6.1-sol', ['low'])])).toEqual({ model: 'gpt-6-luna', effort: 'low' });
  });

  it('Claude judges on haiku unless a gateway is set', () => {
    expect(claudeJudgeDefault({}, {}, 'opus')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_MODEL: 'claude-opus' }, 'claude-opus')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 'opus')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://gw.example.com/v1', ANTHROPIC_MODEL: 'kimi' }, 'kimi')).toBe('kimi');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small' }, 'big')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_SMALL_FAST_MODEL: 'fast' }, 'big')).toBe('fast');
    expect(claudeJudgeDefault({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, {}, 'deepseek-chat')).toBe('deepseek-chat');
    expect(claudeJudgeDefault({ ANTHROPIC_BASE_URL: 'https://gw.example.com' }, {}, undefined)).toBe('haiku');
  });

  it('readClaudeUserEnv reads the settings env, strings only', () => {
    const home = mkdtempSync(join(tmpdir(), 'judge-claude-'));
    dirs.push(home);
    const env = { CLAUDE_CONFIG_DIR: join(home, 'c') } as NodeJS.ProcessEnv;
    expect(readClaudeUserEnv(env, home)).toEqual({});
    mkdirSync(join(home, 'c'));
    writeFileSync(join(home, 'c', 'settings.json'), JSON.stringify({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'https://gw', N: 1 } }));
    expect(readClaudeUserEnv(env, home)).toEqual({ ANTHROPIC_BASE_URL: 'https://gw' });
    expect(readConfiguredClaudeModel(env, home)).toBe('opus');
    writeFileSync(join(home, 'c', 'settings.json'), '{not json');
    expect(readClaudeUserEnv(env, home)).toEqual({});
  });
});
