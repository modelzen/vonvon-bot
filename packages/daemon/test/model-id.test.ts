import { describe, expect, it } from 'vitest';
import { CUSTOM_MODEL_OPTION, MODEL_ID_MAX_LENGTH, parseModelId } from '../src/agent/model-id';

describe('parseModelId', () => {
  it('accepts third-party ids verbatim after trimming', () => {
    for (const id of [
      'deepseek-chat',
      'moonshotai/kimi-k2',
      'qwen2.5-coder:7b',
      'claude-opus-4-8[1m]',
      'us.anthropic.claude-sonnet-4-5-v1:0',
      'claude-sonnet-4-5@20250929',
      'MiniMax-M2.7',
    ]) {
      expect(parseModelId(`  ${id}\t`)).toEqual({ ok: true, id });
    }
    expect(parseModelId('x'.repeat(MODEL_ID_MAX_LENGTH))).toMatchObject({ ok: true });
  });

  it('rejects what cannot be an id', () => {
    for (const raw of [
      undefined,
      '',
      '   ',
      'x'.repeat(MODEL_ID_MAX_LENGTH + 1),
      'two words',
      'line\nbreak',
      'nul\u0000',
      'tick`',
      '<at',
      'a>b',
      '--model',
      CUSTOM_MODEL_OPTION,
    ]) {
      expect(parseModelId(raw)).toMatchObject({ ok: false });
    }
  });
});
