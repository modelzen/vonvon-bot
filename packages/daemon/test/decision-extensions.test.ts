import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import type {AgentBackend} from '../src/agent/types';
import {createHostSettings} from '../src/admin/host-settings';
import {secretsAction} from '../src/admin/secrets';
import {createJudge} from '../src/judge/judge';
import {readJudgeModels, writeJudgeModels} from '../src/judge/global-models';
import type {JudgeRequest} from '../src/judge/types';

vi.mock('../src/core/logger', () => ({log: {info: vi.fn(), warn: vi.fn(), fail: vi.fn()}}));
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
async function root() {const dir = await mkdtemp(join(tmpdir(), 'decision-extensions-')); roots.push(dir); return dir;}
const response = () => ({answers: {decision: {type: 'choice', choice: 'main', probabilities: {skip: 0.1, main: 0.9, topic: 0}}}});
function request(provider: string, model = 'jev-latest'): JudgeRequest {
  return {variant: 'main', appId: 'cli_fixture', botName: '测试助手', group: {chatId: 'oc_fixture', name: '测试', backend: 'codex-appserver', judge: {kind: 'decision', provider, model}},
    context: [], message: {at: 0, from: 'user', name: '测试人', text: '请帮忙检查'}};
}
function judgeOptions(dir: string) {
  const native = vi.fn();
  return {native, options: {judgeModelsRoot: dir, backendFor: () => ({id: 'codex-appserver', peekModels: () => [], judge: native}) as unknown as AgentBackend,
    readPrompt: async () => ({source: 'bot' as const, text: '按需回复', path: '/fixture'}), getSecret: async () => 'fixture-key'}};
}

it.each([
  ['openrouter', 'typesafe/jev-1.14', 'https://openrouter.ai/api/v1/systemone', 'openrouter-api-key'],
  ['vercel', 'typesafe-ai/jev', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'vercel-api-key'],
])('dispatches %s decisions with its own key, schema and model, without invoking a native judge', async (provider, model, endpoint, keyId) => {
  const f = judgeOptions(await root());
  const key = vi.fn(async () => 'fixture-key');
  const fetcher = vi.fn(async () => new Response(JSON.stringify(response())));
  const judge = createJudge({...f.options, getSecret: key, fetch: fetcher});
  try {
    expect(await judge.judge(request(provider, model))).toMatchObject({decision: 'main', provider, model});
    expect(key).toHaveBeenCalledWith(keyId);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.headers).toMatchObject({Authorization: 'Bearer fixture-key'});
    expect(JSON.parse(init.body as string)).toMatchObject({model, state: {new_message: {text: '请帮忙检查'}}, questions: {decision: {type: 'choice'}}});
    expect(f.native).not.toHaveBeenCalled();
  } finally {await judge.shutdown();}
});

it('hot reads a changed custom endpoint and does not carry an old endpoint auth cooldown into the new one', async () => {
  const dir = await root();
  const received: Array<{url: string; authorization?: string; body: unknown}> = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const data of req) text += String(data);
    received.push({url: req.url!, authorization: req.headers.authorization, body: JSON.parse(text)});
    res.writeHead(req.url === '/denied' ? 401 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(req.url === '/denied' ? {message: 'private upstream text'} : response()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const f = judgeOptions(dir); const judge = createJudge(f.options);
  try {
    await writeJudgeModels({byProvider: {custom: {model: 'jev-latest', endpoint: `${base}/denied`}}}, dir);
    expect(await judge.judge(request('custom'))).toMatchObject({error: {kind: 'auth'}});
    expect(await judge.judge(request('custom'))).toMatchObject({error: {kind: 'auth'}});
    expect(received).toHaveLength(1);
    await writeJudgeModels({byProvider: {custom: {model: 'jev-latest', endpoint: `${base}/ready`}}}, dir);
    expect(await judge.judge(request('custom'))).toMatchObject({decision: 'main', provider: 'custom'});
    expect(received.map(call => call.url)).toEqual(['/denied', '/ready']);
    expect(received[1]!.authorization).toBe('Bearer fixture-key');
    expect(f.native).not.toHaveBeenCalled();
  } finally {await judge.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

it('does not send a custom judgement or fall back when the endpoint is missing', async () => {
  const f = judgeOptions(await root()); const fetcher = vi.fn();
  const judge = createJudge({...f.options, fetch: fetcher});
  try {
    expect(await judge.judge(request('custom'))).toMatchObject({decision: 'skip', error: {kind: 'unavailable', detail: expect.stringContaining('接口地址')}});
    expect(fetcher).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  } finally {await judge.shutdown();}
});

it('can save an inactive custom connection before its key, but cannot make it the default until ready', async () => {
  const appDir = await root(); let hasKey = false;
  const host = createHostSettings({appDir, getSecret: async () => hasKey ? 'fixture-key' : undefined});
  const view = async () => {const result = await host.read({kind: 'host'}); if (!('runtime' in result)) throw new Error('No host'); return result.sections.judge;};
  const first = await view();
  const byProvider = {custom: {model: 'private-jev', endpoint: 'https://decision.example/v1/systemone'}};
  expect(await host.save({scope: {kind: 'host'}, section: 'judge', revision: first.revision, patch: {byProvider}})).toMatchObject({kind: 'saved'});
  const configured = await view();
  expect(await host.save({scope: {kind: 'host'}, section: 'judge', revision: configured.revision, patch: {defaultProvider: 'custom'}})).toMatchObject({kind: 'rejected'});
  hasKey = true;
  expect(await host.save({scope: {kind: 'host'}, section: 'judge', revision: configured.revision, patch: {defaultProvider: 'custom'}})).toMatchObject({kind: 'saved'});
  expect(await readJudgeModels(appDir)).toEqual({defaultProvider: 'custom', byProvider});
});

it('tests the configured custom model with invented state and never echoes an endpoint or key on invalid configuration', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({answers: {decision: {type: 'choice', choice: 'fruit', probabilities: {fruit: 1, other: 0}}}})));
  const deps = {getSecret: async () => 'fixture-key', fetch: fetcher, readJudgeModels: async () => ({byProvider: {custom: {model: 'private-jev', endpoint: 'https://decision.example/v1/systemone'}}})};
  expect(await secretsAction({type: 'testSecret', keyId: 'custom-decision-api-key'}, deps)).toMatchObject({kind: 'secretTested', outcome: 'ok'});
  const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string)).toMatchObject({model: 'private-jev', state: {message: expect.stringContaining('虚构')}});
  const denied = await secretsAction({type: 'testSecret', keyId: 'custom-decision-api-key'}, {...deps, readJudgeModels: async () => ({byProvider: {custom: {model: 'private-jev', endpoint: 'https://user:private@decision.example/v1/systemone'}}})});
  expect(denied).toMatchObject({kind: 'refused', code: 'configuration'});
  expect(JSON.stringify(denied)).not.toContain('private'); expect(fetcher).toHaveBeenCalledTimes(1);
});
