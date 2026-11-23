// @vitest-environment jsdom
import React, {act, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import type {CommunityShell, RecipeDetail, RecipeSummary} from '@vonvon/protocol';
import {CommunityProvider, useCommunity} from '../src/community/community-context';
import {CommunityPage} from '../src/community/CommunityPage';

const state = vi.hoisted(() => ({owner: 'a', client: {}, device: {id: 'dev'}}));
vi.mock('../src/account-context', () => ({useAccount: () => ({supported: true, status: {kind: 'signedIn', accountId: state.owner}}), accountStatusText: () => ''}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => undefined, useClient: () => state.client, useActiveDevice: () => state.device}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: () => {}, useOptionalDraftGuard: () => undefined, useDraftGuard: () => ({navigate: (action: () => void) => action()})}));
vi.mock('../src/community/RecipeContent', () => ({
  CopyButton: () => null, RecipeMark: () => null, useCreatorName: (creator: {displayName: string} | undefined) => creator?.displayName,
  RecipeCard: ({recipe}: {recipe: RecipeSummary}) => <span>{recipe.public.name}</span>,
  RecipeDetails: ({management}: {management?: ReactNode}) => <div>{management}</div>,
}));
vi.mock('../src/reference/components/ui/Dialog', () => ({Dialog: ({open, children, footer}: {open: boolean; children: ReactNode; footer: ReactNode}) => open ? <div>{children}{footer}</div> : null}));
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
const recipe: RecipeDetail = {
  recipeId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', revision: 1,
  owned: true, acquired: false, format: 'rich-v2', state: 'listed',
  public: {name: '原精选', summary: '', overview: '', version: '1', access: 'free'},
};
function Demo() {
  const community = useCommunity()!;
  return <><button onClick={() => community.open({kind: 'detail', recipe, privateView: true})}>作者详情</button><CommunityPage/></>;
}
it.each([false, true])('refreshes the current account catalog after an unmounted author session withdraws; late old read=%s', async late => {
  state.owner = 'a';
  const pending: Array<() => void> = [];
  let finish!: () => void;
  let committed = false;
  const events: string[] = [];
  const request = vi.fn(async (input: Parameters<CommunityShell['request']>[0]) => {
    events.push(input.type + ':' + ('accountId' in input ? input.accountId : ''));
    switch (input.type) {
      case 'catalog': {
        const result = {hero: committed ? null : recipe, items: []};
        if (late && input.accountId === 'b' && !committed) await new Promise<void>(resolve => pending.push(resolve));
        return result;
      }
      case 'browse': return recipe;
      case 'shareLink': return {url: 'https://community.example/version'};
      case 'withdraw': await new Promise<void>(resolve => {finish = resolve;}); committed = true; return;
      default: return {items: []};
    }
  });
  const shell = {request} as CommunityShell;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = () => root.render(<CommunityProvider shell={shell}><Demo/></CommunityProvider>);
  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find(element => element.textContent === label);
    expect(button, host.innerHTML).toBeTruthy();
    await act(async () => {button!.click();});
  }
  try {
    await act(async () => {draw();});
    await click('作者详情');
    await click('撤下此版本');
    await click('确认撤下');
    await act(async () => {state.owner = 'b'; draw();});
    if (!late) expect(host.textContent).toContain('原精选');
    const before = events.filter(event => event === 'catalog:b').length;
    await act(async () => {finish();});
    await act(async () => {pending.forEach(resolve => resolve());});
    expect(events.filter(event => event === 'catalog:b')).toHaveLength(before + 1);
    expect(host.textContent).toContain('社区正在准备第一份配方');
    expect(host.textContent).not.toContain('原精选');
    expect(events.filter(event => event === 'withdraw:a')).toHaveLength(1);
    expect(events.filter(event => event === 'browse:b')).toHaveLength(0);
    expect(events.filter(event => event === 'browse:a')).toHaveLength(1);
  } finally {
    await act(async () => {root.unmount(); host.remove();});
  }
});
