import {beforeEach, expect, it, vi} from 'vitest';
import type {AccountStatus} from '@vonvon/protocol';
import {CommunityProvider, type useCommunity} from '../src/community/community-context';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({state: [] as unknown[], effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ei: 0, account: undefined as AccountStatus | undefined}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = {current: initial}; return h.state[i];},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});},
}));
vi.mock('../src/account-context', () => ({useAccount: () => ({status: h.account})}));
vi.mock('../src/client-context', () => {const client = {}; return {useClient: () => client, useActiveDevice: () => ({id: 'local'})};});
const a: AccountStatus = {kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: 'A', provider: 'github', persistence: 'memory'};
const b: AccountStatus = {...a, accountId: '22222222-2222-4222-8222-222222222222', displayName: 'B'};
function render() {
  h.si = h.ei = 0;
  const result = CommunityProvider({children: null});
  for (const effect of h.pending.splice(0)) effect();
  return result.props.value as NonNullable<ReturnType<typeof useCommunity>>;
}
beforeEach(() => {h.state = []; h.effects = []; h.pending = []; h.account = a;});

it('clears an author route and private source snapshot immediately on account switch or logout', () => {
  const source = {recipeId: a.accountId, versionId: b.accountId, revision: 1, public: {name: '私人内容', summary: '', overview: '', version: '1', access: 'coded' as const}, owned: true, acquired: false, config: {role: 'private sentinel'}};
  render().open({kind: 'draft', source});
  expect(render().route).toEqual({kind: 'draft', source});
  h.account = b;
  expect(render().route).toEqual({kind: 'catalog'});
  expect(JSON.stringify(h.state)).not.toContain('private sentinel');
  h.account = a;
  expect(render().route).toEqual({kind: 'catalog'});
  render().open({kind: 'workspace'});
  h.account = {kind: 'signedOut'};
  expect(render().route).toEqual({kind: 'catalog'});
});
it('retains the public version through login so acquisition resumes on the same immutable version', () => {
  h.account = {kind: 'signedOut'};
  const route = {kind: 'detail' as const, recipe: {recipeId: a.accountId, versionId: b.accountId}};
  render().open(route);
  h.account = a;
  expect(render().route).toEqual(route);
});
it('keeps public search, loaded range and scroll position when closing or switching account context', () => {
  render().setCatalog({query: '用法', search: '用法', result: {hero: null, items: [], nextCursor: a.accountId}, scrollTop: 240});
  render().open(); render().close(); h.account = b;
  expect(render().catalog).toEqual({query: '用法', search: '用法', result: {hero: null, items: [], nextCursor: a.accountId}, scrollTop: 240});
  expect(render().isOpen).toBe(false);
});
