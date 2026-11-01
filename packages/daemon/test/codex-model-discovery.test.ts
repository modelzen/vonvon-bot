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
  serviceTiers?: { id: string; name: string; description: string }[];
  additionalSpeedTiers?: string[];
};
type FixtureState = {
  config: Record<string, unknown>;
  pages: Record<string, { data: RawModel[]; nextCursor?: string | null }> & {
    first: { data: RawModel[]; nextCursor?: string | null };
  };
  failModels?: boolean;
  failConfig?: boolean;
  account?: { type: string; planType?: string } | null;
  requirements?: { requirements: { featureRequirements?: Record<string, boolean> } | null; supportsIndependentSpeedModes?: boolean };
  remoteCache?: { fetchedAt?: string; identity?: string; clientVersion?: string; skipWrite?: boolean };
  cwdConfig?: Record<string, unknown>;
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
    return send(message.id, {config:message.params?.cwd?.endsWith('restricted-session') && state.cwdConfig ? {...state.config,...state.cwdConfig} : state.config, origins:{}, layers:null});
  }
  if (message.method === 'account/read') return send(message.id, {requiresOpenaiAuth:!!state.account, account:state.account || null});
  if (message.method === 'configRequirements/read') return send(message.id, state.requirements || {requirements:null, supportsIndependentSpeedModes:true});
  if (message.method === 'model/list') {
    if (state.failModels) return process.stdout.write(JSON.stringify({id:message.id, error:{code:-32000, message:'fixture model discovery unavailable'}}) + '\n');
    if (state.remoteCache && !state.remoteCache.skipWrite) fs.writeFileSync(path.join(home,'models_cache.json'),JSON.stringify({fetched_at:state.remoteCache.fetchedAt || new Date().toISOString(),identity:state.remoteCache.identity ?? 'fixture-account-bound-identity',client_version:state.remoteCache.clientVersion || '0.156.1',models:Object.values(state.pages).flatMap(page=>page.data).map(model=>({slug:model.model || model.id,service_tiers:model.serviceTiers,additional_speed_tiers:model.additionalSpeedTiers}))}));
    return send(message.id, state.pages[message.params?.cursor || 'first'] || {data:[], nextCursor:null});
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const p = message.params;
    return send(message.id, {
      thread: {id: p.threadId || 'thread-' + process.pid}, cwd:p.cwd, runtimeWorkspaceRoots:p.runtimeWorkspaceRoots,
      approvalPolicy:p.approvalPolicy,
      sandbox: {type:p.sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess', networkAccess:false},
    });
  }
  if (message.method === 'turn/start') {
    if (JSON.stringify(message.params.input).includes('reject tier')) return process.stdout.write(JSON.stringify({id:message.id, error:{code:-32000, message:'fixture turn rejected'}}) + '\n');
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

describe('Codex model discovery preserves the native picker directory', () => {
  function enableRemoteAccess(): void {
    state.account = {type:'chatgpt', planType:'pro'};
    state.remoteCache = {};
    writeFileSync(join(directory,'auth.json'),'{}');
  }

  it('normalizes confirmed native priority and legacy fast tiers without guessing Pro dollar amounts', async () => {
    enableRemoteAccess();
    state.pages.first.data = [
      { ...native('native-a', true), serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Fast response' }, { id: 'ultrafast', name: 'Ultrafast', description: 'Highest speed' }] },
      { ...native('native-b'), additionalSpeedTiers: ['fast'] },
    ];
    save();
    const models = await new CodexAppServerBackend().listModels();
    expect(models[0]?.serviceTiers).toEqual([{id:'fast',name:'Fast',description:'Fast response'},{id:'ultrafast',name:'Ultrafast',description:'Highest speed'}]);
    expect(models[1]?.serviceTiers).toEqual([{ id: 'fast', name: 'Fast', description: '' }]);
  });

  it('never exposes bundled acceleration metadata while signed out', async () => {
    state.pages.first.data = [{...native('native-a'), serviceTiers:[{id:'priority',name:'Fast',description:''},{id:'ultrafast',name:'Ultrafast',description:''}]}];
    save();
    expect((await new CodexAppServerBackend().listModels())[0]?.serviceTiers).toBeUndefined();
  });

  it('does not treat a Pro plan name or local model catalog as Ultrafast permission', async () => {
    enableRemoteAccess();
    state.config = {model_catalog_json:join(directory,'custom-models.json')};
    state.pages.first.data = [{...native('native-a'),serviceTiers:[{id:'ultrafast',name:'Ultrafast',description:''}]}];
    writeFileSync(join(directory,'custom-models.json'),'{}');save();
    expect((await new CodexAppServerBackend().listModels())[0]?.serviceTiers).toBeUndefined();
  });

  it.each(['missing','stale','wrong-version','before-login','keychain','custom-route'])(
    'hides acceleration with %s account evidence', async scenario => {
      enableRemoteAccess();
      state.pages.first.data = [{...native('native-a'),serviceTiers:[{id:'priority',name:'Fast',description:''}]}];
      if(scenario==='missing')state.remoteCache=undefined;
      if(scenario==='stale')state.remoteCache={fetchedAt:new Date(Date.now()-301_000).toISOString()};
      if(scenario==='wrong-version')state.remoteCache={clientVersion:'0.100.0'};
      if(scenario==='before-login')state.remoteCache={fetchedAt:new Date(Date.now()-10_000).toISOString()};
      if(scenario==='keychain')state.config={cli_auth_credentials_store:'keyring'};
      if(scenario==='custom-route')state.config={model_providers:{openai:{base_url:'https://fixture.invalid'}}};
      save();expect((await new CodexAppServerBackend().listModels())[0]?.serviceTiers).toBeUndefined();
    });

  it('applies workspace restrictions including the older shared fast gate', async () => {
    enableRemoteAccess();state.pages.first.data=[{...native('native-a'),serviceTiers:[{id:'priority',name:'Fast',description:''},{id:'ultrafast',name:'Ultrafast',description:''}]}];
    state.requirements={requirements:{featureRequirements:{fast_mode:false}},supportsIndependentSpeedModes:false};save();
    expect((await new CodexAppServerBackend().listModels())[0]?.serviceTiers).toEqual([]);
    state.requirements.supportsIndependentSpeedModes=true;save();
    expect((await new CodexAppServerBackend().listModels())[0]?.serviceTiers?.map(tier=>tier.id)).toEqual(['ultrafast']);
    state.requirements.requirements!.featureRequirements!.ultrafast_mode=false;save();
    expect((await new CodexAppServerBackend().listModels())[0]?.serviceTiers).toEqual([]);
  });

  it('invalidates cached eligibility after account change and native metadata expiry', async () => {
    enableRemoteAccess();state.pages.first.data=[{...native('native-a'),serviceTiers:[{id:'priority',name:'Fast',description:''}]}];save();
    const backend=new CodexAppServerBackend();expect((await backend.listModels())[0]?.serviceTiers?.[0]?.id).toBe('fast');
    writeFileSync(join(directory,'auth.json'),'{"changed":true}');expect(backend.peekModels()).toBeUndefined();
    await backend.listModels();
    const now=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(now+301_000);
    try{expect(backend.peekModels()?.[0]?.id).toBe('native-a');expect(backend.peekModels()?.[0]?.serviceTiers).toBeUndefined();}finally{clock.mockRestore();}
  });

  it('constrains account tiers by the actual session cwd configuration', async () => {
    enableRemoteAccess();state.pages.first.data=[{...native('native-a'),serviceTiers:[{id:'priority',name:'Fast',description:''}]}];
    state.cwdConfig={features:{fast_mode:false}};save();
    const backend=new CodexAppServerBackend();expect((await backend.listModels())[0]?.serviceTiers?.[0]?.id).toBe('fast');
    expect((await backend.listModelsForCwd(join(directory,'restricted-session')))[0]?.serviceTiers).toEqual([]);
    state.cwdConfig={model_provider:'custom-route'};save();
    expect((await backend.listModelsForCwd(join(directory,'restricted-session')))[0]?.serviceTiers).toBeUndefined();
  });

  it('preserves confirmed empty tiers so a revoked acceleration cannot reactivate later', async () => {
    enableRemoteAccess();state.pages.first.data=[{...native('native-a'),serviceTiers:[]}];save();
    expect((await new CodexAppServerBackend().listModelsForCwd(directory))[0]?.serviceTiers).toEqual([]);
  });

  it('keeps ordinary dispatch explicit even when the user native default is Ultrafast', async () => {
    state.config={service_tier:'ultrafast'};save();
    const backend=new CodexAppServerBackend();const thread=await backend.startThread({cwd:directory,mode:'full',serviceTier:'standard'});
    try {
      for await(const _ of thread.runStreamed({text:'ordinary fallback'},{serviceTier:'standard'}).events) { /* drain */ }
      expect(calls().find(call=>call.method==='thread/start')?.params.serviceTier).toBeNull();
      expect(calls().filter(call=>call.method==='turn/start').at(-1)?.params.serviceTier).toBeNull();
    } finally {await thread.close();}
  });

  it('sends explicit tiers and restores the native default when a session returns to inheritance', async () => {
    state.config = { service_tier: 'ultrafast' };
    save();
    const backend = new CodexAppServerBackend();
    const thread = await backend.startThread({ cwd: directory, mode: 'full', serviceTier: 'standard' });
    try {
      for await (const _ of thread.runStreamed({ text: 'standard' }, { serviceTier: 'standard' }).events) { /* drain */ }
      for await (const _ of thread.runStreamed({ text: 'fast' }, { serviceTier: 'fast' }).events) { /* drain */ }
      for await (const _ of thread.runStreamed({ text: 'inherit' }, { serviceTier: undefined }).events) { /* drain */ }
      for await (const _ of thread.runStreamed({ text: 'native' }, { serviceTier: undefined }).events) { /* drain */ }
      expect(calls().find(call => call.method === 'thread/start')?.params.serviceTier).toBeNull();
      expect(calls().filter(call => call.method === 'turn/start').map(call => call.params.serviceTier)).toEqual([null, 'priority', 'ultrafast', undefined]);
    } finally { await thread.close(); }
  });

  it('keeps native restoration pending after a rejected turn and restores it on retry', async () => {
    state.config = {};
    save();
    const backend = new CodexAppServerBackend();
    const thread = await backend.startThread({ cwd: directory, mode: 'full', serviceTier: 'fast' });
    try {
      const rejected = [];
      for await (const event of thread.runStreamed({ text: 'reject tier' }, { serviceTier: undefined }).events) rejected.push(event);
      expect(rejected.some(event => event.type === 'error')).toBe(true);
      for await (const _ of thread.runStreamed({ text: 'retry' }, { serviceTier: undefined }).events) { /* drain */ }
      expect(calls().filter(call => call.method === 'turn/start').map(call => call.params.serviceTier)).toEqual([null, null]);
    } finally { await thread.close(); }
  });

  it('resets a persisted fast tier to native config when an inherited session resumes', async () => {
    state.config = { service_tier: 'ultrafast' };
    save();
    const backend = new CodexAppServerBackend();
    const started = await backend.startThread({ cwd: directory, mode: 'full', serviceTier: 'fast' });
    const sessionId = started.sessionId;
    await started.close();
    const resumed = await backend.resumeThread({ cwd: directory, mode: 'full', sessionId });
    try {
      expect(calls().filter(call => call.method === 'thread/resume').at(-1)?.params.serviceTier).toBe('ultrafast');
      for await (const _ of resumed.runStreamed({ text: 'inherited' }, { serviceTier: undefined }).events) { /* drain */ }
      expect(calls().filter(call => call.method === 'turn/start').at(-1)?.params).not.toHaveProperty('serviceTier');
    } finally { await resumed.close(); }
  });

  it('does not append a configured model that the native picker directory does not contain', async () => {
    state.config = {model: 'local-custom-model', model_provider: 'local-proxy', model_reasoning_effort: 'high'};
    save();
    const backend = new CodexAppServerBackend();
    const models = await backend.listModels();

    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(models.some(model => model.id === 'local-custom-model')).toBe(false);
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['native-a']);
    expect(backend.peekModels()).toEqual(models);
    expect(calls().some(call => call.method === 'config/read')).toBe(true);
  });

  it('does not reorder or alter native model metadata when the configured model is already listed', async () => {
    state.config = {model: 'native-b', model_provider: 'openai', model_reasoning_effort: 'low'};
    save();
    const models = await new CodexAppServerBackend().listModels();

    expect(models.filter(model => model.id === 'native-b')).toHaveLength(1);
    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(models.find(model => model.id === 'native-b')).toMatchObject({
      displayName: 'Native native-b', isDefault: false,
      supportedEfforts: ['low', 'high'], defaultEffort: 'high',
    });
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['native-a']);
  });

  it('leaves effort to Codex when a native directory row exposes no effort capability', async () => {
    state.config = {model: 'local-no-effort-metadata', model_provider: 'local-proxy', model_reasoning_effort: 'high'};
    state.pages.first.data = [{...native('local-no-effort-metadata', true), supportedReasoningEfforts: []}];
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

  it('keeps an existing native model’s effort behavior after the discovered directory changes', async () => {
    state.config = {model: 'custom-before-refresh', model_provider: 'local-proxy'};
    state.pages.first.data = [{...native('custom-before-refresh', true), supportedReasoningEfforts: []}];
    save();
    const backend = new CodexAppServerBackend();
    expect((await backend.listModels()).find(model => model.id === 'custom-before-refresh')?.supportedEfforts).toEqual([]);
    const thread = await backend.startThread({cwd: directory, mode: 'full', model: 'custom-before-refresh', effort: 'medium'});
    try {
      state.config = {model: 'custom-after-refresh', model_provider: 'local-proxy'};
      state.pages.first.data = [{...native('custom-after-refresh', true), supportedReasoningEfforts: []}];
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

  it('requests the native full directory and excludes hidden rows even when config.model selects one', async () => {
    state.config = {model: 'native-hidden', model_provider: 'local-proxy'};
    state.pages.first.data = [native('native-a', true), {...native('native-hidden'), hidden: true}, native('native-b')];
    save();
    const models = await new CodexAppServerBackend().listModels();

    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(models.some(model => model.id === 'native-hidden')).toBe(false);
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['native-a']);
    const modelCalls = calls().filter(call => call.method === 'model/list');
    expect(modelCalls.length).toBeGreaterThan(0);
    expect(modelCalls.every(call => call.params.includeHidden === true)).toBe(true);
  });

  it('keeps an empty native picker directory empty instead of adding config or fixed fallback rows', async () => {
    state.config = {model: 'configured-but-not-listed', model_provider: 'local-proxy'};
    state.pages.first.data = [];
    save();
    const backend = new CodexAppServerBackend();

    expect(await backend.listModels()).toEqual([]);
    expect(backend.peekModels()).toEqual([]);
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

  it('refreshes the native directory after local configuration changes without retaining removed rows', async () => {
    state.config = {model: 'local-before', model_provider: 'local-proxy'};
    state.pages.first.data = [native('local-before', true), native('native-b')];
    save();
    const backend = new CodexAppServerBackend();
    expect((await backend.listModels()).find(model => model.isDefault)?.id).toBe('local-before');

    state.config = {model: 'local-after', model_provider: 'local-proxy'};
    state.pages.first.data = [native('local-after', true), native('native-b')];
    save();
    const refreshed = await backend.listModels();
    expect(refreshed.find(model => model.isDefault)?.id).toBe('local-after');
    expect(refreshed.some(model => model.id === 'local-before')).toBe(false);
    expect(backend.peekModels()).toEqual(refreshed);

    state.config = {};
    state.pages.first.data = [native('native-a', true), native('native-b')];
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
    expect(await backend.listModels()).toEqual([]);
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
    expect(await backend.listModels()).toEqual([]);

    expect(backend.peekModels()).toBeUndefined();
    expect(calls().filter(call => call.method === 'model/list').length).toBeLessThanOrEqual(3);
  });

  it('returns an empty directory without caching fixed fallback rows after a native catalog failure', async () => {
    state.failModels = true;
    save();
    const backend = new CodexAppServerBackend();
    expect(await backend.listModels()).toEqual([]);
    expect(backend.peekModels()).toBeUndefined();

    state.failModels = false;
    save();
    const models = await backend.listModels();
    expect(models.map(model => model.id)).toEqual(['native-a', 'native-b']);
    expect(backend.peekModels()).toEqual(models);
  });
});
