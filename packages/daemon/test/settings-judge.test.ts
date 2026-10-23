import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentViewSchema, projectViewSchema } from '@vonvon/protocol';
import { paths } from '../src/config/paths';
import { loadConfig, saveConfig } from '../src/config/store';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createSettingsOwner, type SettingsOwnerDeps } from '../src/admin/settings';
import { parseModelQuery, parseSettingsEdit } from '../src/admin/settings-parse';
import type { AgentSettingsView, JudgeSelection, ProjectSettingsView } from '../src/admin/settings-types';
import { addProject, getProjectByName, updateProject } from '../src/project/registry';
import { readSmartPrompt } from '../src/judge/smart-file';
import { DEFAULT_SMART_PROMPT, JUDGE_CLAUDE_NOTE, JUDGE_CODEX_NOTE, JUDGE_FORMAT_LINES, JUDGE_INPUT_EXAMPLE } from '../src/judge/prompt';
import { DECISION_FORMAT_LINES, DECISION_INPUT_EXAMPLE, keyMissingText } from '../src/judge/decision';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend, ModelInfo, ReasoningEffort } from '../src/agent/types';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'settings-judge-'));
  return { botDir: (id: string) => join(appDir, 'bots', id), botPaths: (id: string) => ({ dir: join(appDir, 'bots', id) }), paths: { appDir, configFile: join(appDir, 'config.json'), projectsFile: join(appDir, 'projects.json'), sessionsFile: join(appDir, 'sessions.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments') } };
});

const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const model = (id: string, supportedEfforts: ReasoningEffort[], hidden = false): ModelInfo => ({ id, displayName: id, description: '', supportedEfforts, defaultEffort: supportedEfforts[0] ?? 'medium', isDefault: false, hidden });
const LISTS: Record<string, ModelInfo[]> = {
  'codex-appserver': [model('gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']), model('gpt-reserve', ['low'], true), model('flat', [])],
  'claude-agent': [model('haiku', ['low', 'high']), model('sonnet', ['low', 'high'])],
};
const fake = (id: string, list: ModelInfo[]) => ({
  id, displayName: id === 'claude-agent' ? 'Claude' : 'Codex', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'],
  listModels: async () => list, peekModels: () => list, loginStatus: async () => ({state:'signedIn',message:''}),
} as unknown as AgentBackend);
let backends: Record<string, AgentBackend>;
const botDir = () => join(paths.appDir, 'bot');
let cfg: AppConfig;
/** the keystore */
let secrets: Record<string, string> = {};

function owner(overrides: Partial<SettingsOwnerDeps> = {}) {
  return createSettingsOwner({
    cfg, writePreferences: createAppPreferencesWriter({ cfg }), backendFor: (id) => backends[id] ?? backends['codex-appserver']!,
    evictLiveSessionsForChat: vi.fn(async () => {}), readSmartPrompt: (appId, chatId) => readSmartPrompt(appId, chatId, botDir()), getSecret: async id => secrets[id], ...overrides,
  });
}
async function save(scope: typeof agent | typeof project, selection: JudgeSelection) {
  const o = owner();
  const view = await o.read(scope) as AgentSettingsView | ProjectSettingsView;
  return o.save({ scope, section: 'judge', revision: view.sections.judge.revision, patch: { selection } } as Parameters<typeof o.save>[0]);
}
/** Codex with no cached list, whose list calls made while `hold` is on wait for `release()`. */
function slowList() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = { hold: false, held: 0, release: () => release() };
  // a failing test still lets go, so the shared write locks do not stall the tests after it
  onTestFinished(() => release());
  backends['codex-appserver'] = { ...fake('codex-appserver', []), peekModels: () => undefined, listModels: async () => {
    if (state.hold) {
      state.held++;
      await gate;
    }
    return LISTS['codex-appserver']!;
  } } as unknown as AgentBackend;
  return state;
}
const messageOf = (result: Awaited<ReturnType<typeof save>>) => result.kind === 'rejected' ? result.fields[0]?.message : result.kind;
const JEV = { kind: 'decision', provider: 'typesafe', model: 'jev-latest' } as const;

