import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeNodeExecutable } from './helpers/node-executable';

type RawModel = {
  id: string;
  model?: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
};
type FixtureState = {
  config: Record<string, unknown>;
  pages: Record<string, { data: RawModel[]; nextCursor?: string | null }> & {
    first: { data: RawModel[]; nextCursor?: string | null };
  };
  failModels?: boolean;
  failConfig?: boolean;
};
type Call = { pid: number; method: string; params: Record<string, unknown> };

let CodexAppServerBackend: typeof import('../src/agent/codex-appserver/backend').CodexAppServerBackend;
let shutdownResidentClients: typeof import('../src/agent/codex-appserver/client-pool').shutdownResidentClients;
let directory: string;
let state: FixtureState;
let configRevision: number;

const native = (id: string, isDefault = false): RawModel => ({
  id, displayName: `Native ${id}`, isDefault, hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  defaultReasoningEffort: 'high',
});

/** A real app-server process, with every config/model reply coming from the isolated fixture.
 * The model IDs deliberately bear no relation to Vonvon's built-in fallback catalog. */
const SERVER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0); }
const home = process.env.CODEX_HOME;
const send = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (typeof message.id !== 'number') return;
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({pid:process.pid, method:message.method, params:message.params || {}}) + '\n');
  if (message.method === 'initialize') return send(message.id, {});
  if (message.method === 'config/read') {
    if (state.failConfig) return process.stdout.write(JSON.stringify({id:message.id, error:{code:-32000, message:'fixture configuration unavailable'}}) + '\n');
    return send(message.id, {config:state.config, origins:{}, layers:null});
  }
  if (message.method === 'account/read') return send(message.id, {requiresOpenaiAuth:false, account:null});
  if (message.method === 'model/list') {
    if (state.failModels) return process.stdout.write(JSON.stringify({id:message.id, error:{code:-32000, message:'fixture model discovery unavailable'}}) + '\n');
    return send(message.id, state.pages[message.params?.cursor || 'first'] || {data:[], nextCursor:null});
  }
  if (message.method === 'thread/start') {
    const p = message.params;
    return send(message.id, {
      thread: {id: 'thread-' + process.pid}, cwd:p.cwd, runtimeWorkspaceRoots:p.runtimeWorkspaceRoots,
      approvalPolicy:p.approvalPolicy,
      sandbox: {type:p.sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess', networkAccess:false},
    });
  }
  if (message.method === 'turn/start') {
    const turn = {id:'turn-' + process.pid, status:'completed', items:[], error:null};
    send(message.id, {turn});
    return process.stdout.write(JSON.stringify({method:'turn/completed', params:{threadId:message.params.threadId, turn}}) + '\n');
  }
  send(message.id, {});
});
`;

function save(): void {
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  // Match the real change the user makes in Codex settings, including for cache invalidation.
  writeFileSync(join(directory, 'config.toml'), Object.entries(state.config)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n'));
  const changed = new Date(Date.now() + ++configRevision * 1000);
  utimesSync(join(directory, 'config.toml'), changed, changed);
}

function calls(): Call[] {
  return readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'codex-model-discovery-'));
  configRevision = 0;
  state = {config: {}, pages: {first: {data: [native('native-a', true), native('native-b')], nextCursor: null}}};
  save();
  const { bin } = writeNodeExecutable(directory, 'codex', SERVER);
  vi.stubEnv('CODEX_HOME', directory);
  vi.stubEnv('CODEX_BIN', bin);
  vi.stubEnv('VONVON_HOME', join(directory, 'vonvon'));
  vi.resetModules();
  ({ CodexAppServerBackend } = await import('../src/agent/codex-appserver/backend'));
  ({ shutdownResidentClients } = await import('../src/agent/codex-appserver/client-pool'));
});

afterEach(async () => {
  try { await shutdownResidentClients(); }
  finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
});

describe('Codex native model discovery follows the current local configuration', () => {
  it('includes an otherwise missing configured model and makes it the only default', async () => {
    state.config = {model: 'local-custom-model', model_provider: 'local-proxy', model_reasoning_effort: 'high'};
    save();
    const backend = new CodexAppServerBackend();
    const models = await backend.listModels();

    expect(models.find(model => model.id === 'local-custom-model')).toMatchObject({id: 'local-custom-model', isDefault: true, hidden: false});
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['local-custom-model']);
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining(['native-a', 'native-b']));
    expect(backend.peekModels()).toEqual(models);
    expect(calls().some(call => call.method === 'config/read')).toBe(true);
  });

  it('selects an already-listed configured model without duplicating or discarding its native metadata', async () => {
    state.config = {model: 'native-b', model_provider: 'openai'};
    save();
    const models = await new CodexAppServerBackend().listModels();

    expect(models.filter(model => model.id === 'native-b')).toHaveLength(1);
    expect(models.find(model => model.id === 'native-b')).toMatchObject({
      displayName: 'Native native-b', isDefault: true,
      supportedEfforts: ['low', 'high'], defaultEffort: 'high',
    });
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['native-b']);
  });

  it('leaves an unknown configured model’s effort to Codex instead of sending a guessed value', async () => {
    state.config = {model: 'local-no-effort-metadata', model_provider: 'local-proxy', model_reasoning_effort: 'high'};
    save();
    const backend = new CodexAppServerBackend();
    const models = await backend.listModels();
    expect(models.find(model => model.id === 'local-no-effort-metadata')?.supportedEfforts).toEqual([]);

    const thread = await backend.startThread({cwd: directory, mode: 'full', model: 'local-no-effort-metadata', effort: 'medium'});
    try {
      const events = [];
      for await (const event of thread.runStreamed({text: 'fixture turn'}).events) events.push(event);
      expect(events.some(event => event.type === 'done')).toBe(true);
      const turnCalls = calls().filter(call => call.method === 'turn/start');
      expect(turnCalls).toHaveLength(1);
      expect(turnCalls[0]!.params.model).toBe('local-no-effort-metadata');
      expect(turnCalls[0]!.params).not.toHaveProperty('effort');
    } finally { await thread.close(); }
  });

  it('keeps an existing custom-model thread’s effort behavior after the discovered default changes', async () => {
    state.config = {model: 'custom-before-refresh', model_provider: 'local-proxy'};
    save();
    const backend = new CodexAppServerBackend();
    expect((await backend.listModels()).find(model => model.id === 'custom-before-refresh')?.supportedEfforts).toEqual([]);
    const thread = await backend.startThread({cwd: directory, mode: 'full', model: 'custom-before-refresh', effort: 'medium'});
    try {
      state.config = {model: 'custom-after-refresh', model_provider: 'local-proxy'};
      save();
      const refreshed = await backend.listModels();
      expect(refreshed.find(model => model.isDefault)?.id).toBe('custom-after-refresh');
      expect(refreshed.some(model => model.id === 'custom-before-refresh')).toBe(false);

      const events = [];
      for await (const event of thread.runStreamed({text: 'existing thread after config refresh'}).events) events.push(event);
      expect(events.some(event => event.type === 'done')).toBe(true);
      const turnCalls = calls().filter(call => call.method === 'turn/start');
      expect(turnCalls).toHaveLength(1);
      expect(turnCalls[0]!.params.model).toBe('custom-before-refresh');
      expect(turnCalls[0]!.params).not.toHaveProperty('effort');
    } finally { await thread.close(); }
  });

  it('preserves the provider-discovered catalog when no local model is configured', async () => {
    const models = await new CodexAppServerBackend().listModels();

    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['native-a']);
    expect(models.every(model => model.displayName.startsWith('Native '))).toBe(true);
  });

  it('uses the native wire model name rather than a distinct picker row ID', async () => {
    state.config = {model: 'wire-model-name', model_provider: 'local-proxy'};
    state.pages.first.data = [{...native('internal-picker-row', true), model: 'wire-model-name'}];
    save();
    const models = await new CodexAppServerBackend().listModels();

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'wire-model-name', displayName: 'Native internal-picker-row', isDefault: true,
      supportedEfforts: ['low', 'high'], defaultEffort: 'high',
    });
    expect(models.some(model => model.id === 'internal-picker-row')).toBe(false);
  });

  it('reads every native catalog page instead of stopping at the first response', async () => {
    state.pages.first.nextCursor = 'next-page';
    state.pages['next-page'] = {data: [native('native-c')], nextCursor: null};
    save();
    const models = await new CodexAppServerBackend().listModels();

    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b', 'native-c']);
    expect(calls().filter(call => call.method === 'model/list').map(call => call.params.cursor ?? null)).toEqual([null, 'next-page']);
  });

  it('refreshes the configured default on the same backend without accumulating stale custom rows', async () => {
    state.config = {model: 'local-before', model_provider: 'local-proxy'};
    save();
    const backend = new CodexAppServerBackend();
    expect((await backend.listModels()).find(model => model.isDefault)?.id).toBe('local-before');

    state.config = {model: 'local-after', model_provider: 'local-proxy'};
    save();
    const refreshed = await backend.listModels();
    expect(refreshed.find(model => model.isDefault)?.id).toBe('local-after');
    expect(refreshed.some(model => model.id === 'local-before')).toBe(false);
    expect(backend.peekModels()).toEqual(refreshed);

    state.config = {};
    save();
    const restored = await backend.listModels();
    expect(restored.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(restored.find(model => model.isDefault)?.id).toBe('native-a');
  });

  it('refreshes an edited model_catalog_json file when config.toml itself is unchanged', async () => {
    const catalogFile = join(directory, 'models.json');
    state.config = {model_catalog_json: catalogFile};
    state.pages.first.data = [native('catalog-before', true)];
    writeFileSync(catalogFile, JSON.stringify({models: state.pages.first.data}));
    save();
    const configMtime = statSync(join(directory, 'config.toml')).mtimeMs;
    const backend = new CodexAppServerBackend();
    expect((await backend.listModels()).map(model => model.id)).toEqual(['catalog-before']);

    state.pages.first.data = [native('catalog-after', true)];
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
    writeFileSync(catalogFile, JSON.stringify({models: state.pages.first.data}));
    const changed = new Date(Date.now() + 5000);
    utimesSync(catalogFile, changed, changed);
    expect(statSync(join(directory, 'config.toml')).mtimeMs).toBe(configMtime);

    const refreshed = await backend.listModels();
    expect(refreshed.map(model => model.id)).toEqual(['catalog-after']);
    expect(backend.peekModels()).toEqual(refreshed);
  });

  it('returns the native catalog to both concurrent cold discoveries with model_catalog_json configured', async () => {
    const catalogFile = join(directory, 'models.json');
    state.config = {model_catalog_json: catalogFile};
    state.pages.first.data = [native('concurrent-catalog-model', true)];
    writeFileSync(catalogFile, JSON.stringify({models: state.pages.first.data}));
    save();
    const backend = new CodexAppServerBackend();

    const results = await Promise.all([backend.listModels(), backend.listModels()]);

    expect(results.map(models => models.map(model => model.id))).toEqual([
      ['concurrent-catalog-model'], ['concurrent-catalog-model'],
    ]);
    expect(backend.peekModels()?.map(model => model.id)).toEqual(['concurrent-catalog-model']);
  });

  it('does not treat a directory as confirmed discovery when native config/read fails', async () => {
    state.failConfig = true;
    save();
    const backend = new CodexAppServerBackend();
    await backend.listModels();
    expect(backend.peekModels()).toBeUndefined();

    state.failConfig = false;
    save();
    const models = await backend.listModels();
    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(backend.peekModels()).toEqual(models);
  });

  it('rejects a repeated pagination cursor without caching an incomplete directory', async () => {
    state.pages.first.nextCursor = 'loop';
    state.pages.loop = {data: [native('native-c')], nextCursor: 'loop'};
    save();
    const backend = new CodexAppServerBackend();
    await backend.listModels();

    expect(backend.peekModels()).toBeUndefined();
    expect(calls().filter(call => call.method === 'model/list').length).toBeLessThanOrEqual(3);
  });

  it('does not cache a fixed fallback as successful discovery after a native catalog failure', async () => {
    state.failModels = true;
    save();
    const backend = new CodexAppServerBackend();
    await backend.listModels();
    expect(backend.peekModels()).toBeUndefined();

    state.failModels = false;
    save();
    const models = await backend.listModels();
    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(backend.peekModels()).toEqual(models);
  });
});
