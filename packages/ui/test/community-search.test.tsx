// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CommunityResponses, CommunityShell, RecipeDetail} from '@vonvon/protocol';
import type {CommunityRoute, useCommunity} from '../src/community/community-context';
import {CommunityPage} from '../src/community/CommunityPage';

type Community = NonNullable<ReturnType<typeof useCommunity>>;
const h = vi.hoisted(() => ({community: undefined as Community | undefined, request: vi.fn<CommunityShell['request']>()}));
vi.mock('../src/community/community-context', () => ({useCommunity: () => h.community}));
vi.mock('../src/account-context', () => ({useAccount: () => ({supported: true, status: {kind: 'signedIn', accountId: '44444444-4444-4444-8444-444444444444'}, login: vi.fn()}), accountStatusText: () => '已登录'}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()})}));
vi.mock('../src/community/RecipeDraftPage', () => ({RecipeDraftPage: ({draftId}: {draftId?: string}) => <p>只读配方 {draftId}</p>}));
const recipe: RecipeDetail = {recipeId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222', revision: 1,
  public: {name: '会议纪要', summary: '保留会议决定', overview: '', version: '1.2', access: 'direct'}, owned: false, acquired: false};
const initialCatalog: CommunityResponses['catalog'] = {hero: recipe, items: [], nextCursor: 'next-eight'};
const shell: CommunityShell = {request: h.request};
function Harness({initial = {kind: 'catalog'}, catalogResult = initialCatalog}: {initial?: CommunityRoute; catalogResult?: CommunityResponses['catalog']}) {
  const [route, setRoute] = useState(initial);
  const [catalog, setCatalog] = useState<Community['catalog']>({query: '', search: '', scrollTop: 0, result: catalogResult});
  h.community = {shell, route, catalog, setCatalog, open: next => setRoute(next ?? {kind: 'catalog'}), isOpen: true, close() {}, leave() {}, consumeDeparture() {}};
  return <CommunityPage/>;
}
let root: Root;
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="搜索配方"]')!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function tick() {await act(async () => {await vi.advanceTimersByTimeAsync(250);});}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {callback(0); return 0;});
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="main-content"><div id="root"></div></div>';
  root = createRoot(document.getElementById('root')!);
  h.request.mockReset();
});
afterEach(async () => {await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals();});

it('searches as input settles and clears back to the unfiltered catalog without submitting', async () => {
  h.request.mockResolvedValue({hero: null, items: [recipe], nextCursor: null});
  await act(async () => root.render(<Harness/>));
  expect(document.querySelector('[role="search"] button')).toBeNull();
  await type('会议');
  expect(h.request).not.toHaveBeenCalled();
  await tick();
  expect(h.request).toHaveBeenLastCalledWith(expect.objectContaining({type: 'catalog', query: '会议'}));
  expect(document.querySelector('[role="search"] button')?.textContent).toBe('清除');
  await click('清除搜索');
  expect(h.request).toHaveBeenLastCalledWith(expect.objectContaining({type: 'catalog', query: ''}));
  expect(input().value).toBe('');
  expect(document.activeElement).toBe(input());
  expect(document.querySelector('[role="search"] button')).toBeNull();
});

it('waits for IME composition and ignores a result from the superseded query', async () => {
  let finishOld: (value: CommunityResponses['catalog']) => void = () => {};
  h.request.mockReturnValueOnce(new Promise(resolve => {finishOld = resolve;}));
  h.request.mockResolvedValue({hero: null, items: [{...recipe, public: {...recipe.public, name: '新结果'}}], nextCursor: null});
  await act(async () => root.render(<Harness/>));
  await type('旧查询'); await tick();
  await act(async () => input().dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true})));
  await type('xin'); await tick();
  expect(h.request).toHaveBeenCalledTimes(1);
  await type('新查询');
  await act(async () => input().dispatchEvent(new CompositionEvent('compositionend', {bubbles: true})));
  await tick();
  expect(h.request).toHaveBeenCalledTimes(2);
  await act(async () => finishOld({hero: {...recipe, public: {...recipe.public, name: '过期结果'}}, items: [], nextCursor: null}));
  expect(document.body.textContent).toContain('新结果');
  expect(document.body.textContent).not.toContain('过期结果');
});

