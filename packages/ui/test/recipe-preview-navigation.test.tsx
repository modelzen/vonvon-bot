// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {AccountStatus, DraftPreviewNavigation, RecipePreviewShell} from '@vonvon/protocol';
import {CommunityProvider, useCommunity} from '../src/community/community-context';
import {DraftGuardProvider, useDraft} from '../src/settings/DraftGuard';

const state = vi.hoisted(() => ({account: {kind: 'signedOut'} as AccountStatus, preview: undefined as RecipePreviewShell | undefined}));
vi.mock('../src/account-context', () => ({useAccount: () => ({status: state.account})}));
vi.mock('../src/client-context', () => {
  const client = {};
  return {useClient: () => client, useActiveDevice: () => ({id: 'local'}), useShellCapabilities: () => ({recipePreview: state.preview})};
});
const accountId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const navigation: DraftPreviewNavigation = {draftId, revision: 2, navigationId: '33333333-3333-4333-8333-333333333333'};
let root: Root;
let current: NonNullable<ReturnType<typeof useCommunity>>;
let emit: (value: DraftPreviewNavigation) => void;
let acknowledge: ReturnType<typeof vi.fn>;
let pending: () => Promise<DraftPreviewNavigation[]>;
function Probe() {current = useCommunity()!; return <div>{JSON.stringify({open: current.isOpen, route: current.route})}</div>;}
function DirtyProbe() {
  const [dirty, setDirty] = useState(false);
  useDraft(dirty, {title: '本地配置', discard: () => setDirty(false)});
  return <><button onClick={() => setDirty(true)}>修改本地设置</button><p>{dirty ? '本地修改仍在' : '尚未修改'}</p><Probe/></>;
}
async function render() {await act(async () => root.render(<CommunityProvider><Probe/></CommunityProvider>));}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.account = {kind: 'signedOut'};
  acknowledge = vi.fn(async () => {});
  pending = async () => [navigation];
  state.preview = {pending: () => pending(), acknowledge, onOpen: listener => {emit = listener; return () => {};}};
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('keeps the exact incoming draft through login and clears private navigation on account change', async () => {
  await render();
  expect(current.isOpen).toBe(true);
  expect(current.route).toEqual({kind: 'draft', draftId, expectedRevision: 2, navigationId: navigation.navigationId});
  expect(acknowledge).not.toHaveBeenCalled();
  state.account = {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'};
  await render();
  expect(current.route).toEqual({kind: 'draft', draftId, expectedRevision: 2, navigationId: navigation.navigationId});
  expect(acknowledge).toHaveBeenCalledWith(navigation.navigationId);
  state.account = {...state.account, accountId: draftId};
  await render();
  expect(current.route).toEqual({kind: 'catalog'});
});

it('lets a newer live navigation win over a delayed startup queue', async () => {
  let release!: (value: DraftPreviewNavigation[]) => void;
  pending = () => new Promise(resolve => {release = resolve;});
  await render();
  const latest = {...navigation, draftId: accountId, revision: 4, navigationId: '44444444-4444-4444-8444-444444444444'};
  await act(async () => emit(latest));
  await act(async () => release([navigation]));
  expect(current.route).toEqual({kind: 'draft', draftId: accountId, expectedRevision: 4, navigationId: latest.navigationId});
  expect(acknowledge).toHaveBeenCalledWith(navigation.navigationId);
  expect(acknowledge).not.toHaveBeenCalledWith(latest.navigationId);
});

it('acknowledges an abandoned signed-out preview when the user returns to the catalog', async () => {
  await render();
  await act(async () => current.open({kind: 'catalog'}));
  expect(acknowledge).toHaveBeenCalledWith(navigation.navigationId);
  state.account = {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'};
  await render();
  expect(current.route).toEqual({kind: 'catalog'});
});

it('protects local edits and permits another click of the same preview after declining navigation', async () => {
  pending = async () => [];
  await act(async () => root.render(<DraftGuardProvider><CommunityProvider><DirtyProbe/></CommunityProvider></DraftGuardProvider>));
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  await click('修改本地设置');
  await act(async () => emit(navigation));
  expect(current.isOpen).toBe(false);
  expect(document.body.textContent).toContain('有未保存的修改');
  expect(document.body.textContent).toContain('本地修改仍在');
  expect(acknowledge).not.toHaveBeenCalled();
  await click('继续编辑');
  expect(acknowledge).toHaveBeenCalledWith(navigation.navigationId);
  const next = {...navigation, navigationId: '55555555-5555-4555-8555-555555555555'};
  await act(async () => emit(next));
  expect(document.body.textContent).toContain('有未保存的修改');
  await click('放弃并离开');
  expect(current.isOpen).toBe(true);
  expect(current.route).toEqual({kind: 'draft', draftId, expectedRevision: 2, navigationId: next.navigationId});
});

it('treats a fresh click of an already opened locator as a fresh reader navigation', async () => {
  state.account = {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'};
  await render();
  const first = current.route;
  const next = {...navigation, navigationId: '55555555-5555-4555-8555-555555555555'};
  await act(async () => emit(next));
  expect(current.route).not.toEqual(first);
  expect(current.route).toEqual({kind: 'draft', draftId, expectedRevision: 2, navigationId: next.navigationId});
});

it('cancels an account-bound preview when the account changes before the edit guard releases it',async()=>{
  pending=async()=>[];
  state.account={kind:'signedIn',accountId,displayName:'作者',provider:'github',persistence:'memory'};
  const page=()=>root.render(<DraftGuardProvider><CommunityProvider><DirtyProbe/></CommunityProvider></DraftGuardProvider>);
  await act(async()=>page());
  const click=async(label:string)=>act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent===label)!.click());
  await click('修改本地设置');
  await act(async()=>emit({...navigation,accountId}));
  expect(current.isOpen).toBe(false);
  state.account={...state.account,accountId:draftId};
  await act(async()=>page());
  await click('放弃并离开');
  expect(current.isOpen).toBe(false);expect(current.route).toEqual({kind:'catalog'});
  expect(acknowledge).not.toHaveBeenCalled();
});
