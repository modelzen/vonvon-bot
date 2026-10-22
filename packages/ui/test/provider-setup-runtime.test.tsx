import {beforeEach, expect, it, vi} from 'vitest';
import type {DesktopSnapshot} from '@vonvon/protocol';
import {useProviderSetup} from '../src/setup/useProviderSetup';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>,
  si: 0, ri: 0, mi: 0, ei: 0, client: {environment: vi.fn(), snapshot: vi.fn(), collaboration: vi.fn()},
}));
vi.mock('react', async original => {
  const memo = (factory: () => unknown, deps?: unknown[]) => {const i = h.mi++; const old = h.memos[i]; if (old?.deps && deps && deps.every((v, n) => Object.is(v, old.deps![n]))) return old.value; const value = factory(); h.memos[i] = {value, deps}; return value;};
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
    useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
    useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((v, n) => Object.is(v, old.deps![n]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});},
  };
});
vi.mock('../src/client-context', () => ({useClient: () => h.client}));

const model = {id: 'native', displayName: 'Native', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false};
const tool = (provider: 'codex' | 'claude', authentication: 'signedIn' | 'unknown' | 'signedOut' = 'signedIn') => ({tool: provider, installation: 'installed', authentication, version: '1'});
const snapshot = (tools: ReturnType<typeof tool>[]) => ({tools, jobs: []}) as unknown as DesktopSnapshot;
const run = vi.fn(async () => ({kind: 'applied', revision: 1} as const));
function render(provider: 'codex' | 'claude', value: DesktopSnapshot, ready = true) {
  h.si = h.ri = h.mi = h.ei = 0;
  const result = useProviderSetup(provider, value, ready, run);
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve};}
beforeEach(() => {
  h.state = []; h.refs = []; h.memos = []; h.effects = []; h.pending = []; vi.clearAllMocks();
  h.client.environment.mockImplementation(async (request: {type: string}) => request.type === 'backendCatalog' ? {kind: 'backends', entries: [{id: 'claude-agent', depState: 'installed'}]}
    : request.type === 'scan' ? {kind: 'tools', tools: []}
    : request.type === 'backendInstallStatus' ? {kind: 'backendInstallStatus', operation: null}
    : request.type === 'toolInstallStatus' ? {kind: 'toolInstall', operation: null}
    : request.type === 'loginStatus' ? {kind: 'operation', operation: null}
    : {kind: 'applied', message: 'ok'});
  h.client.collaboration.mockResolvedValue({kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [model]});
});

it('requires installed, authenticated and native nonempty models', async () => {
  const signed = snapshot([tool('codex')]); h.client.snapshot.mockResolvedValue(signed);
  render('codex', signed); await flush(); expect(render('codex', signed).canContinue).toBe(true);
  h.client.collaboration.mockResolvedValue({kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: []});
  await render('codex', signed).verify(); expect(render('codex', signed).canContinue).toBe(false);
  const unknown = snapshot([tool('codex', 'unknown')]); h.client.snapshot.mockResolvedValue(unknown);
  await render('codex', unknown).verify(); expect(render('codex', unknown).canContinue).toBe(false);
  h.client.collaboration.mockResolvedValue({kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [model]});
  h.client.snapshot.mockResolvedValue(signed);
  await render('codex', signed).verify(); expect(render('codex', signed).canContinue).toBe(true);
});

it('ignores an older model reply after a newer failed check and after unmount', async () => {
  const signed = snapshot([tool('codex')]); h.client.snapshot.mockResolvedValue(signed);
  const first = deferred<unknown>(); h.client.collaboration.mockReturnValueOnce(first.promise).mockResolvedValue({kind: 'providerModels', backend: 'codex-appserver', state: 'unavailable', models: []});
  render('codex', signed); await flush();
  await render('codex', signed).verify(); first.resolve({kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [model]}); await flush();
  expect(render('codex', signed).canContinue).toBe(false);
  const late = deferred<unknown>(); h.client.collaboration.mockReturnValue(late.promise);
  const pending = render('codex', signed).verify(); await flush();
  for (const effect of h.effects) effect.cleanup?.();
  late.resolve({kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [model]}); await pending;
  expect(h.state.some(value => typeof value === 'object' && value !== null && 'state' in value && (value as {state: string}).state === 'ready')).toBe(false);
});

