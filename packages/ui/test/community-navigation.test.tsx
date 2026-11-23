// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CommunityRoute} from '../src/community/community-context';
import {CommunityPage} from '../src/community/CommunityPage';

const h = vi.hoisted(() => ({community: undefined as any, acquired: true, requests: [] as string[]}));
vi.mock('../src/community/community-context', () => ({useCommunity: () => h.community}));
vi.mock('../src/account-context', () => ({useAccount: () => ({supported: true, status: {kind: 'signedIn', accountId: '44444444-4444-4444-8444-444444444444'}, login: vi.fn()}), accountStatusText: () => '已登录'}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()})}));
const recipe = {recipeId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222', revision: 1,
  public: {name: '会议纪要', summary: '保留会议决定', overview: '', version: '1.2', access: 'coded' as const}, owned: false, acquired: false};
const shell = {request: async (request: {type: string}) => {
  h.requests.push(request.type);
  if (request.type === 'library') return {items: [recipe], nextCursor: null};
  if (request.type === 'catalog') return {hero: recipe, items: [], nextCursor: null};
  if (request.type === 'detail') return {...recipe, acquired: h.acquired};
  if (request.type === 'shareLink') return {url: 'https://recipes.example/recipes/' + recipe.recipeId + '/versions/' + recipe.versionId};
  throw Error('Unexpected ' + request.type);
}};
function Harness({initial}: {initial: CommunityRoute}) {
  const [route, setRoute] = useState(initial);
  const [catalog, setCatalog] = useState({query: '', search: '', scrollTop: 0});
  h.community = {shell, route, catalog, setCatalog, open: setRoute, isOpen: true};
  return <CommunityPage/>;
}
let root: Root;
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!); h.acquired = true; h.requests = [];
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('keeps the acquired library as the detail back destination', async () => {
  await act(async () => root.render(<Harness initial={{kind: 'library'}}/>));
  const card = document.querySelector<HTMLButtonElement>('.community-card')!;
  expect(card.textContent).not.toContain('需分享码');
  await act(async () => card.click());
  expect(document.querySelector('.community-detail h1')?.textContent).toBe('会议纪要');
  await click('返回已获取');
  expect(document.querySelector('.community-workspace-section h2')?.textContent).toBe('已获取');
});

it('keeps direct details rooted in the catalog and identifies the code target in the dialog', async () => {
  h.acquired = false;
  await act(async () => root.render(<Harness initial={{kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}}}/>));
  expect(document.querySelector('button[aria-label="返回 Bot 配方"]')).not.toBeNull();
  await click('获取配方');
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('会议纪要 · 版本 1.2');
  expect(dialog?.querySelector('input[aria-label="分享码"]')?.getAttribute('placeholder')).toBe('作者提供的分享码');
  expect(h.requests).not.toContain('acquire');
});
