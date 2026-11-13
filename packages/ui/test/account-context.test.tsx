import {beforeEach, expect, it, vi} from 'vitest';
import type {AccountShell, AccountStatus} from '@vonvon/protocol';
import {AccountProvider, type useAccount} from '../src/account-context';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {A, devicesState, fakeShell, info, newClient} from './devices-fixture';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({state: [] as unknown[], effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ei: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const i = h.ei++; const old = h.effects[i];
    if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return;
    h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});
  },
}));

const signedIn: AccountStatus = {kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: 'Clay', provider: 'github', persistence: 'secure'};
function shell() {
  let listener: (status: AccountStatus) => void = () => {};
  const off = vi.fn();
  const account: AccountShell = {
    status: vi.fn(async () => ({kind: 'signedOut'} as AccountStatus)),
    onStatus: vi.fn(next => {listener = next; return off;}),
    login: vi.fn(async () => {listener({kind: 'signingIn'}); return {kind: 'signingIn'};}),
    cancelLogin: vi.fn(async () => {const next = {kind: 'signedOut', reason: 'cancelled'} as AccountStatus; listener(next); return next;}),
    logout: vi.fn(async () => {listener({kind: 'signedOut'}); return {kind: 'signedOut'};}),
  };
  return {account, off, emit: (next: AccountStatus) => listener(next)};
}
function render(account?: AccountShell) {
  h.si = h.ei = 0;
  const result = AccountProvider({account, children: null});
  for (const effect of h.pending.splice(0)) effect();
  return result.props.value as ReturnType<typeof useAccount>;
}
const flush = async () => {await Promise.resolve(); await Promise.resolve();};
beforeEach(() => {h.state = []; h.effects = []; h.pending = [];});

it('keeps one native subscription and the signed-in identity across device switches', async () => {
  const {account, emit, off} = shell();
  const native = {...fakeShell(), account};
  const fallback = newClient();
  const local = DesktopRootView({state: devicesState({id: 'local'}), fallback, shell: native, renderApp: () => null});
  const remote = DesktopRootView({state: devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}), fallback, shell: native, renderApp: () => null});
  expect(local.type).toBe(AccountProvider);
  expect(remote.type).toBe(AccountProvider);
  expect(local.key).toBeNull();
  expect(remote.key).toBeNull();
  render(local.props.account); await flush();
  emit(signedIn);
  expect(render(remote.props.account).status).toEqual(signedIn);
  expect(account.onStatus).toHaveBeenCalledOnce();
  expect(account.status).toHaveBeenCalledOnce();
  expect(off).not.toHaveBeenCalled();
});

it('does not let a late initial read replace a newer native event', async () => {
  const fixture = shell();
  let finish!: (status: AccountStatus) => void;
  fixture.account.status = () => new Promise(resolve => {finish = resolve;});
  render(fixture.account);
  fixture.emit(signedIn);
  finish({kind: 'signedOut'}); await flush();
  expect(render(fixture.account).status).toEqual(signedIn);
});

it('invokes native login, cancel and logout without adding any device permissions', async () => {
  const fixture = shell();
  render(fixture.account); await flush();
  await render(fixture.account).login();
  expect(render(fixture.account).status?.kind).toBe('signingIn');
  await render(fixture.account).cancelLogin();
  expect(render(fixture.account).status).toEqual({kind: 'signedOut', reason: 'cancelled'});
  fixture.emit(signedIn);
  await render(fixture.account).logout();
  expect(render(fixture.account).status).toEqual({kind: 'signedOut'});
  expect(fixture.account.login).toHaveBeenCalledOnce();
  expect(fixture.account.cancelLogin).toHaveBeenCalledOnce();
  expect(fixture.account.logout).toHaveBeenCalledOnce();
});

it('cleans up the subscription and has no login capability in the browser', async () => {
  const fixture = shell();
  render(fixture.account); await flush(); fixture.emit(signedIn);
  expect(render().supported).toBe(false);
  expect(render().status).toBeUndefined();
  expect(fixture.off).toHaveBeenCalledOnce();
  await render().login();
  expect(fixture.account.login).not.toHaveBeenCalled();
});

it('shows a failed native operation without exposing native exception details', async () => {
  const fixture = shell();
  fixture.account.login = vi.fn(async () => {throw new Error('private refresh token');});
  render(fixture.account); await flush();
  await render(fixture.account).login();
  expect(render(fixture.account).error).toBe('登录未完成，请重试。');
  fixture.emit({kind: 'signedOut'});
  expect(render(fixture.account).error).toBeUndefined();
});