it('keeps the loaded search range and scroll when returning from a recipe', async () => {
  const second = {...recipe, versionId: '33333333-3333-4333-8333-333333333333', public: {...recipe.public, name: '第二份配方'}};
  h.request.mockResolvedValueOnce({hero: null, items: [recipe], nextCursor: 'next-eight'});
  await act(async () => root.render(<Harness/>));
  await type('会议'); await tick();
  h.request.mockResolvedValueOnce({hero: null, items: [second], nextCursor: null});
  await click('加载更多');
  expect(document.querySelectorAll('.community-card')).toHaveLength(2);
  document.getElementById('main-content')!.scrollTop = 420;
  h.request.mockResolvedValueOnce(recipe).mockResolvedValueOnce({url: 'https://recipes.example/recipe'});
  await act(async () => document.querySelector<HTMLButtonElement>('.community-card')!.click());
  const requests = h.request.mock.calls.length;
  await click('返回 Bot 配方');
  expect(input().value).toBe('会议');
  expect(document.querySelectorAll('.community-card')).toHaveLength(2);
  expect(document.getElementById('main-content')!.scrollTop).toBe(420);
  expect(h.request).toHaveBeenCalledTimes(requests);
});

it('offers one preparation action and keeps existing drafts accessible without manual creation', async () => {
  const draftId = '55555555-5555-4555-8555-555555555555';
  h.request.mockResolvedValueOnce({items: [{format: 'rich-v2', draftId, recipeId: null, revision: 1, public: recipe.public}]});
  await act(async () => root.render(<Harness initial={{kind: 'workspace', tab: 'drafts'}}/>));
  expect([...document.querySelectorAll('button')].filter(button => button.textContent === '创作配方')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('手动');
  await click('查看配方');
  expect(document.body.textContent).toContain('只读配方 ' + draftId);
});


it('does not append an old load-more response to a new search', async () => {
  let finishPage: (value: CommunityResponses['catalog']) => void = () => {};
  h.request.mockReturnValueOnce(new Promise(resolve => {finishPage = resolve;}));
  h.request.mockResolvedValue({hero: null, items: [{...recipe, public: {...recipe.public, name: '当前搜索结果'}}], nextCursor: null});
  await act(async () => root.render(<Harness/>));
  await click('加载更多');
  await type('当前'); await tick();
  await act(async () => finishPage({hero: null, items: [{...recipe, versionId: '33333333-3333-4333-8333-333333333333', public: {...recipe.public, name: '过期下一页'}}], nextCursor: null}));
  expect(document.body.textContent).toContain('当前搜索结果');
  expect(document.body.textContent).not.toContain('过期下一页');
  expect(document.querySelectorAll('.community-card')).toHaveLength(1);
});

it('keeps the empty studio focused on preparation without a blank-draft shortcut', async () => {
  h.request.mockResolvedValue({items: []});
  await act(async () => root.render(<Harness initial={{kind: 'workspace', tab: 'drafts'}}/>));
  expect(document.body.textContent).toContain('点击「创作配方」，选择 Bot，在私聊中提供资料或整理已有群配置。');
  expect(document.body.textContent).not.toContain('手动');
  expect([...document.querySelectorAll('button')].filter(button => button.textContent === '创作配方')).toHaveLength(1);
  expect(h.request.mock.calls.map(([request]) => request.type)).toEqual(['drafts']);
});

it.each(['featured', 'latest'] as const)('labels committed search results once and restores the %s catalog heading after clearing', async heroKind => {
  const unfiltered = {...initialCatalog, heroKind};
  const title = '发现配方';
  h.request.mockResolvedValueOnce({hero: null, items: [recipe], nextCursor: 'next-eight'}).mockResolvedValueOnce(unfiltered);
  await act(async () => root.render(<Harness catalogResult={unfiltered}/>));
  expect(document.querySelector('.community-section-heading h1')?.textContent).toBe(title);
  await type('会议');
  expect(document.querySelector('.community-section-heading h1')?.textContent).toBe(title);
  await tick();
  expect([...document.querySelectorAll('.community-section-heading h1, .community-catalog-list > h2')].map(heading => heading.textContent)).toEqual(['搜索结果']);
  expect(document.body.textContent).not.toContain('Vonvon 编辑推荐');
  expect(document.querySelectorAll('.community-card')).toHaveLength(1);
  await click('清除搜索');
  expect(document.querySelector('.community-section-heading h1')?.textContent).toBe(title);
});