it('installs the Claude CLI then starts login when SDK is already installed', async () => {
  const signed = snapshot([tool('claude', 'signedOut')]); h.client.snapshot.mockResolvedValue(signed);
  h.client.environment.mockImplementation(async (request: {type: string; tool?: string}) => request.type === 'scan' ? {kind: 'tools', tools: [{tool: 'claude', installation: 'missing'}]}
    : request.type === 'backendCatalog' ? {kind: 'backends', entries: [{id: 'claude-agent', depState: 'installed'}]}
    : request.type === 'backendInstallStatus' ? {kind: 'backendInstallStatus', operation: null}
    : request.type === 'toolInstallStatus' ? {kind: 'toolInstall', operation: null}
    : request.type === 'loginStatus' ? {kind: 'operation', operation: null}
    : {kind: 'applied', message: 'ok'});
  render('claude', signed); await flush(); await render('claude', signed).connect();
  const actions = h.client.environment.mock.calls.map(([request]) => request.type);
  expect(actions.lastIndexOf('install')).toBeGreaterThan(-1);
  expect(actions.lastIndexOf('startLogin')).toBeGreaterThan(actions.lastIndexOf('install'));
});

it('polls a pending tool install so it can be cancelled before the install request settles', async () => {
  vi.useFakeTimers();
  try {
    const missing = snapshot([{tool: 'codex', installation: 'missing', authentication: 'unknown', version: null} as never]);
    h.client.snapshot.mockResolvedValue(missing);
    const installing = deferred<unknown>();
    const slowScan = deferred<unknown>();
    const oldStatus = deferred<unknown>();
    let statusReads = 0;
    const operation = {kind: 'running', id: 'install-1', tool: 'codex', update: false, startedAt: 1};
    h.client.environment.mockImplementation(async (request: {type: string}) => request.type === 'install' ? installing.promise
      : request.type === 'toolInstallStatus' ? ++statusReads === 1 ? oldStatus.promise : {kind: 'toolInstall', operation}
      : request.type === 'cancelInstall' ? (installing.resolve({kind: 'refused', code: 'install-cancelled', message: '已取消'}), {kind: 'toolInstall', operation: {kind: 'cancelled', id: 'install-1', message: '已取消'}})
      : request.type === 'scan' ? slowScan.promise
      : request.type === 'backendCatalog' ? {kind: 'backends', entries: []}
      : request.type === 'backendInstallStatus' ? {kind: 'backendInstallStatus', operation: null}
      : {kind: 'operation', operation: null});
    render('codex', missing); await flush();
    const pending = render('codex', missing).installProvider();
    render('codex', missing);
    await vi.advanceTimersByTimeAsync(1200); await flush();
    const state = render('codex', missing);
    expect(state.relevantToolInstall?.id).toBe('install-1');
    expect(h.client.environment.mock.calls.filter(([request]) => request.type === 'scan')).toHaveLength(1);
    oldStatus.resolve({kind: 'toolInstall', operation: null}); await flush();
    expect(render('codex', missing).relevantToolInstall?.id).toBe('install-1');
    await state.cancelInstall(); await pending;
    slowScan.resolve({kind: 'tools', tools: []}); await flush();
    expect(h.client.environment).toHaveBeenCalledWith({type: 'cancelInstall', operationId: 'install-1'});
  } finally {vi.useRealTimers();}
});

it('does not let an old Provider response mark the new choice ready', async () => {
  const codex = snapshot([tool('codex')]);
  const claude = snapshot([tool('claude', 'unknown')]);
  let current = codex;
  h.client.snapshot.mockImplementation(async () => current);
  const old = deferred<unknown>();
  h.client.collaboration.mockReturnValueOnce(old.promise);
  render('codex', codex); await flush();
  current = claude;
  render('claude', claude); await flush();
  old.resolve({kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [model]}); await flush();
  const result = render('claude', claude);
  expect(result.canContinue).toBe(false);
  expect(result.check?.provider).toBe('claude');
});