beforeEach(async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(paths.appDir, 'no-claude'));
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  backends = Object.fromEntries(Object.entries(LISTS).map(([id, list]) => [id, fake(id, list)]));
  secrets = {};
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

  it('the bot layer leaves out the backend: the bot default backend (s36a), Codex when it has none', async () => {
    cfg.preferences = { defaults: { backend: 'claude-agent' } };
    await saveConfig(cfg);
    expect((await save(agent, { kind: 'llm', model: 'sonnet' })).kind).toBe('saved');
    expect((await loadConfig()).preferences?.judge).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'sonnet' });
  });

  it('stores a decision model as given, with no backend, on both layers', async () => {
    expect(await save(agent, { kind: 'decision', provider: 'typesafe', model: ' jev-latest ' })).toMatchObject({ kind: 'saved', section: { value: { stored: { selection: JEV } } } });
    expect((await loadConfig()).preferences?.judge).toEqual(JEV);
    expect((await save(project, JEV)).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.judge).toEqual(JEV);
  });

  it('a stale revision is a conflict', async () => {
    const o = owner();
    const view = await o.read(agent) as AgentSettingsView;
    expect((await save(agent, { kind: 'llm', model: 'gpt-6-luna' })).kind).toBe('saved');
    const late = await o.save({ scope: agent, section: 'judge', revision: view.sections.judge.revision, patch: { selection: { kind: 'default' } } });
    expect(late.kind).toBe('conflict');
  });

  it('takes purpose judge and the three kinds; refuses another kind', () => {
    expect(parseModelQuery({ botId, backend: 'claude-agent', purpose: 'judge' }).purpose).toBe('judge');
    expect(() => parseSettingsEdit({ scope: agent, section: 'judge', revision: 'x', patch: { selection: { kind: 'oracle', model: 'x' } } })).toThrow();
    expect(() => parseSettingsEdit({ scope: agent, section: 'judge', revision: 'x', patch: { selection: { kind: 'llm' } } })).toThrow();
    expect(() => parseSettingsEdit({ scope: agent, section: 'judge', revision: 'x', patch: { selection: { kind: 'decision', model: 'x' } } })).toThrow();
    expect(() => parseSettingsEdit({ scope: agent, section: 'judge', revision: 'x', patch: { selection: { ...JEV, backend: 'codex-appserver' } } })).toThrow();
    expect(parseSettingsEdit({ scope: project, section: 'judge', revision: 'x', patch: { selection: { kind: 'llm', model: 'm' } } }).section).toBe('judge');
    expect(parseSettingsEdit({ scope: project, section: 'judge', revision: 'x', patch: { selection: JEV } }).section).toBe('judge');
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
    [{ kind: 'decision', provider: 'Type Safe', model: 'jev-latest' }, '决策模型的 provider 只能是小写字母、数字和 -，40 个字以内'],
    [{ kind: 'decision', provider: 'typesafe', model: 'jev <latest>' }, '模型 ID 不能包含空格、换行、反引号或尖括号。'],
    [{ kind: 'decision', provider: 'openai', model: 'x' }, '没有 openai 这家决策模型，现在有：TypeSafe（typesafe）'],
    [{ kind: 'decision', provider: 'constructor', model: 'x' }, '没有 constructor 这家决策模型，现在有：TypeSafe（typesafe）'],
  ])('bot layer refuses %j', async (selection, message) => {
    expect(messageOf(await save(agent, selection))).toBe(message);
  });

  it('accepts a listed model with or without effort, and a model with no efforts without one', async () => {
    expect((await save(agent, { kind: 'llm', model: 'flat' })).kind).toBe('saved');
    expect((await save(agent, { kind: 'llm', backend: 'claude-agent', model: 'haiku', effort: 'low' })).kind).toBe('saved');
    expect((await loadConfig()).preferences?.judge).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'haiku', effort: 'low' });
  });

  it('keeps the model and its effort when the model list cannot be read (Rakazo 第二轮 A6)', async () => {
    backends['codex-appserver'] = { ...fake('codex-appserver', []), doctor: async () => ({ ok: false }), peekModels: () => undefined } as unknown as AgentBackend;
    expect((await save(agent, { kind: 'llm', model: 'gpt-6-luna', effort: 'minimal' })).kind).toBe('saved');
    expect((await loadConfig()).preferences?.judge).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'minimal' });
    const view = await owner().read(agent) as AgentSettingsView;
    // no cached list: the effort goes out as stored; once the list is there, it is fitted to low
    expect(view.judgeByBackend?.['codex-appserver']).toEqual({ model: 'gpt-6-luna', effort: 'minimal', source: 'bot' });
    backends['codex-appserver'] = fake('codex-appserver', LISTS['codex-appserver']!);
    expect((await owner().read(agent) as AgentSettingsView).judgeByBackend?.['codex-appserver']).toEqual({ model: 'gpt-6-luna', effort: 'low', source: 'bot' });
  });

  it('reads the model list outside the write locks: a slow list holds up no other save', async () => {
    const slow = slowList();
    const o = owner();
    const a = await o.read(agent) as AgentSettingsView;
    const p = await o.read(project) as ProjectSettingsView;
    slow.hold = true;
    const botJudge = o.save({ scope: agent, section: 'judge', revision: a.sections.judge.revision, patch: { selection: { kind: 'llm', model: 'gpt-6-luna' } } });
    const groupJudge = o.save({ scope: project, section: 'judge', revision: p.sections.judge.revision, patch: { selection: { kind: 'llm', model: 'gpt-6-luna' } } });
    await vi.waitFor(() => expect(slow.held).toBe(2));
    slow.hold = false;
    expect((await o.save({ scope: agent, section: 'cards', revision: a.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
    expect((await o.save({ scope: project, section: 'response', revision: p.sections.response.revision, patch: { noMention: true } })).kind).toBe('saved');
    slow.release();
    expect((await botJudge).kind).toBe('saved');
    expect((await groupJudge).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.judge).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' });
  });

  it('the bot default backend moving while the list is read is a conflict, not a model stored for the old one', async () => {
    const slow = slowList();
    const writePreferences = createAppPreferencesWriter({ cfg });
    const o = owner({ writePreferences });
    const a = await o.read(agent) as AgentSettingsView;
    slow.hold = true;
    const pending = o.save({ scope: agent, section: 'judge', revision: a.sections.judge.revision, patch: { selection: { kind: 'llm', model: 'gpt-6-luna' } } });
    await vi.waitFor(() => expect(slow.held).toBe(1));
    slow.hold = false;
    await writePreferences(prefs => { prefs.defaults = { backend: 'claude-agent' }; });
    slow.release();
    expect((await pending).kind).toBe('conflict');
    expect((await loadConfig()).preferences).toEqual({ defaults: { backend: 'claude-agent' } });
    // a model that names its backend did not depend on the default: it saves
    const again = slowList();
    const fresh = await o.read(agent) as AgentSettingsView;
    again.hold = true;
    const named = o.save({ scope: agent, section: 'judge', revision: fresh.sections.judge.revision, patch: { selection: { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' } } });
    await vi.waitFor(() => expect(again.held).toBe(1));
    again.hold = false;
    await writePreferences(prefs => { prefs.defaults = { backend: 'codex-appserver' }; });
    again.release();
    expect((await named).kind).toBe('saved');
    expect((await loadConfig()).preferences?.judge).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' });
  });

  it('checks against the cached list without probing the backend again', async () => {
    const doctor = vi.fn(async () => ({ ok: true }));
    backends['codex-appserver'] = { ...fake('codex-appserver', LISTS['codex-appserver']!), doctor } as unknown as AgentBackend;
    const o = owner();
    // reading the view back after a save probes too: count only what the save adds to that
    const probes = async (scope: typeof agent | typeof project, section: string, patch: Record<string, unknown>) => {
      const view = await o.read(scope) as AgentSettingsView | ProjectSettingsView;
      const before = doctor.mock.calls.length;
      const result = await o.save({ scope, section, revision: (view.sections as Record<string, { revision: string }>)[section]!.revision, patch } as Parameters<typeof o.save>[0]);
      return { kind: result.kind, probes: doctor.mock.calls.length - before };
    };
    const cards = await probes(agent, 'cards', { showToolCalls: false });
    expect(await probes(agent, 'judge', { selection: { kind: 'llm', model: 'gpt-6-luna', effort: 'high' } })).toEqual({ kind: 'saved', probes: cards.probes });
    expect(await probes(project, 'judge', { selection: { kind: 'llm', model: 'missing' } })).toEqual({ kind: 'rejected', probes: 0 });
  });

  it('a group can judge with another provider and fills its task provider in when omitted', async () => {
    expect(messageOf(await save(project, { kind: 'llm', backend: 'claude-agent', model: 'haiku', custom: true }))).toBe('saved');
    await updateProject('demo', { backend: 'claude-agent' });
    expect(messageOf(await save(project, { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna' }))).toBe('saved');
    expect((await save(project, { kind: 'llm', model: 'sonnet' })).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.judge).toEqual({ kind: 'llm', backend: 'claude-agent', model: 'sonnet' });
  });
});

describe('judge settings: the view', () => {
  it('effective follows design 2.2; judgeByBackend has a row per backend', async () => {
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
    expect(p.sections.judge.effective.selection).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'high' });
  });

  it('a decision model on the bot applies to every backend; a group can still choose its own', async () => {
    await save(agent, JEV);
    const o = owner();
    const a = await o.read(agent) as AgentSettingsView;
    expect(a.sections.judge.effective.selection).toEqual(JEV);
    expect(a.judgeByBackend).toEqual({ 'codex-appserver': { model: 'jev-latest', provider: 'typesafe', source: 'bot' }, 'claude-agent': { model: 'jev-latest', provider: 'typesafe', source: 'bot' } });
    expect((await o.read(project) as ProjectSettingsView).sections.judge.effective.selection).toEqual(JEV);
    await save(project, { kind: 'llm', model: 'gpt-6-luna' });
    expect((await o.read(project) as ProjectSettingsView).sections.judge.effective.selection).toEqual({ kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' });
  });

  it('lists the decision models and whether each key is in; choosing one without it says how to fill it in (s23f)', async () => {
    const o = owner();
    const listed = [{ provider: 'typesafe', displayName: 'TypeSafe', models: [{ id: 'jev-latest', displayName: 'Jev' }], keyId: 'typesafe-api-key', keySet: false }];
    expect((await o.read(agent) as AgentSettingsView).decisionModels).toEqual(listed);
    const missing = keyMissingText(listed[0]!);
    expect(missing).toContain('在网页的密钥页填，或者在终端运行 vonvon secrets set typesafe-api-key，按提示粘贴');
    expect(await save(project, JEV)).toMatchObject({ kind: 'saved', effects: [{ detail: '智能模式的下一次判断就用新模型' }, { fields: ['selection'], when: 'next-message', detail: missing }] });
    // a language model, or the key in: no such line
    expect(await save(agent, { kind: 'llm', model: 'gpt-6-luna' })).toMatchObject({ effects: [{ detail: '智能模式的下一次判断就用新模型' }] });
    secrets = { 'app-secret': 'x', 'typesafe-api-key': 'ts_TESTKEY0000' };
    expect(await save(agent, JEV)).toMatchObject({ effects: [{ detail: '智能模式的下一次判断就用新模型' }] });
    const p = await o.read(project) as ProjectSettingsView;
    expect(p.decisionModels).toEqual([{ ...listed[0], keySet: true }]);
    expect(projectViewSchema.safeParse(p).error?.issues).toBeUndefined();
    // s23g: by the judge's rule, a stored key no header carries is a missing one, not an unreadable keystore
    secrets = { 'typesafe-api-key': 'ts_TEST KEY0000' };
    expect((await o.read(project) as ProjectSettingsView).decisionModels).toEqual(listed);
    // a keystore it cannot read is said so, not taken for a missing key: filling one in would hit the same error
    const unreadable = owner({ getSecret: async () => { throw new Error('bad'); } });
    const u = await unreadable.read(project) as ProjectSettingsView;
    expect(u.decisionModels).toEqual([{ ...listed[0], keySet: false, keyUnreadable: true }]);
    expect(projectViewSchema.safeParse(u).error?.issues).toBeUndefined();
    const unread = keyMissingText(u.decisionModels![0]!);
    expect(unread).toBe('读不了密钥库，看不出填没填 TypeSafe 的 key，读得了之前要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区）。原因在网页状态与诊断页底部的 daemon 日志（secrets.unreadable），或者在终端运行 vonvon secrets list 看');
    await save(project, { kind: 'llm', model: 'gpt-6-luna' });
    const before = await unreadable.read(project) as ProjectSettingsView;
    const saved = await unreadable.save({ scope: project, section: 'judge', revision: before.sections.judge.revision, patch: { selection: JEV } } as Parameters<typeof unreadable.save>[0]);
    expect(saved).toMatchObject({ kind: 'saved', effects: [{ detail: '智能模式的下一次判断就用新模型' }, { detail: unread }] });
  });

  it('a kind this version does not know shows as stored, parses in the protocol and is never rewritten; a broken value shows as default', async () => {
    const future = { kind: 'oracle', provider: 'x', model: 'y', weights: [1, 2] };
    cfg.preferences = { judge: future as never, showToolCalls: true };
    await saveConfig(cfg);
    await updateProject('demo', { judge: JSON.parse('{"kind":"llm","backend":"codex-appserver","model":"two words"}') });
    const o = owner();
    const a = await o.read(agent) as AgentSettingsView;
    expect(a.sections.judge.stored.selection).toEqual(future);
    // the judge ignores it: the default small model
    expect(a.judgeByBackend?.['codex-appserver']).toEqual({ model: 'gpt-6-luna', effort: 'low', source: 'default' });
    const paths_ = { ...a.sections.paths, effective: { projectsRootDir: '/p' } }; // the mocked paths leave it unresolved
    expect(agentViewSchema.parse({ ...a, sections: { ...a.sections, paths: paths_ } }).sections.judge?.stored.selection).toEqual(future);
    const p = await o.read(project) as ProjectSettingsView;
    expect(p.sections.judge.stored.selection).toEqual({ kind: 'default' });
    expect(projectViewSchema.safeParse(p).error?.issues).toBeUndefined();
    // another section's save keeps it
    expect((await o.save({ scope: agent, section: 'cards', revision: a.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
    expect((await loadConfig()).preferences?.judge).toEqual(future);
  });

  it('smartPrompt: source, path, text, format lines, sample input; each backend\'s note', async () => {
    const o = owner();
    let a = await o.read(agent) as AgentSettingsView;
    expect(a.smartPrompt).toEqual({
      source: 'default', path: join(botDir(), 'SMART.md'), text: DEFAULT_SMART_PROMPT, formatLines: { ...JUDGE_FORMAT_LINES, mentioned: JUDGE_FORMAT_LINES.main },
      inputExample: JUDGE_INPUT_EXAMPLE, backendNote: `${JUDGE_CODEX_NOTE}\n${JUDGE_CLAUDE_NOTE}`, maxLength: 8000,
    });
    await mkdir(join(botDir(), 'groups', 'oc_demo'), { recursive: true });
    await writeFile(join(botDir(), 'SMART.md'), 'bot 的提示词');
    let p = await o.read(project) as ProjectSettingsView;
    expect(p.smartPrompt).toMatchObject({ source: 'bot', text: 'bot 的提示词', path: join(botDir(), 'groups', 'oc_demo', 'SMART.md'), backendNote: JUDGE_CODEX_NOTE });
    await writeFile(join(botDir(), 'groups', 'oc_demo', 'SMART.md'), '群的提示词');
    await updateProject('demo', { backend: 'claude-agent' });
    p = await o.read(project) as ProjectSettingsView;
    expect(p.smartPrompt).toMatchObject({ source: 'group', text: '群的提示词', backendNote: JUDGE_CLAUDE_NOTE });
    // a decision model gets none of a backend's extras, and its options and state in place of the format lines and input
    await save(project, JEV);
    p = await o.read(project) as ProjectSettingsView;
    expect(p.smartPrompt).not.toHaveProperty('backendNote');
    expect(p.smartPrompt).toMatchObject({ source: 'group', formatLines: { ...DECISION_FORMAT_LINES, mentioned: DECISION_FORMAT_LINES.main }, inputExample: DECISION_INPUT_EXAMPLE });
    await save(agent, JEV);
    expect((await o.read(agent) as AgentSettingsView).smartPrompt).toEqual({ source: 'bot', path: join(botDir(), 'SMART.md'), text: 'bot 的提示词', formatLines: { ...DECISION_FORMAT_LINES, mentioned: DECISION_FORMAT_LINES.main }, inputExample: DECISION_INPUT_EXAMPLE, maxLength: 8000 });
    await writeFile(join(botDir(), 'SMART.md'), 'x'.repeat(8001));
    a = await o.read(agent) as AgentSettingsView;
    expect(a.smartPrompt).toMatchObject({ error: 'SMART.md 超过 8000 字', path: join(botDir(), 'SMART.md'), text: '' });
  });
});

describe('provider-only group settings admission', () => {
  it('rejects a provider change after login expires and accepts it after login returns', async () => {
    backends['claude-agent'] = { ...fake('claude-agent', LISTS['claude-agent']!), loginStatus: async () => ({ state: 'signedOut', message: '' }) } as AgentBackend;
    const choice = { kind: 'provider' as const, provider: 'claude-agent' as const };
    expect(messageOf(await save(project, choice))).toContain('尚未登录');
    expect((await getProjectByName('demo'))?.judge).toBeUndefined();
    backends['claude-agent'] = fake('claude-agent', LISTS['claude-agent']!);
    expect((await save(project, choice)).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.judge).toEqual(choice);
  });
  it('checks the TypeSafe key before saving a provider selection', async () => {
    const choice = { kind: 'provider' as const, provider: 'typesafe' as const };
    expect(messageOf(await save(project, choice))).toContain('密钥');
    secrets = { 'typesafe-api-key': 'ts_TESTKEY0000' };
    expect((await save(project, choice)).kind).toBe('saved');
  });
});

describe('s25c: a 智能 group has no 免@ in its settings', () => {
  it('names the 会话方式 in the view and refuses a response save, which works again after a switch', async () => {
    await updateProject('demo', { kind: 'single', smart: true, noMention: false });
    const o = owner();
    const view = await o.read(project) as ProjectSettingsView;
    expect(view.identity.kind).toBe('smart');
    expect(projectViewSchema.parse(view).identity.kind).toBe('smart');
    const refused = await o.save({ scope: project, section: 'response', revision: view.sections.response.revision, patch: { noMention: true } });
    expect(refused).toEqual({ kind: 'rejected', fields: [{ field: 'settings', message: '这个群是智能开话题，回不回由 Bot 判断，没有免 @ 这一项。要用免 @，先在网页把会话方式改成多会话或单会话' }] });
    expect((await getProjectByName('demo'))?.noMention).toBe(false);
    await updateProject('demo', { smart: false });
    const single = await o.read(project) as ProjectSettingsView;
    expect(single.identity.kind).toBe('single');
    expect((await o.save({ scope: project, section: 'response', revision: single.sections.response.revision, patch: { noMention: true } })).kind).toBe('saved');
    expect((await getProjectByName('demo'))?.noMention).toBe(true);
  });
});
