import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement} from 'react';
import type {CommunityShell, RecipeDetail} from '@vonvon/protocol';
import {CommunityPage} from '../src/community/CommunityPage';
import {RecipeDetails} from '../src/community/RecipeContent';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ri: 0, ei: 0,
  route: {kind: 'catalog'} as any, catalog: {query: '', search: '', scrollTop: 0} as any, request: vi.fn(), login: vi.fn(), accountId: '11111111-1111-4111-8111-111111111111' as string | undefined,
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useRef: (initial: unknown) => {const i = h.ri++; return h.refs[i] ??= {current: initial};},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});},
}));
vi.mock('../src/community/community-context', () => ({useCommunity: () => ({shell: {request: h.request}, route: h.route, catalog: h.catalog, setCatalog: (next: any) => {h.catalog = typeof next === 'function' ? next(h.catalog) : next;}, open: (next: any) => {h.route = next;}})}));
vi.mock('../src/account-context', () => ({useAccount: () => ({supported: true, status: h.accountId ? {kind: 'signedIn', accountId: h.accountId} : {kind: 'signedOut'}, login: h.login}), accountStatusText: () => '登录'}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: () => {}, useDraftGuard: () => ({navigate: (action: () => void) => action()})}));
const recipe: RecipeDetail = {recipeId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', revision: 1,
  public: {name: '助手', summary: '公开简介', overview: '公开概览', version: '1', access: 'coded'}, owned: false, acquired: false};
type Element = ReactElement<Record<string, any>>;
function nodes(node: unknown): Element[] {return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, any>>(node) ? [node, ...Object.values(node.props).flatMap(nodes)] : [];}
function render() {
  h.si = h.ri = h.ei = 0;
  const page = CommunityPage() as Element;
  const Component = page.type as (props: {shell: CommunityShell; accountId?: string}) => unknown;
  const result = Component({shell, accountId: h.accountId});
  for (const effect of h.pending.splice(0)) effect();
  return nodes(result);
}
const shell = {request: (request: unknown) => h.request(request)} as CommunityShell;
const flush = async () => {for (let i = 0; i < 15; i++) await Promise.resolve();};
beforeEach(() => {
  h.state = []; h.refs = []; h.effects = []; h.pending = []; h.accountId = '11111111-1111-4111-8111-111111111111';
  h.route = {kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}};
  h.catalog = {query: '', search: '', scrollTop: 0}; h.request.mockReset(); h.login.mockReset().mockResolvedValue(undefined);
  h.request.mockImplementation(async request => request.type === 'detail' ? recipe : request.type === 'shareLink' ? {url: 'https://community.example/version'} : {});
});
it('retries an uncertain code acquisition with one request key and reports account acquisition separately from installation', async () => {
  let attempts = 0; let acquired = false;
  h.request.mockImplementation(async request => {
    if (request.type === 'detail') return {...recipe, acquired, ...(acquired ? {config: {role: 'role'}} : {})};
    if (request.type === 'shareLink') return {url: 'https://community.example/version'};
    if (request.type === 'acquire') {if (++attempts === 1) throw new Error('暂时离线'); acquired = true; return {ok: true, value: {recipeId: recipe.recipeId, versionId: recipe.versionId, owned: false, acquired: true}};}
    return {};
  });
  render(); await flush();
  let all = render();
  const input = all.find(node => node.props['aria-label'] === '分享码')!;
  input.props.onChange({target: {value: 'ABCD-1234'}});
  all = render(); all.find(node => node.type === RecipeDetails)!.props.action.props.onClick(); await flush();
  all = render(); expect(all.some(node => node.props.children === '暂时离线')).toBe(true);
  all.find(node => node.type === RecipeDetails)!.props.action.props.onClick(); await flush();
  all = render();
  const requests = h.request.mock.calls.map(([request]) => request).filter(request => request.type === 'acquire');
  expect(requests).toHaveLength(2); expect(requests[0].requestId).toBe(requests[1].requestId);
  expect(requests[0]).toMatchObject({accountId: h.accountId, versionId: recipe.versionId, code: 'ABCD-1234'});
  const details = all.find(node => node.type === RecipeDetails)!;
  expect(details.props.action.props.children).toBe('添加到群聊'); expect(details.props.action.props.disabled).toBe(true);
  expect(all.some(node => typeof node.props.children === 'string' && node.props.children.includes('已获取，已保存在你的账号中'))).toBe(true);
  expect(all.some(node => node.props.children === '已安装')).toBe(false);
});
it('opens login without sending an acquisition while signed out and retains the immutable public route', async () => {
  h.accountId = undefined; render(); await flush(); const all = render();
  all.find(node => node.type === RecipeDetails)!.props.action.props.onClick(); await flush();
  expect(h.login).toHaveBeenCalledOnce();
  expect(h.request.mock.calls.map(([request]) => request.type)).not.toContain('acquire');
  expect(h.route.recipe.versionId).toBe(recipe.versionId);
});
it('does not use a late acquisition receipt to replace the page after navigating away', async () => {
  let finish!: (value: unknown) => void;
  h.request.mockImplementation(async request => request.type === 'detail' ? recipe : request.type === 'shareLink' ? {url: 'https://community.example/version'} : request.type === 'acquire' ? new Promise(resolve => {finish = resolve;}) : {hero: null, items: [], nextCursor: null});
  render(); await flush(); let all = render();
  all.find(node => node.props['aria-label'] === '分享码')!.props.onChange({target: {value: 'CODE'}});
  all = render(); all.find(node => node.type === RecipeDetails)!.props.action.props.onClick();
  h.route = {kind: 'catalog'}; render(); await flush();
  finish({acquired: true}); await flush(); all = render();
  expect(all.some(node => node.type === RecipeDetails)).toBe(false);
  expect(all.some(node => typeof node.props.children === 'string' && node.props.children.includes('已获取，已保存在你的账号中'))).toBe(false);
});
