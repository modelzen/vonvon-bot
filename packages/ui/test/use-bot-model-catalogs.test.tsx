import {beforeEach, expect, it, vi} from 'vitest';
import type {AgentId, ModelCatalog} from '@vonvon/protocol';
import {useBotModelCatalogs} from '../src/settings/useBotModelCatalogs';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ri: 0, mi: 0, ei: 0, client: {settings: vi.fn()}}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? initial() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? next(h.state[i]) : next;}];},
  useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
  useCallback: (value: unknown, deps?: unknown[]) => {const i = h.mi++; const old = h.memos[i]; if (old?.deps && deps && old.deps.length === deps.length && deps.every((item, index) => Object.is(item, old.deps![index]))) return old.value; h.memos[i] = {value, deps}; return value;},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && old.deps.length === deps.length && deps.every((item, index) => Object.is(item, old.deps![index]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});},
}));
vi.mock('../src/client-context', () => ({useClient: () => h.client}));
const codex = 'codex-appserver'; const claude = 'claude-agent';
function catalog(backend: string, state: ModelCatalog['state'] = 'ready', model = 'fixture'): ModelCatalog {return {backend, state, source: 'backend-provided', observedAt: 1, titleEfforts: ['low'], models: [{id: model, displayName: model, description: '', hidden: false, isDefault: true, defaultEffort: 'low', supportedEfforts: ['low']}]};}
function render(botId = 'cli_one', purpose: 'titles' | 'comments' = 'titles') {h.si = h.ri = h.mi = h.ei = 0; const result = useBotModelCatalogs(botId as AgentId, purpose); for (const effect of h.pending.splice(0)) effect(); return result;}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
beforeEach(() => {h.state = []; h.refs = []; h.memos = []; h.effects = []; h.pending = []; vi.clearAllMocks();});

it('queries both native Providers with the Bot and purpose and preserves fallback catalogs', async () => {
  h.client.settings.mockImplementation(async ({query}) => ({kind: 'models', catalog: catalog(query.backend, query.backend === codex ? 'fallback' : 'ready')}));
  render(); await flush();
  expect(h.client.settings.mock.calls).toEqual([[{type: 'models', query: {botId: 'cli_one', backend: codex, purpose: 'titles'}}], [{type: 'models', query: {botId: 'cli_one', backend: claude, purpose: 'titles'}}]]);
  expect(render().catalogs[codex]?.state).toBe('fallback'); expect(render().catalogs[claude]?.state).toBe('ready');
});

it('isolates a new Bot and purpose from late old replies', async () => {
  const old = deferred<unknown>(); h.client.settings.mockImplementation(({query}) => query.botId === 'cli_one' ? old.promise : Promise.resolve({kind: 'models', catalog: catalog(query.backend, 'ready', 'new-bot-comment')}));
  render(); render('cli_two', 'comments'); await flush();
  expect(render('cli_two', 'comments').catalogs[codex]?.models[0]?.id).toBe('new-bot-comment');
  old.resolve({kind: 'models', catalog: catalog(codex, 'ready', 'old-title')}); await flush();
  expect(render('cli_two', 'comments').catalogs[codex]?.models[0]?.id).toBe('new-bot-comment');
  expect(render('cli_two', 'comments').catalogs[claude]?.models[0]?.id).toBe('new-bot-comment');
  expect(h.client.settings.mock.calls.slice(-2).every(([request]) => request.query.botId === 'cli_two' && request.query.purpose === 'comments')).toBe(true);
});

it('isolates title and comment catalogs for the same Bot', async () => {
  const title = deferred<unknown>();
  h.client.settings.mockImplementation(({query}) => query.purpose === 'titles' ? title.promise : Promise.resolve({kind: 'models', catalog: catalog(query.backend, 'fallback', 'comment-model')}));
  render('cli_one', 'titles'); render('cli_one', 'comments'); await flush();
  title.resolve({kind: 'models', catalog: catalog(codex, 'ready', 'title-model')}); await flush();
  const current = render('cli_one', 'comments');
  expect(current.catalogs[codex]?.models[0]?.id).toBe('comment-model');
  expect(current.catalogs[claude]?.models[0]?.id).toBe('comment-model');
  expect(current.catalogs[codex]?.state).toBe('fallback');
});

it('refreshes the same purpose and ignores superseded requests and unmount replies', async () => {
  const old = deferred<unknown>(); h.client.settings.mockReturnValueOnce(old.promise).mockReturnValueOnce(old.promise).mockImplementation(async ({query}) => ({kind: 'models', catalog: catalog(query.backend, 'ready', 'refreshed')}));
  render(); await render().refresh();
  old.resolve({kind: 'models', catalog: catalog(codex, 'ready', 'late')}); await flush();
  expect(render().catalogs[codex]?.models[0]?.id).toBe('refreshed');
  const late = deferred<unknown>(); h.client.settings.mockReturnValue(late.promise); const refresh = render().refresh();
  for (const effect of h.effects) effect.cleanup?.();
  late.resolve({kind: 'models', catalog: catalog(codex, 'ready', 'unmounted')}); await refresh;
  expect(h.state[0]).toEqual({});
});

it('contains each Provider failure and rejects a mismatched Provider reply', async () => {
  h.client.settings.mockImplementation(async ({query}) => query.backend === codex ? {kind: 'refused', message: 'Codex signed out'} : {kind: 'models', catalog: catalog(codex)});
  render('cli_one', 'comments'); await flush(); const result = render('cli_one', 'comments');
  expect(result.catalogs[codex]).toMatchObject({backend: codex, state: 'unavailable', models: [], error: 'Codex signed out'});
  expect(result.catalogs[claude]).toMatchObject({backend: claude, state: 'unavailable', models: [], error: '模型目录暂不可用。'});
});
