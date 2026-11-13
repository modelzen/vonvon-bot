// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {communityRequestSchema, type AccountShell, type CommunityRequest, type RecipeDetail} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {CommunityPage} from '../src/community/CommunityPage';
import {useCommunity} from '../src/community/community-context';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, B, devicesState, fakeShell, newClient} from './devices-fixture';

const accountId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
const recipe: RecipeDetail = {recipeId: A, versionId: B, revision: 1, public: {name: '真实配方', summary: '简介', overview: '# 正文', version: '1', access: 'direct'}, owned: false, acquired: false, config: {role: '角色'}};
const summary = {recipeId: recipe.recipeId, versionId: recipe.versionId, revision: recipe.revision, public: recipe.public};
let root: Root;
let calls: CommunityRequest[];
let handle: (request: CommunityRequest) => Promise<unknown>;
const status = {kind: 'signedIn' as const, accountId, displayName: 'Fixture', provider: 'github' as const, persistence: 'memory' as const};
const account: AccountShell = {status: async () => status, onStatus: listener => {listener(status); return () => {};}, login: async () => status, cancelLogin: async () => status, logout: async () => ({kind: 'signedOut'})};
function Host() {
  const community = useCommunity()!;
  return <DraftGuardProvider><button onClick={() => community.open({kind: 'detail', recipe: {recipeId: A, versionId: B}, privateView: true})}>打开已发布版本</button><button onClick={() => community.open({kind: 'draft'})}>打开私人草稿</button><CommunityPage/></DraftGuardProvider>;
}
const client = newClient();
let shell: ReturnType<typeof fakeShell>;
const draw = async (state = devicesState({id: 'local'})) => {
  await act(async () => {root.render(<DesktopRootView state={state} fallback={client} shell={shell} renderApp={() => <Host/>}/>);});
};
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => {button!.click();});
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true}));});
  return input;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!); calls = [];
  handle = async request => {
    if (request.type === 'catalog') return {hero: summary, items: [], nextCursor: null};
    if (request.type === 'detail') return recipe;
    if (request.type === 'shareLink') return {url: 'https://community.example/recipes/' + A + '/versions/' + B};
    if (request.type === 'saveDraft') return {draftId, recipeId: null, revision: 1, public: request.public, config: request.config};
    if (request.type === 'publishDraft') return {...summary, firstCode: 'A'.repeat(32)};
    throw new Error('Unexpected request');
  };
  const community = createDesktopFacades({receive: () => () => {}, invoke: async (channel, raw) => {
    if (channel !== desktopChannels.community) return {ok: true, value: undefined};
    try {const request = communityRequestSchema.parse(raw); calls.push(request); return {ok: true, value: await handle(request)};}
    catch {return {ok: false, error: {kind: 'validation', message: 'strict boundary rejected request'}};}
  }}).shell.community;
  shell = {...fakeShell(), account, community} as typeof shell;
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('opens an actual catalog card through the production facade and strict main request schema', async () => {
  await draw();
  await act(async () => document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(document.querySelector('.community-detail h1')?.textContent).toBe(recipe.public.name);
  expect(calls.filter(request => request.type === 'detail' || request.type === 'shareLink')).toEqual([
    {type: 'detail', accountId, recipeId: A, versionId: B}, {type: 'shareLink', recipeId: A, versionId: B},
  ]);
});
it('uses only immutable IDs when opening a just-published receipt', async () => {
  await draw(); await click('打开私人草稿');
  await fill('配方名称', '发布的名称'); await fill('公开简介', '公开简介');
  await click('预览发布'); await click('发布到社区');
  expect(document.querySelector('.community-detail h1')?.textContent).toBe(recipe.public.name);
  expect(calls.filter(request => request.type === 'detail' || request.type === 'shareLink')).toEqual([
    {type: 'detail', accountId, recipeId: A, versionId: B}, {type: 'shareLink', recipeId: A, versionId: B},
  ]);
});
it('keeps the actual editor DOM, caret, unsaved text and uncertain request key across reconnects and device switches', async () => {
  let attempts = 0;
  const normal = handle;
  handle = async request => {if (request.type === 'saveDraft' && ++attempts === 1) throw new Error('receipt lost'); return normal(request);};
  await draw(); await click('打开私人草稿');
  const input = await fill('配方名称', '保留这份未保存输入');
  await click('保存私人草稿');
  input.focus(); input.setSelectionRange(2, 4);
  for (const state of [devicesState({id: A, phase: 'connecting'}), devicesState({id: A, phase: 'ready'}), devicesState({id: A, phase: 'failed'}), devicesState({id: B, phase: 'ready'}), devicesState({id: 'local'})]) {
    await draw(state);
    const current = document.querySelector<HTMLInputElement>('[aria-label="配方名称"]');
    expect(current).toBe(input); expect(current?.value).toBe('保留这份未保存输入');
    expect(current?.selectionStart).toBe(2); expect(current?.selectionEnd).toBe(4);
  }
  await click('保存私人草稿');
  const saves = calls.filter(request => request.type === 'saveDraft');
  expect(saves).toHaveLength(2); expect(saves[1]).toEqual(saves[0]);
});

it('recovers a lost code-batch receipt using the same key while retaining only still-available plaintext codes', async () => {
  const available = {codeId: draftId, status: 'available' as const, code: 'A'.repeat(32)};
  const redeemed = {codeId: A, status: 'redeemed' as const};
  const disabled = {codeId: B, status: 'disabled' as const};
  let attempts = 0; const normal = handle;
  handle = async request => {
    if (request.type === 'detail') return {...recipe, owned: true, public: {...recipe.public, access: 'coded'}};
    if (request.type === 'codes') return {items: [available, redeemed, disabled].map(item => ({codeId: item.codeId, status: item.status, suffix: 'AAAA', redeemedAt: null})), nextCursor: null};
    if (request.type === 'issueCodes') {if (++attempts === 1) throw new Error('receipt lost'); return {items: [available, redeemed, disabled]};}
    return normal(request);
  };
  await draw(); await click('打开已发布版本');
  await fill('生成分享码数量', '3'); await click('生成分享码');
  expect(document.querySelector<HTMLInputElement>('[aria-label="生成分享码数量"]')?.disabled).toBe(true);
  await click('重试上一批');
  const issues = calls.filter(request => request.type === 'issueCodes');
  expect(issues).toHaveLength(2); expect(issues[1]).toEqual(issues[0]);
  expect(document.querySelector('.community-code-text')?.textContent).toBe(available.code);
  expect(document.querySelector('.community-codes')?.textContent).toContain('已兑换');
  expect(document.querySelector('.community-codes')?.textContent).toContain('已停用');
});

it('preserves valid astral field and search limits all the way through the strict boundary', async () => {
  await draw();
  const query = await fill('搜索配方', '🦉'.repeat(120));
  expect(query.maxLength).toBe(-1);
  await click('搜索');
  expect(calls.filter(request => request.type === 'catalog').at(-1)).toMatchObject({query: '🦉'.repeat(120)});
  await click('打开私人草稿');
  const name = await fill('配方名称', '🦉'.repeat(60));
  await fill('公开简介', '🦉'.repeat(240)); await fill('版本', '🦉'.repeat(40));
  expect(name.maxLength).toBe(-1);
  await click('保存私人草稿');
  expect(calls.filter(request => request.type === 'saveDraft').at(-1)).toMatchObject({public: {name: '🦉'.repeat(60), summary: '🦉'.repeat(240), version: '🦉'.repeat(40)}});
});
