import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {RpcError} from '@vonvon/client/browser';
import type {AdminSetupStatus, AgentId} from '@vonvon/protocol';
import {SETUP_POLL_MS, useSetupStatus} from '../src/setup/useSetupStatus';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>,
  si: 0, ri: 0, mi: 0, ei: 0, client: {admin: vi.fn()},
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

const id = 'cli_callback' as AgentId;
const status = (confirmed: boolean, verifiedAt?: number): AdminSetupStatus => ({
  appId: id, tenant: 'feishu', credentials: {ok: true}, connection: {running: true},
  event: {state: 'ok'}, scopes: {missingRequired: [], grantUrl: 'https://example.test'},
  eventConfigUrl: 'https://example.test', consoleUrl: 'https://example.test', cardCallback: {confirmed, ...(verifiedAt ? {verifiedAt} : {})},
});
function render(poll = true) {
  h.si = h.ri = h.mi = h.ei = 0;
  const result = useSetupStatus([id], {poll});
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve};}
function unmount() {for (const effect of h.effects) effect.cleanup?.();}
beforeEach(() => {
  vi.useFakeTimers(); h.state = []; h.refs = []; h.memos = []; h.effects = []; h.pending = [];
  h.client.admin.mockReset();
});
afterEach(() => {unmount(); vi.useRealTimers();});

it('automatically upgrades a pending callback and stops polling once verified', async () => {
  h.client.admin.mockResolvedValueOnce({kind: 'setupStatus', status: status(false)})
    .mockResolvedValue({kind: 'setupStatus', status: status(true, 1234)});
  render(); await flush();
  expect(render().reads[id]?.status?.cardCallback.confirmed).toBe(false);
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
  expect(render().reads[id]?.status?.cardCallback.verifiedAt).toBe(1234);
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3);
  expect(h.client.admin).toHaveBeenCalledTimes(2);
});

it('upgrades manual confirmation using local reads without repeating Feishu checks', async () => {
  h.client.admin.mockResolvedValueOnce({kind: 'setupStatus', status: status(true)})
    .mockRejectedValueOnce(new Error('temporary disconnect'))
    .mockResolvedValue({kind: 'cardCallbackStatus', cardCallback: {confirmed: true, verifiedAt: 1234}});
  render(); await flush();
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
  expect(render().reads[id]?.status?.cardCallback).toEqual({confirmed: true});
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
  expect(render().reads[id]?.status?.cardCallback.verifiedAt).toBe(1234);
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3);
  expect(h.client.admin.mock.calls.map(([request]) => request.type)).toEqual(['setupStatus', 'cardCallbackStatus', 'cardCallbackStatus']);
});

it('keeps a newer explicit recheck when an older local read arrives late', async () => {
  const late = deferred<unknown>();
  h.client.admin.mockResolvedValueOnce({kind: 'setupStatus', status: status(true)})
    .mockReturnValueOnce(late.promise)
    .mockResolvedValue({kind: 'setupStatus', status: status(true, 5678)});
  render(); await flush();
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
  await render().recheck(id);
  late.resolve({kind: 'cardCallbackStatus', cardCallback: {confirmed: false}}); await flush();
  expect(render().reads[id]?.status?.cardCallback.verifiedAt).toBe(5678);
});

it.each(['unsupported', 'invalid_request'])('keeps legacy host manual status without retrying %s', async code => {
  h.client.admin.mockResolvedValueOnce({kind: 'setupStatus', status: status(true)})
    .mockRejectedValue(new RpcError(code, 'old daemon'));
  render(); await flush();
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 4);
  expect(h.client.admin).toHaveBeenCalledTimes(2);
  expect(render().reads[id]?.status?.cardCallback).toEqual({confirmed: true});
  expect(render().reads[id]?.problem).toBeUndefined();
});

it('keeps one-shot diagnosis reads one-shot', async () => {
  h.client.admin.mockResolvedValue({kind: 'setupStatus', status: status(true)});
  render(false); await flush();
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3);
  expect(h.client.admin).toHaveBeenCalledTimes(1);
});

it('does not apply a late local result or schedule more work after leaving the page', async () => {
  const late = deferred<unknown>();
  h.client.admin.mockResolvedValueOnce({kind: 'setupStatus', status: status(true)}).mockReturnValueOnce(late.promise);
  render(); await flush();
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
  unmount();
  const state = h.state[0];
  late.resolve({kind: 'cardCallbackStatus', cardCallback: {confirmed: true, verifiedAt: 1234}}); await flush();
  await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3);
  expect(h.state[0]).toBe(state);
  expect(h.client.admin).toHaveBeenCalledTimes(2);
});
