import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentViewSchema, projectViewSchema } from '@vonvon/protocol';
import { paths } from '../src/config/paths';
import { loadConfig, saveConfig } from '../src/config/store';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createSettingsOwner } from '../src/admin/settings';
import { parseModelQuery, parseSettingsEdit } from '../src/admin/settings-parse';
import type { AgentSettingsView, JudgeSelection, ProjectSettingsView } from '../src/admin/settings-types';
import { addProject, getProjectByName, updateProject } from '../src/project/registry';
import { readSmartPrompt } from '../src/judge/smart-file';
import { DEFAULT_SMART_PROMPT, JUDGE_CODEX_NOTE, JUDGE_FORMAT_LINES, JUDGE_INPUT_EXAMPLE } from '../src/judge/prompt';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend, ModelInfo, ReasoningEffort } from '../src/agent/types';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'settings-judge-'));
  return { paths: { appDir, configFile: join(appDir, 'config.json'), projectsFile: join(appDir, 'projects.json'), sessionsFile: join(appDir, 'sessions.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments') } };
});

const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const model = (id: string, supportedEfforts: ReasoningEffort[], hidden = false): ModelInfo => ({ id, displayName: id, description: '', supportedEfforts, defaultEffort: supportedEfforts[0] ?? 'medium', isDefault: false, hidden });
const LISTS: Record<string, ModelInfo[]> = {
  'codex-appserver': [model('gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']), model('gpt-reserve', ['low'], true), model('flat', [])],
  'claude-agent': [model('haiku', ['low', 'high']), model('sonnet', ['low', 'high'])],
};
const backends = Object.fromEntries(Object.entries(LISTS).map(([id, list]) => [id, {
  id, displayName: id === 'claude-agent' ? 'Claude' : 'Codex', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'],
  listModels: async () => list, peekModels: () => list,
} as unknown as AgentBackend]));
const botDir = () => join(paths.appDir, 'bot');
let cfg: AppConfig;

function owner() {
  return createSettingsOwner({
    cfg, writePreferences: createAppPreferencesWriter({ cfg }), backendFor: (id) => backends[id] ?? backends['codex-appserver']!,
    evictLiveSessionsForChat: vi.fn(async () => {}), readSmartPrompt: (appId, chatId) => readSmartPrompt(appId, chatId, botDir()),
  });
}
async function save(scope: typeof agent | typeof project, selection: JudgeSelection) {
  const o = owner();
  const view = await o.read(scope) as AgentSettingsView | ProjectSettingsView;
  return o.save({ scope, section: 'judge', revision: view.sections.judge.revision, patch: { selection } } as Parameters<typeof o.save>[0]);
}
const messageOf = (result: Awaited<ReturnType<typeof save>>) => result.kind === 'rejected' ? result.fields[0]?.message : result.kind;

beforeEach(async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(paths.appDir, 'no-claude'));
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  await rm(paths.appDir, { recursive: true, force: true }); await mkdir(paths.appDir, { recursive: true });
  cfg = { accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 's' } } }, preferences: {} } as unknown as AppConfig;
  await saveConfig(cfg);
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

