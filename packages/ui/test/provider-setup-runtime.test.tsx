import {beforeEach, expect, it, vi} from 'vitest';
import type {DesktopSnapshot, ToolState} from '@vonvon/protocol';
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
const snapshot = (tools: ToolState[] | ReturnType<typeof tool>[]) => ({tools, jobs: []}) as unknown as DesktopSnapshot;
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

it('installs a missing Claude SDK only after the user requests it, even when Claude Code is present', async () => {
  const missing = snapshot([{tool: 'claude', installation: 'missing', authentication: 'unknown', version: null}]);
  h.client.snapshot.mockResolvedValue(missing);
  const originalEnvironment = h.client.environment.getMockImplementation()!;
  h.client.environment.mockImplementation(async (request: {type: string}) => request.type === 'backendCatalog'
    ? {kind: 'backends', entries: [{id: 'claude-agent', depState: 'missing', canInstall: true, canUninstall: false}]}
    : request.type === 'scan' ? {kind: 'tools', tools: [{tool: 'claude', installation: 'external', executable: '/existing/claude', version: '1', canUninstall: false}]}
    : request.type === 'backendInstall' ? {kind: 'backendInstall', operationId: 'sdk-install-1'}
    : originalEnvironment(request));

  render('claude', missing); await flush();
  await render('claude', missing).verify();
  const state = render('claude', missing);
  expect(state.entry?.depState).toBe('missing');
  expect(state.canContinue).toBe(false);
  expect(h.client.environment.mock.calls.some(([request]) => ['install', 'update', 'backendInstall', 'startLogin', 'backendLogin'].includes(request.type))).toBe(false);
  expect(h.client.collaboration).not.toHaveBeenCalled();

  await state.installProvider();
  expect(h.client.environment).toHaveBeenCalledWith({type: 'backendInstall', id: 'claude-agent', update: false});
  expect(h.client.environment.mock.calls.filter(([request]) => request.type === 'backendInstall')).toHaveLength(1);
  expect(h.client.environment.mock.calls.some(([request]) => ['install', 'update', 'startLogin'].includes(request.type))).toBe(false);
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


it('retains a failed detection message and recovers through a tool refresh without installing', async () => {
  const failed = snapshot([{tool: 'codex', installation: 'unknown', authentication: 'unknown', version: null, message: '检测 Codex 失败：进程清理异常'}]);
  h.client.snapshot.mockResolvedValue(failed);
  expect(render('codex', failed).issue).toBe('检测 Codex 失败：进程清理异常');
  await flush();
  let state = render('codex', failed);
  expect(state.check?.state).toBe('unavailable');
  expect(state.check?.message).toBe('检测 Codex 失败：进程清理异常');
  expect(state.canContinue).toBe(false);
  expect(h.client.collaboration).not.toHaveBeenCalled();
  expect(run).toHaveBeenLastCalledWith({type: 'refresh', tools: true});

  const recovered = snapshot([tool('codex')]);
  h.client.snapshot.mockResolvedValue(recovered);
  await state.verify();
  state = render('codex', recovered);
  await flush();
  state = render('codex', recovered);
  expect(state.canContinue).toBe(true);
  expect(state.issue).toBeUndefined();
  expect(state.check?.message).toBeUndefined();
  expect(h.client.environment.mock.calls.some(([request]) => ['install', 'update', 'backendInstall'].includes(request.type))).toBe(false);
});

it.each(['codex', 'claude'] as const)('checks again instead of installing when a %s installation action sees unknown state', async provider => {
  const unknown = snapshot([{tool: provider, installation: 'unknown', authentication: 'unknown', version: null}]);
  h.client.snapshot.mockResolvedValue(unknown);
  render(provider, unknown); await flush();
  const before = run.mock.calls.length;
  await render(provider, unknown).installProvider();
  expect(run.mock.calls.length).toBe(before + 1);
  expect(run).toHaveBeenLastCalledWith({type: 'refresh', tools: true});
  expect(render(provider, unknown).check?.message).toBe('暂时无法确认安装状态，请重新检测。');
  expect(h.client.environment.mock.calls.some(([request]) => ['install', 'update', 'backendInstall'].includes(request.type))).toBe(false);
});

it('keeps an absent detection result unavailable and retryable', async () => {
  const absent = snapshot([]);
  h.client.snapshot.mockResolvedValue(absent);
  render('codex', absent); await flush();
  const state = render('codex', absent);
  expect(state.canContinue).toBe(false);
  expect(state.check?.state).toBe('unavailable');
  expect(state.check?.message).toBe('暂时无法确认安装状态，请重新检测。');
  expect(h.client.collaboration).not.toHaveBeenCalled();
});


it.each(['signedIn', 'signedOut'] as const)('refreshes recovered %s installation metadata without letting the older scan overwrite it', async authentication => {
  const unknown = snapshot([{tool: 'codex', installation: 'unknown', authentication: 'unknown', version: null, message: '检测失败'}]);
  h.client.snapshot.mockResolvedValue(unknown);
  const oldScan = deferred<unknown>();
  const originalEnvironment = h.client.environment.getMockImplementation()!;
  let scans = 0;
  const external = {tool: 'codex', installation: 'external', version: '1', executable: '/existing/codex', canUninstall: false};
  h.client.environment.mockImplementation(async (request: {type: string}) => request.type === 'scan'
    ? ++scans === 1 ? oldScan.promise : {kind: 'tools', tools: [external]}
    : originalEnvironment(request));
  render('codex', unknown); await flush();
  const recovered = snapshot([tool('codex', authentication)]);
  h.client.snapshot.mockResolvedValue(recovered);
  await render('codex', unknown).verify();
  expect(render('codex', recovered).tools).toEqual([external]);
  oldScan.resolve({kind: 'tools', tools: [{tool: 'codex', installation: 'missing', version: null, executable: null, canUninstall: false}]});
  await flush();
  expect(render('codex', recovered).tools).toEqual([external]);
});


it.each([
  {tool: 'codex', installation: 'missing', authentication: 'unknown', version: null, message: '尚未安装 Codex'},
  {tool: 'codex', installation: 'installed', authentication: 'signedOut', version: '1', message: '当前 Codex：/existing/codex'},
  {tool: 'codex', installation: 'installed', authentication: 'unknown', version: '0.1', compatibility: {status: 'tooOld'}, message: '请更新 Codex'},
] as ToolState[])('does not turn expected $installation / $authentication status text into a detection error', async current => {
  const value = snapshot([current]);
  h.client.snapshot.mockResolvedValue(value);
  render('codex', value); await flush();
  const state = render('codex', value);
  expect(state.check?.message).toBeUndefined();
  expect(state.issue).toBeUndefined();
});


it.each(['absent', 'missing'] as const)('repairs %s source metadata when a recovered snapshot supersedes the old verification', async initialSource => {
  const unknown = snapshot([{tool: 'codex', installation: 'unknown', authentication: 'unknown', version: null, message: '检测失败'}]);
  h.client.snapshot.mockResolvedValue(unknown);
  const originalEnvironment = h.client.environment.getMockImplementation()!;
  const missing = {tool: 'codex', installation: 'missing', version: null, executable: null, canUninstall: false};
  const external = {tool: 'codex', installation: 'external', version: '1', executable: '/existing/codex', canUninstall: false};
  let scans = 0;
  h.client.environment.mockImplementation(async (request: {type: string}) => request.type === 'scan'
    ? {kind: 'tools', tools: ++scans === 1 ? initialSource === 'missing' ? [missing] : [] : [external]}
    : originalEnvironment(request));
  render('codex', unknown); await flush();
  const state = render('codex', unknown);
  expect(state.tools).toEqual(initialSource === 'missing' ? [missing] : []);

  const oldRefresh = deferred<{kind: 'applied'; revision: number}>();
  run.mockReturnValueOnce(oldRefresh.promise);
  const oldVerification = state.verify();
  const recovered = snapshot([tool('codex')]);
  h.client.snapshot.mockResolvedValue(recovered);
  // App receives the daemon's refreshed snapshot before its command promise settles.
  // The signature effect starts a newer verify with an already-installed tool closure.
  render('codex', recovered); await flush();
  expect(render('codex', recovered).tools).toEqual([external]);
  expect(scans).toBe(2);
  oldRefresh.resolve({kind: 'applied', revision: 2});
  await oldVerification; await flush();
  expect(render('codex', recovered).tools).toEqual([external]);
  expect(render('codex', recovered).canContinue).toBe(true);
});
