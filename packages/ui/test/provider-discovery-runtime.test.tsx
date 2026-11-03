import {beforeEach, expect, it, vi} from 'vitest';
import type {ToolState} from '@vonvon/protocol';
import {useProviderDiscovery} from '../src/settings/useProviderDiscovery';

const h = vi.hoisted(() => ({state: [] as any[], refs: [] as any[], effects: [] as any[], pending: [] as Array<() => void>, si: 0, ri: 0, ei: 0, client: {environment: vi.fn(), snapshot: vi.fn()}}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = initial; return [h.state[i], (next: any) => {h.state[i] = typeof next === 'function' ? next(h.state[i]) : next;}];},
  useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old && deps.every((value, index) => Object.is(value, old.deps[index]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect()};});},
}));
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(), useActiveDevice: () => ({id: 'local', isRemote: false, name: '这台电脑', mode: 'full', capabilities: []}), useClient: () => h.client}));
const tools = (auth = 'unknown') => [
  {tool: 'codex', installation: 'installed', authentication: 'signedIn'},
  {tool: 'claude', installation: 'installed', authentication: auth},
] as ToolState[];
const catalog = {kind: 'backends', entries: [{id: 'codex-appserver', displayName: 'Codex'}, {id: 'claude-agent', displayName: 'Claude'}]};
const signedIn = {kind: 'backendLogin', id: 'claude-agent', state: 'signedIn', message: '已登录'};
function render(states?: ToolState[]) {
  h.si = h.ri = h.ei = 0;
  const result = useProviderDiscovery(states);
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
async function flush() {for (let i = 0; i < 20; i++) await Promise.resolve();}
const probes = () => h.client.environment.mock.calls.filter(([command]) => command.type === 'backendLogin');
beforeEach(() => {
  for (const effect of h.effects) effect.cleanup?.();
  h.state = []; h.refs = []; h.effects = []; h.pending = []; vi.resetAllMocks();
  h.client.environment.mockImplementation(async command => command.type === 'backendCatalog' ? catalog : signedIn);
  h.client.snapshot.mockResolvedValue({tools: tools()});
});
it('discovers installed Claude with unknown snapshot auth through the SDK result, without a rerender loop', async () => {
  expect(render(tools()).checking).toBe(true);
  await flush();
  expect(render(tools()).providers.map(provider => provider.id)).toEqual(['codex-appserver', 'claude-agent']);
  for (let i = 0; i < 8; i++) {render(tools()); await flush();}
  expect(probes()).toEqual([[{type: 'backendLogin', id: 'claude-agent', refresh: false}]]);
});
it('uses snapshot discovery when the caller supplies no tools', async () => {
  render(); await flush();
  expect(render().providers).toHaveLength(2);
  expect(h.client.snapshot).toHaveBeenCalledOnce();
});
it('keeps signed-out Claude gated and provides login guidance', async () => {
  h.client.environment.mockImplementation(async command => command.type === 'backendCatalog' ? catalog : {...signedIn, state: 'signedOut'});
  render(tools()); await flush(); const result = render(tools());
  expect(result.providers.map(provider => provider.id)).toEqual(['codex-appserver']);
  expect(result.message).toContain('Claude 还没配置好'); expect(result.message).toContain('账号或自定义 API 都行');
});
it.each(['refused', 'throw'])('retains Codex on Claude %s and allows a forced explicit retry', async failure => {
  let failed = true;
  h.client.environment.mockImplementation(async command => {
    if (command.type === 'backendCatalog') return catalog;
    if (!failed) return signedIn;
    if (failure === 'throw') throw new Error('连接失败');
    return {kind: 'refused', message: '检查被拒绝'};
  });
  render(tools()); await flush(); let result = render(tools());
  expect(result.providers.map(provider => provider.id)).toEqual(['codex-appserver']);
  expect(result.message).toContain('Claude 的配置检查失败');
  for (let i = 0; i < 4; i++) {render(tools()); await flush();}
  expect(probes()).toHaveLength(1);
  failed = false; result.retry(); render(tools()); await flush(); result = render(tools());
  expect(result.providers).toHaveLength(2); expect(result.message).toBeUndefined();
  expect(probes().at(-1)).toEqual([{type: 'backendLogin', id: 'claude-agent', refresh: true}]);
});
it('does not probe already signed-in or incompatible Claude automatically', async () => {
  render(tools('signedIn')); await flush(); expect(probes()).toHaveLength(0);
  const states = tools(); states[1] = {...states[1]!, compatibility: {status: 'tooOld'}} as ToolState;
  render(states); await flush(); expect(probes()).toHaveLength(0);
  expect(render(states).providers.map(provider => provider.id)).toEqual(['codex-appserver']);
});
it('checks again after snapshot authentication expires to unknown, using the daemon cache policy', async () => {
  render(tools()); await flush();
  render(tools('signedIn')); await flush();
  render(tools()); await flush();
  expect(probes()).toHaveLength(2);
  expect(probes().every(([command]) => command.refresh === false)).toBe(true);
});
it('consumes a forced retry once and does not force another probe when the snapshot updates', async () => {
  render(tools('signedOut')); await flush();
  render(tools('signedOut')).retry(); render(tools('signedOut')); await flush();
  expect(render(tools('signedOut')).providers).toHaveLength(2);
  render(tools('signedIn')); await flush();
  expect(probes()).toEqual([[{type: 'backendLogin', id: 'claude-agent', refresh: true}]]);
});
it('shares an in-flight check when another provider changes, and ignores obsolete discovery results', async () => {
  let resolve!: (answer: unknown) => void;
  const pending = new Promise(done => {resolve = done;});
  h.client.environment.mockImplementation(command => command.type === 'backendCatalog' ? Promise.resolve(catalog) : pending);
  render(tools()); await flush();
  const changed = tools(); changed[0] = {...changed[0]!, authentication: 'signedOut'};
  render(changed); await flush(); expect(probes()).toHaveLength(1);
  resolve(signedIn); await flush();
  expect(render(changed).providers.map(provider => provider.id)).toEqual(['claude-agent']);
});
it('publishes usable Codex while the Claude probe is pending and keeps it available on retry', async () => {
  let resolve!: (answer: unknown) => void;
  let pending = new Promise(done => {resolve = done;});
  h.client.environment.mockImplementation(command => command.type === 'backendCatalog' ? Promise.resolve(catalog) : pending);
  render(tools()); await flush();
  let result = render(tools());
  expect(result.providers.map(provider => provider.id)).toEqual(['codex-appserver']);
  expect(result.checking).toBe(true);
  resolve(signedIn); await flush(); result = render(tools());
  expect(result.providers).toHaveLength(2); expect(result.checking).toBe(false);
  pending = new Promise(done => {resolve = done;});
  result.retry();
  result = render(tools());
  expect(result.providers.map(provider => provider.id)).toEqual(['codex-appserver']);
  expect(result.checking).toBe(true);
  await flush(); result = render(tools());
  expect(result.providers.map(provider => provider.id)).toEqual(['codex-appserver']);
  resolve(signedIn); await flush();
  expect(render(tools()).providers).toHaveLength(2);
});
