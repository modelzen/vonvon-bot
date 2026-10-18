import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClaudeUserSettings, readConfiguredClaudeModel } from '../src/agent/claude-agent/configured-model';
import type { AgentBackend, JudgeCall, ModelInfo, ReasoningEffort } from '../src/agent/types';
import { createJudge } from '../src/judge/judge';
import { claudeJudgeDefault, codexJudgeDefault, defaultJudgeModel, judgeEffort, parseStoredJudge, resolveJudgeModel } from '../src/judge/model';
import type { JudgeSelectionStored } from '../src/judge/types';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

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

  it('Claude judges on haiku unless a gateway is set', () => {
    expect(defaultJudgeModel('claude-agent', undefined, () => ({ env: {}, configuredModel: 'opus' }))).toEqual({ model: 'haiku' });
    expect(defaultJudgeModel('claude-agent', undefined, () => ({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' }, configuredModel: 'kimi' }))).toEqual({ model: 'kimi' });
    expect(claudeJudgeDefault({}, {}, 'opus')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_MODEL: 'claude-opus' }, 'claude-opus')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 'opus')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://gw.example.com/v1', ANTHROPIC_MODEL: 'kimi' }, 'kimi')).toBe('kimi');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small' }, 'big')).toBe('haiku');
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_SMALL_FAST_MODEL: 'fast' }, 'big')).toBe('fast');
    expect(claudeJudgeDefault({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, {}, 'deepseek-chat')).toBe('deepseek-chat');
    expect(claudeJudgeDefault({ ANTHROPIC_BASE_URL: 'https://gw.example.com' }, {}, undefined)).toBe('haiku');
    // not a URL: no gateway, so Haiku even with a configured model
    expect(claudeJudgeDefault({}, { ANTHROPIC_BASE_URL: 'gw.example.com', ANTHROPIC_SMALL_FAST_MODEL: 'fast' }, 'big')).toBe('haiku');
    expect(claudeJudgeDefault({ ANTHROPIC_BASE_URL: 'not a url' }, {}, 'big')).toBe('haiku');
  });

  it('readClaudeUserSettings reads settings.json once: the env (strings only) and the configured model', () => {
    const home = mkdtempSync(join(tmpdir(), 'judge-claude-'));
    dirs.push(home);
    const env = { CLAUDE_CONFIG_DIR: join(home, 'c') } as NodeJS.ProcessEnv;
    expect(readClaudeUserSettings(env, home)).toEqual({ env: {}, configuredModel: undefined });
    mkdirSync(join(home, 'c'));
    writeFileSync(join(home, 'c', 'settings.json'), JSON.stringify({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'https://gw', N: 1 } }));
    expect(readClaudeUserSettings(env, home)).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://gw' }, configuredModel: 'opus' });
    expect(readConfiguredClaudeModel(env, home)).toBe('opus');
    writeFileSync(join(home, 'c', 'settings.json'), '{not json');
    expect(readClaudeUserSettings(env, home)).toEqual({ env: {}, configuredModel: undefined });
  });

  it('the Claude default reads settings.json again only after it changes (s23c review S3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-claude-cache-'));
    dirs.push(dir);
    const file = join(dir, 'settings.json');
    const write = (model: string, mtime: number) => {
      writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_SMALL_FAST_MODEL: model } }));
      utimesSync(file, mtime, mtime);
    };
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_MODEL']) vi.stubEnv(key, '');
    try {
      write('m-one', 1_700_000_000);
      expect(defaultJudgeModel('claude-agent', undefined)).toEqual({ model: 'm-one' });
      // same size and mtime: not read again
      write('m-two', 1_700_000_000);
      expect(defaultJudgeModel('claude-agent', undefined)).toEqual({ model: 'm-one' });
      write('m-two', 1_700_000_005);
      expect(defaultJudgeModel('claude-agent', undefined)).toEqual({ model: 'm-two' });
      rmSync(file);
      expect(defaultJudgeModel('claude-agent', undefined)).toEqual({ model: 'haiku' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const IDS = ['codex-appserver', 'claude-agent'];
const llm = (backend: string, model: string, extra: Partial<JudgeSelectionStored> = {}): JudgeSelectionStored => ({ kind: 'llm', backend, model, ...extra });
const noClaude = () => ({ env: {}, configuredModel: undefined });

describe('judge model layers (design 2.2)', () => {
  it('row 1: the group setting for this backend wins', () => {
    expect(resolveJudgeModel('codex-appserver', { group: llm('codex-appserver', 'g', { effort: 'high' }), bot: llm('codex-appserver', 'b') }, undefined))
      .toEqual({ model: 'g', effort: 'high', modelSource: 'group' });
  });

  it('rows 2 and 3: a group setting for another backend (the group switched) falls to the bot for this one', () => {
    expect(resolveJudgeModel('claude-agent', { group: llm('codex-appserver', 'g'), bot: llm('claude-agent', 'sonnet') }, undefined, noClaude))
      .toEqual({ model: 'sonnet', modelSource: 'bot' });
    expect(resolveJudgeModel('codex-appserver', { bot: llm('codex-appserver', 'b', { effort: 'medium' }) }, undefined))
      .toEqual({ model: 'b', effort: 'medium', modelSource: 'bot' });
  });

  it('row 4: a bot setting for another backend gives this backend its default small model', () => {
    expect(resolveJudgeModel('claude-agent', { bot: llm('codex-appserver', 'gpt-6-luna') }, undefined, noClaude))
      .toEqual({ model: 'haiku', modelSource: 'default' });
    expect(resolveJudgeModel('codex-appserver', { group: llm('claude-agent', 'haiku'), bot: llm('claude-agent', 'haiku') }, undefined))
      .toEqual({ model: 'gpt-6-luna', effort: 'low', modelSource: 'default' });
    expect(resolveJudgeModel('codex-appserver', {}, undefined)).toEqual({ model: 'gpt-6-luna', effort: 'low', modelSource: 'default' });
  });

  it('a setting without effort: Codex the lowest the list gives, none for custom ids and for Claude', () => {
    const list = [model('m', ['high', 'medium'])];
    expect(resolveJudgeModel('codex-appserver', { bot: llm('codex-appserver', 'm') }, list)).toEqual({ model: 'm', effort: 'medium', modelSource: 'bot' });
    expect(resolveJudgeModel('codex-appserver', { bot: llm('codex-appserver', 'm', { custom: true }) }, list)).toEqual({ model: 'm', modelSource: 'bot' });
    expect(resolveJudgeModel('claude-agent', { group: llm('claude-agent', 'gpt-6-luna') }, [LUNA])).toEqual({ model: 'gpt-6-luna', modelSource: 'group' });
  });

  it('parseStoredJudge checks the effort against the backend: Claude takes low to max, Codex the whole ladder', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(parseStoredJudge({ kind: 'llm', backend: 'claude-agent', model: 'haiku', effort }, IDS).value?.effort).toBe(effort);
    }
    for (const effort of ['none', 'minimal', 'ultra']) {
      expect(parseStoredJudge({ kind: 'llm', backend: 'claude-agent', model: 'haiku', effort }, IDS)).toEqual({ why: '推理强度这个后端不收' });
      expect(parseStoredJudge({ kind: 'llm', backend: 'codex-appserver', model: 'm', effort }, IDS).value?.effort).toBe(effort);
    }
    expect(parseStoredJudge({ kind: 'llm', backend: 'codex-appserver', model: 'm', effort: 'tiny' }, IDS).value).toBeUndefined();
  });

  it('parseStoredJudge keeps a good value and says why a bad one counts as unset', () => {
    expect(parseStoredJudge(undefined, IDS)).toEqual({});
    expect(parseStoredJudge({ kind: 'llm', backend: 'claude-agent', model: ' haiku ', effort: 'low', custom: true }, IDS))
      .toEqual({ value: { kind: 'llm', backend: 'claude-agent', model: 'haiku', effort: 'low', custom: true } });
    expect(parseStoredJudge({ kind: 'llm', backend: 'codex-appserver', model: 'm', custom: false }, IDS)).toEqual({ value: llm('codex-appserver', 'm') });
    for (const bad of [
      'gpt', { kind: 'decision', provider: 'openai', model: 'x' }, { kind: 'llm', backend: 'gemini', model: 'x' },
      { kind: 'llm', backend: 'codex-appserver', model: 'two words' }, { kind: 'llm', backend: 'codex-appserver', model: 'm', effort: 'tiny' },
      { kind: 'llm', backend: 'codex-appserver', model: 'm', custom: 'yes' },
    ]) {
      expect(parseStoredJudge(bad, IDS).value).toBeUndefined();
      expect(parseStoredJudge(bad, IDS).why).toBeTruthy();
    }
  });

  it('the judge uses the layers, reports modelSource, and logs a bad stored value once', async () => {
    const calls: JudgeCall[] = [];
    const backend = {
      id: 'codex-appserver', displayName: 'Codex', listModels: async () => [], peekModels: () => [LUNA],
      judge: async (call: JudgeCall) => { calls.push(call); return { text: '{"decision":"skip","reason":""}' }; },
    } as unknown as AgentBackend;
    const judge = createJudge({ backendFor: () => backend, readPrompt: async () => ({ source: 'default', text: 'S', path: '' }), cwd: async () => '/j' });
    const req = (judgeSetting: unknown, botJudge: unknown) => ({
      variant: 'main' as const, appId: 'cli_a', botName: 'P', botJudge,
      group: { chatId: 'oc_g', name: 'g', backend: 'codex-appserver', judge: judgeSetting as JudgeSelectionStored },
      context: [], message: { at: 0, from: 'user' as const, name: 'u', text: 't' },
    });
    expect(await judge.judge(req(llm('codex-appserver', 'gpt-6-luna', { effort: 'high' }), undefined))).toMatchObject({ model: 'gpt-6-luna', effort: 'high', modelSource: 'group' });
    expect(await judge.judge(req(undefined, llm('codex-appserver', 'gpt-6-luna')))).toMatchObject({ effort: 'low', modelSource: 'bot' });
    fake.log.warn.mockClear();
    const bad = { kind: 'decision', model: 'x' };
    for (let i = 0; i < 3; i++) expect(await judge.judge(req(bad, bad))).toMatchObject({ model: 'gpt-6-luna', modelSource: 'default' });
    const ignored = fake.log.warn.mock.calls.filter((c) => c[1] === 'setting-ignored');
    expect(ignored.map((c) => c[2].layer)).toEqual(['oc_g', 'bot']);
    expect(calls.at(-1)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
  });
});
