import { describe, expect, it } from 'vitest';
import type { ModelInfo, ReasoningEffort } from '../src/agent/types';
import { codexJudgeDefault, defaultJudgeModel, judgeEffort } from '../src/judge/model';

const model = (id: string, supportedEfforts: ReasoningEffort[]): ModelInfo => ({
  id, displayName: id, description: '', supportedEfforts, defaultEffort: supportedEfforts[0] ?? 'medium', isDefault: false, hidden: false,
});
const LUNA = model('gpt-6-luna', ['max', 'low', 'medium', 'high', 'xhigh']);

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

  it('Claude judges on haiku', () => {
    expect(defaultJudgeModel('claude-agent', undefined)).toEqual({ model: 'haiku' });
  });
});
