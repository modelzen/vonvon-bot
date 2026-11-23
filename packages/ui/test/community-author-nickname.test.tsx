import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AccountStatus, RecipeSummary} from '@vonvon/protocol';
import {RecipeCard, RecipeOverview} from '../src/community/RecipeContent';

const account = vi.hoisted((): {status: AccountStatus} => ({status: {
  kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: '新账号昵称', provider: 'github', persistence: 'secure',
}}));
vi.mock('../src/account-context', () => ({useAccount: () => account}));
const recipe = {
  recipeId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', revision: 1,
  public: {name: '测试配方', summary: '简介', overview: '', version: '1.0', access: 'direct'},
  creator: {authorId: '11111111-1111-4111-8111-111111111111', displayName: '缓存中的旧昵称'},
} satisfies RecipeSummary;

it('uses the account current nickname for its cached published recipes in every presentation', () => {
  for (const view of [<RecipeCard recipe={recipe} onOpen={() => {}}/>, <RecipeCard recipe={recipe} hero onOpen={() => {}}/>, <RecipeOverview recipe={recipe}/>]) {
    const html = renderToStaticMarkup(view);
    expect(html).toContain('新账号昵称');
    expect(html).not.toContain('缓存中的旧昵称');
  }
});

it('keeps another creator name tied to that creator account ID', () => {
  const other = {...recipe, creator: {authorId: '44444444-4444-4444-8444-444444444444', displayName: '另一位创作者'}};
  expect(renderToStaticMarkup(<RecipeCard recipe={other} onOpen={() => {}}/>)).toContain('另一位创作者');
});