describe('judge settings: store and remove (design 2.1, 2.5)', () => {
  it('saves both layers with the backend filled in, and default removes the field', async () => {
    expect(await save(agent, { kind: 'llm', model: 'gpt-6-luna', effort: 'low' })).toMatchObject({
      kind: 'saved', effects: [{ when: 'next-message', detail: '智能模式的下一次判断就用新模型' }],
      section: { value: { stored: { selection: { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' } } } },
    });
    expect((await loadConfig()).preferences?.judge).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' });
    expect((await save(project, { kind: 'llm', model: 'my-gw/qwen3-coder', custom: true })).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.judge).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'my-gw/qwen3-coder', custom: true });
    expect((await save(project, { kind: 'default' })).kind).toBe('saved');
    expect(await getProjectByName('demo')).not.toHaveProperty('judge');
    expect((await save(agent, { kind: 'default' })).kind).toBe('saved');
    expect((await loadConfig()).preferences).not.toHaveProperty('judge');
  });

  it('a stale revision is a conflict', async () => {
    const o = owner();
    const view = await o.read(agent) as AgentSettingsView;
    expect((await save(agent, { kind: 'llm', model: 'gpt-6-luna' })).kind).toBe('saved');
    const late = await o.save({ scope: agent, section: 'judge', revision: view.sections.judge.revision, patch: { selection: { kind: 'default' } } });
    expect(late.kind).toBe('conflict');
  });

  it('takes purpose judge and the judge selection shape; refuses another kind', () => {
    expect(parseModelQuery({ botId, backend: 'claude-agent', purpose: 'judge' }).purpose).toBe('judge');
    expect(() => parseSettingsEdit({ scope: agent, section: 'judge', revision: 'x', patch: { selection: { kind: 'decision', model: 'x' } } })).toThrow();
    expect(() => parseSettingsEdit({ scope: agent, section: 'judge', revision: 'x', patch: { selection: { kind: 'llm' } } })).toThrow();
    expect(parseSettingsEdit({ scope: project, section: 'judge', revision: 'x', patch: { selection: { kind: 'llm', model: 'm' } } }).section).toBe('judge');
  });
});

describe('judge settings: checks (design 2.4)', () => {
  it.each<[JudgeSelection, string]>([
    [{ kind: 'llm', model: 'missing' }, '列表里没有这个模型；手填的 id 加 "custom":true'],
    [{ kind: 'llm', model: 'gpt-reserve' }, '列表里没有这个模型；手填的 id 加 "custom":true'],
    [{ kind: 'llm', model: 'gpt-6-luna', effort: 'minimal' }, '这个模型不支持这个推理强度'],
    [{ kind: 'llm', model: 'flat', effort: 'low' }, '这个模型不支持推理强度，effort 不能写'],
    [{ kind: 'llm', model: 'two words', custom: true }, '模型 ID 不能包含空格、换行、反引号或尖括号。'],
    [{ kind: 'llm', backend: 'claude-agent', model: 'haiku', effort: 'ultra', custom: true }, '当前后端不支持这个推理强度'],
    [{ kind: 'llm', backend: 'gemini', model: 'x', custom: true }, '未知后端'],
  ])('bot layer refuses %j', async (selection, message) => {
    expect(messageOf(await save(agent, selection))).toBe(message);
  });

  it('accepts a listed model with or without effort, and a model with no efforts without one', async () => {
    expect((await save(agent, { kind: 'llm', model: 'flat' })).kind).toBe('saved');
    expect((await save(agent, { kind: 'llm', backend: 'claude-agent', model: 'haiku', effort: 'low' })).kind).toBe('saved');
    expect((await loadConfig()).preferences?.judge).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'haiku', effort: 'low' });
  });

  it('a group takes only its own backend, which it fills in when left out', async () => {
    expect(messageOf(await save(project, { kind: 'llm', backend: 'claude-agent', model: 'haiku', custom: true }))).toBe('这个群用 Codex，判断模型要选 Codex 的模型');
    await updateProject('demo', { backend: 'claude-agent' });
    expect(messageOf(await save(project, { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' }))).toBe('这个群用 Claude，判断模型要选 Claude 的模型');
    expect((await save(project, { kind: 'llm', model: 'sonnet' })).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.judge).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'sonnet' });
  });
});

describe('judge settings: the view', () => {
  it('effective follows design 2.2; judgeByBackend has a row per backend; old-shaped values read as default', async () => {
    let o = owner();
    let a = await o.read(agent) as AgentSettingsView;
    expect(a.sections.judge.stored).toEqual({ selection: { kind: 'default' } });
    expect(a.sections.judge.effective).toEqual({ selection: { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' } });
    expect(a.judgeByBackend).toEqual({ 'codex-appserver': { model: 'gpt-6-luna', effort: 'low', source: 'default' }, 'claude-agent': { model: 'haiku', source: 'default' } });

    await save(agent, { kind: 'llm', backend: 'claude-agent', model: 'sonnet' });
    o = owner();
    a = await o.read(agent) as AgentSettingsView;
    expect(a.sections.judge.effective.selection).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'sonnet' });
    expect(a.judgeByBackend).toEqual({ 'codex-appserver': { model: 'gpt-6-luna', effort: 'low', source: 'default' }, 'claude-agent': { model: 'sonnet', source: 'bot' } });
    // a Codex group: the bot's Claude model does not apply
    let p = await o.read(project) as ProjectSettingsView;
    expect(p.sections.judge.effective.selection).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' });
    // the group's own setting stays when the group switches backend, and stops applying
    await save(project, { kind: 'llm', model: 'gpt-6-luna', effort: 'high' });
    await updateProject('demo', { backend: 'claude-agent' });
    p = await o.read(project) as ProjectSettingsView;
    expect(p.sections.judge.stored.selection).toMatchObject({ backend: 'codex-appserver', effort: 'high' });
    expect(p.sections.judge.effective.selection).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'sonnet' });

    // hand-edited into a shape the protocol would refuse
    await updateProject('demo', { judge: JSON.parse('{"kind":"decision","provider":"openai","model":"x"}') });
    p = await o.read(project) as ProjectSettingsView;
    expect(p.sections.judge.stored.selection).toEqual({ kind: 'default' });
    expect(projectViewSchema.safeParse(p).error?.issues).toBeUndefined();
    // (the mocked paths leave projectsRootDir unresolved, which is not this test's business)
    const paths_ = { ...a.sections.paths, effective: { projectsRootDir: '/p' } };
    expect(agentViewSchema.safeParse({ ...a, sections: { ...a.sections, paths: paths_ } }).error?.issues).toBeUndefined();
  });

  it('smartPrompt: source, path, text, format lines, sample input; the Codex note on Codex groups only', async () => {
    const o = owner();
    let a = await o.read(agent) as AgentSettingsView;
    expect(a.smartPrompt).toEqual({
      source: 'default', path: join(botDir(), 'SMART.md'), text: DEFAULT_SMART_PROMPT, formatLines: JUDGE_FORMAT_LINES,
      inputExample: JUDGE_INPUT_EXAMPLE, backendNote: JUDGE_CODEX_NOTE, maxLength: 8000,
    });
    await mkdir(join(botDir(), 'groups', 'oc_demo'), { recursive: true });
    await writeFile(join(botDir(), 'SMART.md'), 'bot 的提示词');
    let p = await o.read(project) as ProjectSettingsView;
    expect(p.smartPrompt).toMatchObject({ source: 'bot', text: 'bot 的提示词', path: join(botDir(), 'groups', 'oc_demo', 'SMART.md'), backendNote: JUDGE_CODEX_NOTE });
    await writeFile(join(botDir(), 'groups', 'oc_demo', 'SMART.md'), '群的提示词');
    await updateProject('demo', { backend: 'claude-agent' });
    p = await o.read(project) as ProjectSettingsView;
    expect(p.smartPrompt).toMatchObject({ source: 'group', text: '群的提示词' });
    expect(p.smartPrompt).not.toHaveProperty('backendNote');
    await writeFile(join(botDir(), 'SMART.md'), 'x'.repeat(8001));
    a = await o.read(agent) as AgentSettingsView;
    expect(a.smartPrompt).toMatchObject({ error: 'SMART.md 超过 8000 字', path: join(botDir(), 'SMART.md'), text: '' });
  });
});
